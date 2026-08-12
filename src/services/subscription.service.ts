import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { AppError } from '../utils/AppError';
import {
  TRIAL_DAYS,
  ACTIVE_STATUSES,
  isEnforced,
  tierForProduct,
  planForProduct,
  limitsForState,
  type Tier,
  type Plan,
  type SubStatus,
  type TierLimits,
} from '../config/subscription';
import type { JWSTransactionDecodedPayload } from '@apple/app-store-server-library';
import type { GoogleSubInfo } from './googleplay.service';

export interface Entitlement {
  state: SubStatus;
  tier: Tier | null;
  /** Billing period the couple is on (null during trial / when inactive). */
  plan: Plan | null;
  active: boolean;
  limits: TierLimits | null;
  trialUsed: boolean;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  /** Whether the app should actually enforce gating (master switch). */
  enforced: boolean;
}

const INFINITY_SENTINEL = 1_000_000; // JSON-safe stand-in for "unlimited"

const jsonLimits = (l: TierLimits): TierLimits => ({
  ...l,
  groups: l.groups === Number.POSITIVE_INFINITY ? INFINITY_SENTINEL : l.groups,
  connections: l.connections === Number.POSITIVE_INFINITY ? INFINITY_SENTINEL : l.connections,
});

/**
 * Resolve the couple's live entitlement, downgrading TRIALING/ACTIVE to EXPIRED
 * when the trial/period end date has passed (the webhook keeps this fresh, but
 * this guards the read path too).
 */
export const getEntitlement = async (coupleId: string): Promise<Entitlement> => {
  const sub = await prisma.subscription.findUnique({ where: { coupleId } });
  const enforced = isEnforced();

  if (!sub) {
    return {
      state: 'NONE',
      tier: null,
      plan: null,
      active: false,
      limits: null,
      trialUsed: false,
      trialEndsAt: null,
      currentPeriodEnd: null,
      enforced,
    };
  }

  const now = Date.now();
  let state = sub.status as SubStatus;

  if (state === 'TRIALING' && sub.trialEndsAt && sub.trialEndsAt.getTime() <= now) {
    state = 'EXPIRED';
  }
  if ((state === 'ACTIVE' || state === 'GRACE') && sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() <= now) {
    state = 'EXPIRED';
  }

  const active = ACTIVE_STATUSES.includes(state);
  const tier: Tier | null = active ? 'PRIME' : null;
  // Trial has reduced limits (5/5/no-create); paid Prime is unlimited + create.
  const limits = limitsForState(state);
  // Plan only applies to a paid subscription (null during the trial).
  const plan = state === 'ACTIVE' || state === 'GRACE' ? planForProduct(sub.productId) : null;

  return {
    state,
    tier,
    plan,
    active,
    limits: limits ? jsonLimits(limits) : null,
    trialUsed: sub.trialUsed,
    trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
    currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    enforced,
  };
};

/** How many Discovery profiles the couple has acted on all-time (skip + connect). */
export const connectionsUsed = (coupleId: string): Promise<number> =>
  prisma.match.count({ where: { actionById: coupleId } });

/**
 * How many Discovery profiles the couple has acted on SINCE THE START OF TODAY
 * (UTC). This is the value the connection quota is enforced against — the free
 * tier and trial both allow 5 connections PER DAY, not 5 lifetime.
 */
export const connectionsUsedToday = (coupleId: string): Promise<number> => {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  return prisma.match.count({
    where: { actionById: coupleId, createdAt: { gte: startOfDay } },
  });
};

/** How many groups the couple has joined. */
export const groupsJoined = (coupleId: string): Promise<number> =>
  prisma.communityMember.count({ where: { coupleId } });

/**
 * Start the one-time 7-day PRIME free trial for a couple.
 * Returns { ok:false, reason } if the trial was already used.
 */
export const startTrial = async (
  coupleId: string,
): Promise<{ ok: true; entitlement: Entitlement } | { ok: false; reason: string }> => {
  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

  // Re-check + write inside one interactive transaction so two simultaneous
  // "start trial" taps can't each grant a fresh trial window (check-then-write
  // race). The unique coupleId still guarantees a single row.
  const outcome = await prisma.$transaction(async (tx) => {
    const existing = await tx.subscription.findUnique({ where: { coupleId } });
    if (existing?.trialUsed) {
      return { ok: false as const, reason: 'TRIAL_ALREADY_USED' };
    }
    if (existing && ACTIVE_STATUSES.includes(existing.status as SubStatus)) {
      return { ok: false as const, reason: 'ALREADY_SUBSCRIBED' };
    }
    await tx.subscription.upsert({
      where: { coupleId },
      create: {
        coupleId,
        tier: 'PRIME',
        status: 'TRIALING',
        trialUsed: true,
        trialStartedAt: now,
        trialEndsAt,
      },
      update: {
        tier: 'PRIME',
        status: 'TRIALING',
        trialUsed: true,
        trialStartedAt: now,
        trialEndsAt,
      },
    });
    return { ok: true as const };
  });

  if (!outcome.ok) {
    return { ok: false, reason: outcome.reason };
  }

  logger.info(`[Sub] Trial started for couple ${coupleId} (ends ${trialEndsAt.toISOString()})`);
  return { ok: true, entitlement: await getEntitlement(coupleId) };
};

/**
 * Apply a verified Apple transaction to a couple's entitlement.
 * Used by both the client verify endpoint and the webhook.
 */
export const applyAppleTransaction = async (
  coupleId: string,
  tx: JWSTransactionDecodedPayload,
  opts?: { autoRenew?: boolean },
): Promise<Entitlement> => {
  const tier = tierForProduct(tx.productId) ?? 'PRIME';
  const expiresMs = tx.expiresDate ?? 0;
  const status: SubStatus = expiresMs > Date.now() ? 'ACTIVE' : 'EXPIRED';
  const currentPeriodEnd = expiresMs ? new Date(expiresMs) : null;

  await prisma.subscription.upsert({
    where: { coupleId },
    create: {
      coupleId,
      tier,
      status,
      platform: 'ios',
      productId: tx.productId ?? null,
      originalTransactionId: tx.originalTransactionId ?? null,
      currentPeriodEnd,
      environment: tx.environment ?? null,
      autoRenew: opts?.autoRenew ?? true,
      // Buying counts as having consumed the trial opportunity.
      trialUsed: true,
    },
    update: {
      tier,
      status,
      platform: 'ios',
      productId: tx.productId ?? null,
      originalTransactionId: tx.originalTransactionId ?? null,
      currentPeriodEnd,
      environment: tx.environment ?? null,
      ...(opts?.autoRenew !== undefined ? { autoRenew: opts.autoRenew } : {}),
      trialUsed: true,
    },
  });

  logger.info(`[Sub] Apple tx applied — couple ${coupleId}, tier ${tier}, status ${status}, ends ${currentPeriodEnd?.toISOString() ?? 'n/a'}`);
  return getEntitlement(coupleId);
};

/**
 * Apply a transaction that arrived via webhook. We don't get our coupleId from
 * Apple, so we locate the couple by originalTransactionId (set on first verify).
 */
export const applyAppleTransactionByOriginalId = async (
  tx: JWSTransactionDecodedPayload,
  opts?: { autoRenew?: boolean; forceStatus?: SubStatus },
): Promise<void> => {
  const originalTransactionId = tx.originalTransactionId;
  if (!originalTransactionId) return;

  const existing = await prisma.subscription.findFirst({ where: { originalTransactionId } });
  if (!existing) {
    logger.warn(`[Sub] Webhook tx for unknown originalTransactionId ${originalTransactionId} — ignoring.`);
    return;
  }

  const tier = tierForProduct(tx.productId) ?? (existing.tier as Tier);
  const expiresMs = tx.expiresDate ?? 0;
  const status: SubStatus =
    opts?.forceStatus ?? (expiresMs > Date.now() ? 'ACTIVE' : 'EXPIRED');

  await prisma.subscription.update({
    where: { id: existing.id },
    data: {
      tier,
      status,
      productId: tx.productId ?? existing.productId,
      currentPeriodEnd: expiresMs ? new Date(expiresMs) : existing.currentPeriodEnd,
      environment: tx.environment ?? existing.environment,
      ...(opts?.autoRenew !== undefined ? { autoRenew: opts.autoRenew } : {}),
    },
  });
  logger.info(`[Sub] Webhook applied — couple ${existing.coupleId}, tier ${tier}, status ${status}`);
};

// ─── Google Play ─────────────────────────────────────────────────────────────

/** Map a Google subscription state + expiry → our internal status. */
const googleStatus = (info: GoogleSubInfo): SubStatus => {
  const alive = info.expiryMs > Date.now();
  switch (info.state) {
    case 'ACTIVE':
      return 'ACTIVE';
    case 'GRACE':
      return 'GRACE';
    case 'CANCELED':
      // Auto-renew turned off but access continues until the period ends.
      return alive ? 'ACTIVE' : 'EXPIRED';
    case 'ON_HOLD':
    case 'PAUSED':
    case 'EXPIRED':
      return 'EXPIRED';
    case 'PENDING':
    case 'UNKNOWN':
    default:
      // Never grant on a pending/unknown state.
      return 'EXPIRED';
  }
};

/** Whether a Google state should be persisted as an entitlement change at all. */
export const isGooglePendingOrUnknown = (info: GoogleSubInfo): boolean =>
  info.state === 'PENDING' || info.state === 'UNKNOWN';

/** Apply a verified Google purchase to a couple's entitlement (client verify path). */
export const applyGooglePurchase = async (
  coupleId: string,
  purchaseToken: string,
  info: GoogleSubInfo,
): Promise<Entitlement> => {
  const tier = tierForProduct(info.productId) ?? 'PRIME';
  const status = googleStatus(info);
  const currentPeriodEnd = info.expiryMs ? new Date(info.expiryMs) : null;

  // Receipt-reuse guard: a Google purchaseToken must entitle only ONE couple.
  // Reject if this token is already linked to a different couple (backed by the
  // unique index on subscriptions.purchaseToken as a hard constraint).
  const claimed = await prisma.subscription.findFirst({
    where: { purchaseToken },
    select: { coupleId: true },
  });
  if (claimed && claimed.coupleId !== coupleId) {
    logger.warn(`[Sub] Rejected Google purchaseToken reuse — already linked to ${claimed.coupleId}`);
    throw new AppError('This purchase is already linked to another account.', 409, 'PURCHASE_ALREADY_CLAIMED');
  }

  await prisma.subscription.upsert({
    where: { coupleId },
    create: {
      coupleId,
      tier,
      status,
      platform: 'android',
      productId: info.productId ?? null,
      purchaseToken,
      currentPeriodEnd,
      autoRenew: info.autoRenew,
      environment: 'Production',
      trialUsed: true,
    },
    update: {
      tier,
      status,
      platform: 'android',
      productId: info.productId ?? null,
      purchaseToken,
      currentPeriodEnd,
      autoRenew: info.autoRenew,
      trialUsed: true,
    },
  });

  logger.info(`[Sub] Google purchase applied — couple ${coupleId}, tier ${tier}, status ${status}, ends ${currentPeriodEnd?.toISOString() ?? 'n/a'}`);
  return getEntitlement(coupleId);
};

/**
 * Apply a Google purchase update from the RTDN webhook. We locate the couple by
 * the current purchaseToken or its linkedPurchaseToken (set on upgrade/resub).
 */
export const applyGooglePurchaseByToken = async (
  purchaseToken: string,
  info: GoogleSubInfo,
): Promise<void> => {
  const orTokens: Array<{ purchaseToken: string }> = [{ purchaseToken }];
  if (info.linkedPurchaseToken) orTokens.push({ purchaseToken: info.linkedPurchaseToken });

  const existing = await prisma.subscription.findFirst({ where: { OR: orTokens } });
  if (!existing) {
    logger.warn(`[Sub] Google webhook for unknown purchaseToken — ignoring.`);
    return;
  }

  const tier = tierForProduct(info.productId) ?? (existing.tier as Tier);
  const status = googleStatus(info);

  await prisma.subscription.update({
    where: { id: existing.id },
    data: {
      tier,
      status,
      platform: 'android',
      productId: info.productId ?? existing.productId,
      purchaseToken, // migrate to the latest token on upgrade/resub
      currentPeriodEnd: info.expiryMs ? new Date(info.expiryMs) : existing.currentPeriodEnd,
      autoRenew: info.autoRenew,
    },
  });
  logger.info(`[Sub] Google webhook applied — couple ${existing.coupleId}, tier ${tier}, status ${status}`);
};

/** Force-expire a subscription by purchase token (refund / chargeback fallback). */
export const expireGoogleToken = async (purchaseToken: string): Promise<void> => {
  const existing = await prisma.subscription.findFirst({ where: { purchaseToken } });
  if (!existing) return;
  await prisma.subscription.update({
    where: { id: existing.id },
    data: { status: 'CANCELLED', autoRenew: false },
  });
  logger.info(`[Sub] Google purchase voided — couple ${existing.coupleId} set CANCELLED`);
};
