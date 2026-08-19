import { Request, Response } from 'express';
import { NotificationTypeV2, Subtype } from '@apple/app-store-server-library';
import { logger } from '../utils/logger';
import {
  getEntitlement,
  startTrial,
  connectionsUsedToday,
  groupsJoined,
  applyAppleTransaction,
  applyAppleTransactionByOriginalId,
  applyGooglePurchase,
  applyGooglePurchaseByToken,
  isGooglePendingOrUnknown,
  expireGoogleToken,
} from '../services/subscription.service';
import {
  verifyTransactionById,
  decodeNotification,
  decodeSignedTransaction,
  isAppleConfigured,
} from '../services/appstore.service';
import {
  getSubscriptionV2,
  acknowledgeSubscription,
  isGoogleConfigured,
} from '../services/googleplay.service';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { tierForProduct, type SubStatus } from '../config/subscription';
import { sendSuccess, sendError } from '../utils/response';
import { timingSafeEqualStr } from '../utils/timingSafeEqual';

/**
 * Envelope convention for this controller (migrated from hand-rolled shapes):
 * machine codes ('APPLE_NOT_CONFIGURED', 'TRIAL_ALREADY_USED', …) live in
 * `code`; `error` carries human-readable copy. Status codes are unchanged.
 * The store webhooks only ever read the HTTP status, and the current app
 * ships with the IAP surface removed, so nothing consumes these bodies today.
 */

/** Human copy for startTrial()'s machine reason codes. */
const TRIAL_REASON_MESSAGES: Record<string, string> = {
  TRIAL_ALREADY_USED: 'Your free trial has already been used',
  ALREADY_SUBSCRIBED: 'You already have an active subscription',
};

const missingCoupleContext = (res: Response): void =>
  sendError({ res, error: 'Missing couple context', statusCode: 400, code: 'MISSING_COUPLE_CONTEXT' });

/** GET /api/v1/subscriptions/me — current entitlement + usage counts. */
export const getMySubscription = async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  if (!coupleId) {
    missingCoupleContext(res);
    return;
  }
  const [entitlement, connections, groups] = await Promise.all([
    getEntitlement(coupleId),
    connectionsUsedToday(coupleId),
    groupsJoined(coupleId),
  ]);
  sendSuccess({ res, data: { ...entitlement, usage: { connections, groups } } });
};

/** POST /api/v1/subscriptions/trial — start the one-time 7-day PRIME trial. */
export const startTrialHandler = async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  if (!coupleId) {
    missingCoupleContext(res);
    return;
  }
  const result = await startTrial(coupleId);
  if (!result.ok) {
    sendError({
      res,
      error: TRIAL_REASON_MESSAGES[result.reason] ?? 'The trial could not be started right now',
      statusCode: 409,
      code: result.reason,
    });
    return;
  }
  sendSuccess({ res, data: result.entitlement });
};

/**
 * POST /api/v1/subscriptions/apple/verify
 * Body: { transactionId }
 * The app calls this right after a successful StoreKit purchase/restore. We ask
 * Apple for the authoritative signed transaction, verify it, and set entitlement.
 */
export const verifyApple = async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  if (!coupleId) {
    missingCoupleContext(res);
    return;
  }
  if (!isAppleConfigured()) {
    sendError({
      res,
      error: 'Apple purchases are not available right now',
      statusCode: 503,
      code: 'APPLE_NOT_CONFIGURED',
    });
    return;
  }
  const { transactionId } = (req.body ?? {}) as { transactionId?: string };
  if (!transactionId) {
    sendError({ res, error: 'transactionId is required', statusCode: 400, code: 'TRANSACTION_ID_REQUIRED' });
    return;
  }

  const tx = await verifyTransactionById(transactionId);
  if (!tx) {
    sendError({
      res,
      error: 'We could not verify this purchase with the App Store',
      statusCode: 400,
      code: 'VERIFICATION_FAILED',
    });
    return;
  }

  // Reject a receipt minted in the wrong store environment (e.g. a free
  // Sandbox/TestFlight receipt replayed against the Production backend).
  if (tx.environment && tx.environment !== env.APPLE_ENVIRONMENT) {
    sendError({
      res,
      error: 'This purchase was made in a different store environment',
      statusCode: 400,
      code: 'WRONG_ENVIRONMENT',
    });
    return;
  }
  // Only grant entitlement for products we actually sell.
  if (!tierForProduct(tx.productId)) {
    sendError({ res, error: 'This product is not available', statusCode: 400, code: 'UNKNOWN_PRODUCT' });
    return;
  }

  const entitlement = await applyAppleTransaction(coupleId, tx);
  sendSuccess({ res, data: entitlement });
};

/**
 * POST /api/v1/subscriptions/apple/notifications
 * App Store Server Notifications V2 webhook. Unauthenticated by design — Apple
 * signs the payload, and we cryptographically verify that signature before
 * trusting anything. Always 200 quickly so Apple doesn't retry-storm.
 */
export const appleNotifications = async (req: Request, res: Response): Promise<void> => {
  const signedPayload = (req.body ?? {}).signedPayload as string | undefined;
  if (!signedPayload) {
    sendError({ res, error: 'signedPayload required', statusCode: 400, code: 'SIGNED_PAYLOAD_REQUIRED' });
    return;
  }

  // Ack immediately; process after so a slow DB never triggers Apple retries.
  // (Apple only reads the HTTP status — the envelope body is for our logs.)
  sendSuccess({ res });

  try {
    const notif = await decodeNotification(signedPayload);
    if (!notif) return;

    const signedTx = notif.data?.signedTransactionInfo;
    if (!signedTx) {
      logger.info(`[Sub][webhook] ${notif.notificationType}/${notif.subtype ?? '-'} (no tx)`);
      return;
    }
    const tx = await decodeSignedTransaction(signedTx);
    if (!tx) return;

    let forceStatus: SubStatus | undefined;
    switch (notif.notificationType) {
      case NotificationTypeV2.REFUND:
      case NotificationTypeV2.REVOKE:
        forceStatus = 'CANCELLED';
        break;
      case NotificationTypeV2.EXPIRED:
      case NotificationTypeV2.GRACE_PERIOD_EXPIRED:
        forceStatus = 'EXPIRED';
        break;
      case NotificationTypeV2.DID_FAIL_TO_RENEW:
        // Entered billing retry — keep access during grace if Apple says so.
        forceStatus = notif.subtype === Subtype.GRACE_PERIOD ? 'GRACE' : 'EXPIRED';
        break;
      default:
        forceStatus = undefined; // derive from expiry (SUBSCRIBED / DID_RENEW / etc.)
    }

    await applyAppleTransactionByOriginalId(tx, { forceStatus });
    logger.info(`[Sub][webhook] processed ${notif.notificationType}/${notif.subtype ?? '-'}`);
  } catch (err: any) {
    logger.error(`[Sub][webhook] processing failed: ${err?.message}`);
  }
};

/**
 * POST /api/v1/subscriptions/google/verify
 * Body: { productId, purchaseToken }
 * The app calls this after a successful Play purchase/restore. We fetch the
 * authoritative state from Google, acknowledge it (so Google doesn't auto-refund)
 * and set entitlement. Pending purchases (payment not yet debited) are NOT
 * granted — they resolve later via the RTDN webhook / restore.
 */
export const verifyGoogle = async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  if (!coupleId) {
    missingCoupleContext(res);
    return;
  }
  if (!isGoogleConfigured()) {
    sendError({
      res,
      error: 'Google Play purchases are not available right now',
      statusCode: 503,
      code: 'GOOGLE_NOT_CONFIGURED',
    });
    return;
  }
  const { productId, purchaseToken } = (req.body ?? {}) as {
    productId?: string;
    purchaseToken?: string;
  };
  if (!purchaseToken) {
    sendError({ res, error: 'purchaseToken is required', statusCode: 400, code: 'PURCHASE_TOKEN_REQUIRED' });
    return;
  }

  const info = await getSubscriptionV2(purchaseToken);
  if (!info) {
    sendError({
      res,
      error: 'We could not verify this purchase with Google Play',
      statusCode: 400,
      code: 'VERIFICATION_FAILED',
    });
    return;
  }

  // Payment not yet completed (deferred / UPI mandate / slow bank). Don't grant.
  // Deliberately NOT sendSuccess: the top-level `pending: true` flag is part of
  // the historical contract for this one response and the helper cannot carry
  // top-level extras — dropping it would silently change what callers see.
  if (isGooglePendingOrUnknown(info)) {
    const entitlement = await getEntitlement(coupleId);
    res.status(202).json({ success: true, pending: true, data: entitlement });
    return;
  }

  // Only grant entitlement for products we actually sell.
  if (!tierForProduct(info.productId ?? productId)) {
    sendError({ res, error: 'This product is not available', statusCode: 400, code: 'UNKNOWN_PRODUCT' });
    return;
  }

  // Prevent a single purchase token from unlocking multiple different couples
  // (subscription sharing). First couple to claim the token owns it.
  const tokenOwner = await prisma.subscription.findFirst({
    where: { purchaseToken },
    select: { coupleId: true },
  });
  if (tokenOwner && tokenOwner.coupleId !== coupleId) {
    sendError({
      res,
      error: 'This purchase is already linked to another couple',
      statusCode: 409,
      code: 'TOKEN_ALREADY_CLAIMED',
    });
    return;
  }

  // Acknowledge within Google's 3-day window (idempotent).
  const ackProduct = info.productId ?? productId;
  if (!info.acknowledged && ackProduct) {
    await acknowledgeSubscription(ackProduct, purchaseToken);
  }

  const entitlement = await applyGooglePurchase(coupleId, purchaseToken, info);
  sendSuccess({ res, data: entitlement });
};

/**
 * POST /api/v1/subscriptions/google/notifications
 * Google Play Real-time Developer Notifications (Pub/Sub push). Unauthenticated;
 * authenticity comes from re-fetching the purchase from Google. Always 200 fast.
 */
export const googleNotifications = async (req: Request, res: Response): Promise<void> => {
  // Shared-secret gate (?secret=...) on the Pub/Sub push URL. In production the
  // secret is REQUIRED (an unset secret would otherwise accept any POST); in
  // dev it stays optional for local testing.
  // Constant-time compare: a plain `===` short-circuits on the first differing
  // byte, leaking how many leading chars matched — a timing oracle for guessing
  // the secret. timingSafeEqualStr guards length, then compares in fixed time.
  const secretMatches = !!env.GOOGLE_RTDN_SECRET && timingSafeEqualStr(req.query.secret, env.GOOGLE_RTDN_SECRET);
  if (env.NODE_ENV === 'production') {
    if (!secretMatches) {
      sendSuccess({ res }); // ack silently, ignore
      return;
    }
  } else if (env.GOOGLE_RTDN_SECRET && !timingSafeEqualStr(req.query.secret, env.GOOGLE_RTDN_SECRET)) {
    sendSuccess({ res }); // ack silently, ignore
    return;
  }

  sendSuccess({ res }); // ack immediately (Google only reads the HTTP status)

  try {
    const message = (req.body ?? {}).message as { data?: string } | undefined;
    if (!message?.data) return;

    const decoded = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'));

    if (decoded.testNotification) {
      logger.info('[Sub][play-webhook] test notification received');
      return;
    }

    // Refund / chargeback / revoke.
    if (decoded.voidedPurchaseNotification?.purchaseToken) {
      const purchaseToken = decoded.voidedPurchaseNotification.purchaseToken as string;
      const info = await getSubscriptionV2(purchaseToken);
      if (info) await applyGooglePurchaseByToken(purchaseToken, info);
      else await expireGoogleToken(purchaseToken);
      logger.info('[Sub][play-webhook] processed voidedPurchase');
      return;
    }

    // Subscription lifecycle (renew / cancel / grace / hold / expire / etc.).
    const sub = decoded.subscriptionNotification as
      | { purchaseToken?: string; notificationType?: number }
      | undefined;
    if (sub?.purchaseToken) {
      const info = await getSubscriptionV2(sub.purchaseToken);
      if (info) await applyGooglePurchaseByToken(sub.purchaseToken, info);
      logger.info(`[Sub][play-webhook] processed subscriptionNotification type ${sub.notificationType}`);
    }
  } catch (err: any) {
    logger.error(`[Sub][play-webhook] processing failed: ${err?.message}`);
  }
};
