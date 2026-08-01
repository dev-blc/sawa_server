"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.expireGoogleToken = exports.applyGooglePurchaseByToken = exports.applyGooglePurchase = exports.isGooglePendingOrUnknown = exports.applyAppleTransactionByOriginalId = exports.applyAppleTransaction = exports.startTrial = exports.groupsJoined = exports.connectionsUsed = exports.getEntitlement = void 0;
const prisma_1 = require("../lib/prisma");
const logger_1 = require("../utils/logger");
const subscription_1 = require("../config/subscription");
const INFINITY_SENTINEL = 1000000; // JSON-safe stand-in for "unlimited"
const jsonLimits = (l) => ({
    ...l,
    groups: l.groups === Number.POSITIVE_INFINITY ? INFINITY_SENTINEL : l.groups,
    connections: l.connections === Number.POSITIVE_INFINITY ? INFINITY_SENTINEL : l.connections,
});
/**
 * Resolve the couple's live entitlement, downgrading TRIALING/ACTIVE to EXPIRED
 * when the trial/period end date has passed (the webhook keeps this fresh, but
 * this guards the read path too).
 */
const getEntitlement = async (coupleId) => {
    const sub = await prisma_1.prisma.subscription.findUnique({ where: { coupleId } });
    const enforced = (0, subscription_1.isEnforced)();
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
    let state = sub.status;
    if (state === 'TRIALING' && sub.trialEndsAt && sub.trialEndsAt.getTime() <= now) {
        state = 'EXPIRED';
    }
    if ((state === 'ACTIVE' || state === 'GRACE') && sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() <= now) {
        state = 'EXPIRED';
    }
    const active = subscription_1.ACTIVE_STATUSES.includes(state);
    const tier = active ? 'PRIME' : null;
    // Trial has reduced limits (5/5/no-create); paid Prime is unlimited + create.
    const limits = (0, subscription_1.limitsForState)(state);
    // Plan only applies to a paid subscription (null during the trial).
    const plan = state === 'ACTIVE' || state === 'GRACE' ? (0, subscription_1.planForProduct)(sub.productId) : null;
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
exports.getEntitlement = getEntitlement;
/** How many Discovery profiles the couple has acted on (skip + connect both count). */
const connectionsUsed = (coupleId) => prisma_1.prisma.match.count({ where: { actionById: coupleId } });
exports.connectionsUsed = connectionsUsed;
/** How many groups the couple has joined. */
const groupsJoined = (coupleId) => prisma_1.prisma.communityMember.count({ where: { coupleId } });
exports.groupsJoined = groupsJoined;
/**
 * Start the one-time 7-day PRIME free trial for a couple.
 * Returns { ok:false, reason } if the trial was already used.
 */
const startTrial = async (coupleId) => {
    const existing = await prisma_1.prisma.subscription.findUnique({ where: { coupleId } });
    if (existing?.trialUsed) {
        return { ok: false, reason: 'TRIAL_ALREADY_USED' };
    }
    if (existing && subscription_1.ACTIVE_STATUSES.includes(existing.status)) {
        return { ok: false, reason: 'ALREADY_SUBSCRIBED' };
    }
    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + subscription_1.TRIAL_DAYS * 24 * 60 * 60 * 1000);
    await prisma_1.prisma.subscription.upsert({
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
    logger_1.logger.info(`[Sub] Trial started for couple ${coupleId} (ends ${trialEndsAt.toISOString()})`);
    return { ok: true, entitlement: await (0, exports.getEntitlement)(coupleId) };
};
exports.startTrial = startTrial;
/**
 * Apply a verified Apple transaction to a couple's entitlement.
 * Used by both the client verify endpoint and the webhook.
 */
const applyAppleTransaction = async (coupleId, tx, opts) => {
    const tier = (0, subscription_1.tierForProduct)(tx.productId) ?? 'PRIME';
    const expiresMs = tx.expiresDate ?? 0;
    const status = expiresMs > Date.now() ? 'ACTIVE' : 'EXPIRED';
    const currentPeriodEnd = expiresMs ? new Date(expiresMs) : null;
    await prisma_1.prisma.subscription.upsert({
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
    logger_1.logger.info(`[Sub] Apple tx applied — couple ${coupleId}, tier ${tier}, status ${status}, ends ${currentPeriodEnd?.toISOString() ?? 'n/a'}`);
    return (0, exports.getEntitlement)(coupleId);
};
exports.applyAppleTransaction = applyAppleTransaction;
/**
 * Apply a transaction that arrived via webhook. We don't get our coupleId from
 * Apple, so we locate the couple by originalTransactionId (set on first verify).
 */
const applyAppleTransactionByOriginalId = async (tx, opts) => {
    const originalTransactionId = tx.originalTransactionId;
    if (!originalTransactionId)
        return;
    const existing = await prisma_1.prisma.subscription.findFirst({ where: { originalTransactionId } });
    if (!existing) {
        logger_1.logger.warn(`[Sub] Webhook tx for unknown originalTransactionId ${originalTransactionId} — ignoring.`);
        return;
    }
    const tier = (0, subscription_1.tierForProduct)(tx.productId) ?? existing.tier;
    const expiresMs = tx.expiresDate ?? 0;
    const status = opts?.forceStatus ?? (expiresMs > Date.now() ? 'ACTIVE' : 'EXPIRED');
    await prisma_1.prisma.subscription.update({
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
    logger_1.logger.info(`[Sub] Webhook applied — couple ${existing.coupleId}, tier ${tier}, status ${status}`);
};
exports.applyAppleTransactionByOriginalId = applyAppleTransactionByOriginalId;
// ─── Google Play ─────────────────────────────────────────────────────────────
/** Map a Google subscription state + expiry → our internal status. */
const googleStatus = (info) => {
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
const isGooglePendingOrUnknown = (info) => info.state === 'PENDING' || info.state === 'UNKNOWN';
exports.isGooglePendingOrUnknown = isGooglePendingOrUnknown;
/** Apply a verified Google purchase to a couple's entitlement (client verify path). */
const applyGooglePurchase = async (coupleId, purchaseToken, info) => {
    const tier = (0, subscription_1.tierForProduct)(info.productId) ?? 'PRIME';
    const status = googleStatus(info);
    const currentPeriodEnd = info.expiryMs ? new Date(info.expiryMs) : null;
    await prisma_1.prisma.subscription.upsert({
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
    logger_1.logger.info(`[Sub] Google purchase applied — couple ${coupleId}, tier ${tier}, status ${status}, ends ${currentPeriodEnd?.toISOString() ?? 'n/a'}`);
    return (0, exports.getEntitlement)(coupleId);
};
exports.applyGooglePurchase = applyGooglePurchase;
/**
 * Apply a Google purchase update from the RTDN webhook. We locate the couple by
 * the current purchaseToken or its linkedPurchaseToken (set on upgrade/resub).
 */
const applyGooglePurchaseByToken = async (purchaseToken, info) => {
    const orTokens = [{ purchaseToken }];
    if (info.linkedPurchaseToken)
        orTokens.push({ purchaseToken: info.linkedPurchaseToken });
    const existing = await prisma_1.prisma.subscription.findFirst({ where: { OR: orTokens } });
    if (!existing) {
        logger_1.logger.warn(`[Sub] Google webhook for unknown purchaseToken — ignoring.`);
        return;
    }
    const tier = (0, subscription_1.tierForProduct)(info.productId) ?? existing.tier;
    const status = googleStatus(info);
    await prisma_1.prisma.subscription.update({
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
    logger_1.logger.info(`[Sub] Google webhook applied — couple ${existing.coupleId}, tier ${tier}, status ${status}`);
};
exports.applyGooglePurchaseByToken = applyGooglePurchaseByToken;
/** Force-expire a subscription by purchase token (refund / chargeback fallback). */
const expireGoogleToken = async (purchaseToken) => {
    const existing = await prisma_1.prisma.subscription.findFirst({ where: { purchaseToken } });
    if (!existing)
        return;
    await prisma_1.prisma.subscription.update({
        where: { id: existing.id },
        data: { status: 'CANCELLED', autoRenew: false },
    });
    logger_1.logger.info(`[Sub] Google purchase voided — couple ${existing.coupleId} set CANCELLED`);
};
exports.expireGoogleToken = expireGoogleToken;
//# sourceMappingURL=subscription.service.js.map