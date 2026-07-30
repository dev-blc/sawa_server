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
} from '../services/subscription.service';
import {
  verifyTransactionById,
  decodeNotification,
  decodeSignedTransaction,
  isAppleConfigured,
} from '../services/appstore.service';
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
