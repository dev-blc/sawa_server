"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.appleNotifications = exports.verifyApple = exports.startTrialHandler = exports.getMySubscription = void 0;
const app_store_server_library_1 = require("@apple/app-store-server-library");
const logger_1 = require("../utils/logger");
const subscription_service_1 = require("../services/subscription.service");
const appstore_service_1 = require("../services/appstore.service");
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
//# sourceMappingURL=subscription.controller.js.map