"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.googleNotifications = exports.verifyGoogle = exports.appleNotifications = exports.verifyApple = exports.startTrialHandler = exports.getMySubscription = void 0;
const app_store_server_library_1 = require("@apple/app-store-server-library");
const logger_1 = require("../utils/logger");
const subscription_service_1 = require("../services/subscription.service");
const appstore_service_1 = require("../services/appstore.service");
const googleplay_service_1 = require("../services/googleplay.service");
const env_1 = require("../config/env");
/** GET /api/v1/subscriptions/me — current entitlement + usage counts. */
const getMySubscription = async (req, res) => {
    const coupleId = req.user?.coupleId;
    if (!coupleId) {
        res.status(400).json({ success: false, error: 'Missing couple context' });
        return;
    }
    const [entitlement, connections, groups] = await Promise.all([
        (0, subscription_service_1.getEntitlement)(coupleId),
        (0, subscription_service_1.connectionsUsed)(coupleId),
        (0, subscription_service_1.groupsJoined)(coupleId),
    ]);
    res.json({ success: true, data: { ...entitlement, usage: { connections, groups } } });
};
exports.getMySubscription = getMySubscription;
/** POST /api/v1/subscriptions/trial — start the one-time 7-day PRIME trial. */
const startTrialHandler = async (req, res) => {
    const coupleId = req.user?.coupleId;
    if (!coupleId) {
        res.status(400).json({ success: false, error: 'Missing couple context' });
        return;
    }
    const result = await (0, subscription_service_1.startTrial)(coupleId);
    if (!result.ok) {
        res.status(409).json({ success: false, error: result.reason });
        return;
    }
    res.json({ success: true, data: result.entitlement });
};
exports.startTrialHandler = startTrialHandler;
/**
 * POST /api/v1/subscriptions/apple/verify
 * Body: { transactionId }
 * The app calls this right after a successful StoreKit purchase/restore. We ask
 * Apple for the authoritative signed transaction, verify it, and set entitlement.
 */
const verifyApple = async (req, res) => {
    const coupleId = req.user?.coupleId;
    if (!coupleId) {
        res.status(400).json({ success: false, error: 'Missing couple context' });
        return;
    }
    if (!(0, appstore_service_1.isAppleConfigured)()) {
        res.status(503).json({ success: false, error: 'APPLE_NOT_CONFIGURED' });
        return;
    }
    const { transactionId } = (req.body ?? {});
    if (!transactionId) {
        res.status(400).json({ success: false, error: 'transactionId is required' });
        return;
    }
    const tx = await (0, appstore_service_1.verifyTransactionById)(transactionId);
    if (!tx) {
        res.status(400).json({ success: false, error: 'VERIFICATION_FAILED' });
        return;
    }
    const entitlement = await (0, subscription_service_1.applyAppleTransaction)(coupleId, tx);
    res.json({ success: true, data: entitlement });
};
exports.verifyApple = verifyApple;
/**
 * POST /api/v1/subscriptions/apple/notifications
 * App Store Server Notifications V2 webhook. Unauthenticated by design — Apple
 * signs the payload, and we cryptographically verify that signature before
 * trusting anything. Always 200 quickly so Apple doesn't retry-storm.
 */
const appleNotifications = async (req, res) => {
    const signedPayload = (req.body ?? {}).signedPayload;
    if (!signedPayload) {
        res.status(400).json({ success: false, error: 'signedPayload required' });
        return;
    }
    // Ack immediately; process after so a slow DB never triggers Apple retries.
    res.status(200).json({ success: true });
    try {
        const notif = await (0, appstore_service_1.decodeNotification)(signedPayload);
        if (!notif)
            return;
        const signedTx = notif.data?.signedTransactionInfo;
        if (!signedTx) {
            logger_1.logger.info(`[Sub][webhook] ${notif.notificationType}/${notif.subtype ?? '-'} (no tx)`);
            return;
        }
        const tx = await (0, appstore_service_1.decodeSignedTransaction)(signedTx);
        if (!tx)
            return;
        let forceStatus;
        switch (notif.notificationType) {
            case app_store_server_library_1.NotificationTypeV2.REFUND:
            case app_store_server_library_1.NotificationTypeV2.REVOKE:
                forceStatus = 'CANCELLED';
                break;
            case app_store_server_library_1.NotificationTypeV2.EXPIRED:
            case app_store_server_library_1.NotificationTypeV2.GRACE_PERIOD_EXPIRED:
                forceStatus = 'EXPIRED';
                break;
            case app_store_server_library_1.NotificationTypeV2.DID_FAIL_TO_RENEW:
                // Entered billing retry — keep access during grace if Apple says so.
                forceStatus = notif.subtype === app_store_server_library_1.Subtype.GRACE_PERIOD ? 'GRACE' : 'EXPIRED';
                break;
            default:
                forceStatus = undefined; // derive from expiry (SUBSCRIBED / DID_RENEW / etc.)
        }
        await (0, subscription_service_1.applyAppleTransactionByOriginalId)(tx, { forceStatus });
        logger_1.logger.info(`[Sub][webhook] processed ${notif.notificationType}/${notif.subtype ?? '-'}`);
    }
    catch (err) {
        logger_1.logger.error(`[Sub][webhook] processing failed: ${err?.message}`);
    }
};
exports.appleNotifications = appleNotifications;
/**
 * POST /api/v1/subscriptions/google/verify
 * Body: { productId, purchaseToken }
 * The app calls this after a successful Play purchase/restore. We fetch the
 * authoritative state from Google, acknowledge it (so Google doesn't auto-refund)
 * and set entitlement. Pending purchases (payment not yet debited) are NOT
 * granted — they resolve later via the RTDN webhook / restore.
 */
const verifyGoogle = async (req, res) => {
    const coupleId = req.user?.coupleId;
    if (!coupleId) {
        res.status(400).json({ success: false, error: 'Missing couple context' });
        return;
    }
    if (!(0, googleplay_service_1.isGoogleConfigured)()) {
        res.status(503).json({ success: false, error: 'GOOGLE_NOT_CONFIGURED' });
        return;
    }
    const { productId, purchaseToken } = (req.body ?? {});
    if (!purchaseToken) {
        res.status(400).json({ success: false, error: 'purchaseToken is required' });
        return;
    }
    const info = await (0, googleplay_service_1.getSubscriptionV2)(purchaseToken);
    if (!info) {
        res.status(400).json({ success: false, error: 'VERIFICATION_FAILED' });
        return;
    }
    // Payment not yet completed (deferred / UPI mandate / slow bank). Don't grant.
    if ((0, subscription_service_1.isGooglePendingOrUnknown)(info)) {
        const entitlement = await (0, subscription_service_1.getEntitlement)(coupleId);
        res.status(202).json({ success: true, pending: true, data: entitlement });
        return;
    }
    // Acknowledge within Google's 3-day window (idempotent).
    const ackProduct = info.productId ?? productId;
    if (!info.acknowledged && ackProduct) {
        await (0, googleplay_service_1.acknowledgeSubscription)(ackProduct, purchaseToken);
    }
    const entitlement = await (0, subscription_service_1.applyGooglePurchase)(coupleId, purchaseToken, info);
    res.json({ success: true, data: entitlement });
};
exports.verifyGoogle = verifyGoogle;
/**
 * POST /api/v1/subscriptions/google/notifications
 * Google Play Real-time Developer Notifications (Pub/Sub push). Unauthenticated;
 * authenticity comes from re-fetching the purchase from Google. Always 200 fast.
 */
const googleNotifications = async (req, res) => {
    // Optional shared-secret gate (?secret=...) on the Pub/Sub push URL.
    if (env_1.env.GOOGLE_RTDN_SECRET && req.query.secret !== env_1.env.GOOGLE_RTDN_SECRET) {
        res.status(200).json({ success: true }); // ack silently, ignore
        return;
    }
    res.status(200).json({ success: true }); // ack immediately
    try {
        const message = (req.body ?? {}).message;
        if (!message?.data)
            return;
        const decoded = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'));
        if (decoded.testNotification) {
            logger_1.logger.info('[Sub][play-webhook] test notification received');
            return;
        }
        // Refund / chargeback / revoke.
        if (decoded.voidedPurchaseNotification?.purchaseToken) {
            const purchaseToken = decoded.voidedPurchaseNotification.purchaseToken;
            const info = await (0, googleplay_service_1.getSubscriptionV2)(purchaseToken);
            if (info)
                await (0, subscription_service_1.applyGooglePurchaseByToken)(purchaseToken, info);
            else
                await (0, subscription_service_1.expireGoogleToken)(purchaseToken);
            logger_1.logger.info('[Sub][play-webhook] processed voidedPurchase');
            return;
        }
        // Subscription lifecycle (renew / cancel / grace / hold / expire / etc.).
        const sub = decoded.subscriptionNotification;
        if (sub?.purchaseToken) {
            const info = await (0, googleplay_service_1.getSubscriptionV2)(sub.purchaseToken);
            if (info)
                await (0, subscription_service_1.applyGooglePurchaseByToken)(sub.purchaseToken, info);
            logger_1.logger.info(`[Sub][play-webhook] processed subscriptionNotification type ${sub.notificationType}`);
        }
    }
    catch (err) {
        logger_1.logger.error(`[Sub][play-webhook] processing failed: ${err?.message}`);
    }
};
exports.googleNotifications = googleNotifications;
//# sourceMappingURL=subscription.controller.js.map