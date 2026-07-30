import { Request, Response } from 'express';
import { NotificationTypeV2, Subtype } from '@apple/app-store-server-library';
import { logger } from '../utils/logger';
import {
  getEntitlement,
  startTrial,
  connectionsUsed,
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
import type { SubStatus } from '../config/subscription';

/** GET /api/v1/subscriptions/me — current entitlement + usage counts. */
export const getMySubscription = async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  if (!coupleId) {
    res.status(400).json({ success: false, error: 'Missing couple context' });
    return;
  }
  const [entitlement, connections, groups] = await Promise.all([
    getEntitlement(coupleId),
    connectionsUsed(coupleId),
    groupsJoined(coupleId),
  ]);
  res.json({ success: true, data: { ...entitlement, usage: { connections, groups } } });
};

/** POST /api/v1/subscriptions/trial — start the one-time 7-day PRIME trial. */
export const startTrialHandler = async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  if (!coupleId) {
    res.status(400).json({ success: false, error: 'Missing couple context' });
    return;
  }
  const result = await startTrial(coupleId);
  if (!result.ok) {
    res.status(409).json({ success: false, error: result.reason });
    return;
  }
  res.json({ success: true, data: result.entitlement });
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
    res.status(400).json({ success: false, error: 'Missing couple context' });
    return;
  }
  if (!isAppleConfigured()) {
    res.status(503).json({ success: false, error: 'APPLE_NOT_CONFIGURED' });
    return;
  }
  const { transactionId } = (req.body ?? {}) as { transactionId?: string };
  if (!transactionId) {
    res.status(400).json({ success: false, error: 'transactionId is required' });
    return;
  }

  const tx = await verifyTransactionById(transactionId);
  if (!tx) {
    res.status(400).json({ success: false, error: 'VERIFICATION_FAILED' });
    return;
  }

  const entitlement = await applyAppleTransaction(coupleId, tx);
  res.json({ success: true, data: entitlement });
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
    res.status(400).json({ success: false, error: 'signedPayload required' });
    return;
  }

  // Ack immediately; process after so a slow DB never triggers Apple retries.
  res.status(200).json({ success: true });

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
    res.status(400).json({ success: false, error: 'Missing couple context' });
    return;
  }
  if (!isGoogleConfigured()) {
    res.status(503).json({ success: false, error: 'GOOGLE_NOT_CONFIGURED' });
    return;
  }
  const { productId, purchaseToken } = (req.body ?? {}) as {
    productId?: string;
    purchaseToken?: string;
  };
  if (!purchaseToken) {
    res.status(400).json({ success: false, error: 'purchaseToken is required' });
    return;
  }

  const info = await getSubscriptionV2(purchaseToken);
  if (!info) {
    res.status(400).json({ success: false, error: 'VERIFICATION_FAILED' });
    return;
  }

  // Payment not yet completed (deferred / UPI mandate / slow bank). Don't grant.
  if (isGooglePendingOrUnknown(info)) {
    const entitlement = await getEntitlement(coupleId);
    res.status(202).json({ success: true, pending: true, data: entitlement });
    return;
  }

  // Acknowledge within Google's 3-day window (idempotent).
  const ackProduct = info.productId ?? productId;
  if (!info.acknowledged && ackProduct) {
    await acknowledgeSubscription(ackProduct, purchaseToken);
  }

  const entitlement = await applyGooglePurchase(coupleId, purchaseToken, info);
  res.json({ success: true, data: entitlement });
};

/**
 * POST /api/v1/subscriptions/google/notifications
 * Google Play Real-time Developer Notifications (Pub/Sub push). Unauthenticated;
 * authenticity comes from re-fetching the purchase from Google. Always 200 fast.
 */
export const googleNotifications = async (req: Request, res: Response): Promise<void> => {
  // Optional shared-secret gate (?secret=...) on the Pub/Sub push URL.
  if (env.GOOGLE_RTDN_SECRET && req.query.secret !== env.GOOGLE_RTDN_SECRET) {
    res.status(200).json({ success: true }); // ack silently, ignore
    return;
  }

  res.status(200).json({ success: true }); // ack immediately

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
