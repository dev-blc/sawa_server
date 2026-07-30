"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPushEnabled = exports.pushToCouples = exports.pushToUser = exports.pushToCouple = void 0;
const firebase_admin_1 = __importDefault(require("firebase-admin"));
const prisma_1 = require("../lib/prisma");
const logger_1 = require("../utils/logger");
const notif_1 = require("../i18n/notif");
/**
 * Build a per-recipient localized copy of a push payload.
 *
 * When the caller attached `data.i18nKey` (+ optional `data.i18nParams`), we
 * re-render the title/body in the recipient's chosen language. Android renders
 * from the `data` fields (client-side), and iOS shows the APNs `title`/`body`,
 * so we localize BOTH. If no i18nKey is present we fall back to the caller's
 * English strings unchanged.
 */
const localizeFor = (payload, locale) => {
    let title = payload.title;
    let body = payload.body;
    const rawData = payload.data ?? {};
    const i18nKey = typeof rawData.i18nKey === 'string' ? rawData.i18nKey : undefined;
    if (i18nKey && (0, notif_1.hasNotifKey)(i18nKey)) {
        let params = {};
        const rp = rawData.i18nParams;
        if (typeof rp === 'string') {
            try {
                params = JSON.parse(rp);
            }
            catch { /* keep {} */ }
        }
        else if (rp && typeof rp === 'object') {
            params = rp;
        }
        const rendered = (0, notif_1.renderNotif)(locale, i18nKey, params);
        title = rendered.title || title;
        body = rendered.body || body;
    }
    const stringData = {};
    for (const [k, v] of Object.entries(rawData)) {
        if (v === null || v === undefined)
            continue;
        stringData[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return { title, body, data: { title, body, ...stringData } };
};
/**
 * Push Notification Service
 *
 * Bridges in-app notifications (Socket.IO + DB) to OS-level push via Firebase
 * Cloud Messaging (FCM). FCM handles APNs delivery for iOS automatically once
 * the APNs key is uploaded in the Firebase console.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Setup (one-time, by ops):
 *   1. Create a Firebase project for SAWA.
 *   2. Console → Project settings → Service accounts → Generate new private
 *      key. Save the JSON.
 *   3. Set the env var FIREBASE_SERVICE_ACCOUNT_JSON to the *full JSON string*
 *      (single line, no newlines). On Railway you can paste it directly.
 *   4. For iOS: upload your APNs Authentication Key (.p8) under Project
 *      settings → Cloud Messaging → Apple app configuration. Bundle ID:
 *      com.sawa.application. Team ID + Key ID from your Apple Developer
 *      account.
 *
 * Without FIREBASE_SERVICE_ACCOUNT_JSON set, push delivery silently no-ops
 * (in-app notifications continue to work as before).
 * ──────────────────────────────────────────────────────────────────────────
 */
let initialised = false;
let enabled = false;
const init = () => {
    if (initialised)
        return;
    initialised = true;
    // Accept either the full service-account JSON (preferred) or, as a fallback,
    // the three individual fields. This lets us survive Railway's occasional
    // mangling of large multi-line env vars.
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const projectIdEnv = process.env.FIREBASE_PROJECT_ID;
    const clientEmailEnv = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKeyEnv = process.env.FIREBASE_PRIVATE_KEY;
    if (!raw && !(projectIdEnv && clientEmailEnv && privateKeyEnv)) {
        logger_1.logger.warn('[Push] FIREBASE_SERVICE_ACCOUNT_JSON not set — push notifications disabled. ' +
            'In-app notifications continue to work normally.');
        return;
    }
    try {
        let serviceAccount;
        if (raw) {
            serviceAccount = JSON.parse(raw);
        }
        else {
            serviceAccount = {
                projectId: projectIdEnv,
                clientEmail: clientEmailEnv,
                privateKey: privateKeyEnv,
            };
        }
        // CRITICAL: Railway (and most env-var UIs) store the private key with the
        // newlines escaped as the two characters "\n". Firebase needs REAL newline
        // characters or credential.cert() throws "Invalid PEM formatted message".
        const pk = serviceAccount.private_key ?? serviceAccount.privateKey;
        if (typeof pk === 'string' && pk.includes('\\n')) {
            const fixed = pk.replace(/\\n/g, '\n');
            if ('private_key' in serviceAccount)
                serviceAccount.private_key = fixed;
            if ('privateKey' in serviceAccount)
                serviceAccount.privateKey = fixed;
        }
        firebase_admin_1.default.initializeApp({
            credential: firebase_admin_1.default.credential.cert(serviceAccount),
        });
        enabled = true;
        logger_1.logger.info(`[Push] Firebase Admin initialised — push delivery ENABLED (project: ${serviceAccount.project_id ?? serviceAccount.projectId ?? 'unknown'}).`);
    }
    catch (err) {
        logger_1.logger.error(`[Push] Firebase Admin init FAILED — push disabled. Reason: ${err.message}. ` +
            `Check FIREBASE_SERVICE_ACCOUNT_JSON is valid JSON with a correct private_key.`);
    }
};
init();
/**
 * Send a push notification to every registered device of a couple.
 *
 * Looks up both partners' push tokens. Any token that returns
 * UNREGISTERED / INVALID_ARGUMENT from FCM is removed from the DB so we don't
 * keep retrying a stale install.
 */
const pushToCouple = async (coupleId, payload) => {
    if (!enabled)
        return { sent: 0, failed: 0 };
    const users = await prisma_1.prisma.user.findMany({
        where: { coupleId, pushToken: { not: null } },
        select: { id: true, pushToken: true, pushPlatform: true, preferredLocale: true },
    });
    const targets = users.filter((u) => !!u.pushToken && u.pushToken.length > 0);
    if (targets.length === 0) {
        logger_1.logger.warn(`[Push] pushToCouple(${coupleId}): no tokens found — users have not registered push yet.`);
        return { sent: 0, failed: 0 };
    }
    logger_1.logger.info(`[Push] pushToCouple(${coupleId}): sending "${payload.title}" to ${targets.length} device(s).`);
    // Send per-recipient so each partner receives the notification in THEIR own
    // selected language (Android renders from data; iOS shows the APNs alert).
    const deadTokens = [];
    let sent = 0;
    let failed = 0;
    await Promise.all(targets.map(async (u) => {
        const { title, body, data } = localizeFor(payload, u.preferredLocale);
        try {
            await firebase_admin_1.default.messaging().send({
                token: u.pushToken,
                // NO notification field → pure data message on Android (notifee renders).
                data,
                android: { priority: 'high', collapseKey: payload.collapseKey },
                apns: { payload: { aps: { alert: { title, body }, sound: 'default', badge: 1 } } },
            });
            sent += 1;
        }
        catch (err) {
            failed += 1;
            const code = (err?.errorInfo?.code ?? err?.code);
            if (code === 'messaging/registration-token-not-registered' ||
                code === 'messaging/invalid-registration-token' ||
                code === 'messaging/invalid-argument') {
                deadTokens.push(u.pushToken);
            }
            else {
                logger_1.logger.warn(`[Push] pushToCouple token failed: ${code} — ${err?.message}`);
            }
        }
    }));
    if (deadTokens.length > 0) {
        await prisma_1.prisma.user.updateMany({
            where: { pushToken: { in: deadTokens } },
            data: { pushToken: null, pushPlatform: null },
        });
        logger_1.logger.info(`[Push] Pruned ${deadTokens.length} stale FCM token(s).`);
    }
    logger_1.logger.info(`[Push] pushToCouple(${coupleId}): sent=${sent} failed=${failed}`);
    return { sent, failed };
};
exports.pushToCouple = pushToCouple;
/**
 * Send a push notification to one specific user (not both partners).
 * Used for private partner-to-partner notifications like US Space nudges so
 * the sender does NOT receive their own notification.
 */
const pushToUser = async (userId, payload) => {
    if (!enabled)
        return { sent: 0, failed: 0 };
    // findUnique only accepts the unique key — extra conditions like
    // pushToken: { not: null } are not valid there. Check null after fetch.
    const user = await prisma_1.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, pushToken: true, preferredLocale: true },
    });
    const token = user?.pushToken ?? null;
    if (!token) {
        logger_1.logger.warn(`[Push] pushToUser(${userId}): no token found — user has not registered push yet.`);
        return { sent: 0, failed: 0 };
    }
    // Localize to the recipient's chosen language.
    const { title, body, data: dataWithText } = localizeFor(payload, user?.preferredLocale);
    logger_1.logger.info(`[Push] pushToUser(${userId}): sending "${title}".`);
    try {
        const response = await firebase_admin_1.default.messaging().send({
            token,
            // Android: data-only so the app's notifee background handler renders it
            // with the full-color SAWA logo. iOS: APNs alert for system auto-display.
            data: dataWithText,
            android: {
                priority: 'high',
                collapseKey: payload.collapseKey,
            },
            apns: {
                payload: { aps: { alert: { title, body }, sound: 'default', badge: 1 } },
            },
        });
        logger_1.logger.info(`[Push] Sent to user ${userId}: ${response}`);
        return { sent: 1, failed: 0 };
    }
    catch (err) {
        const code = err?.errorInfo?.code;
        if (code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token') {
            await prisma_1.prisma.user.update({
                where: { id: userId },
                data: { pushToken: null, pushPlatform: null },
            });
            logger_1.logger.info(`[Push] Pruned stale token for user ${userId}.`);
        }
        else {
            logger_1.logger.error(`[Push] Send to user ${userId} failed: ${err.message}`);
        }
        return { sent: 0, failed: 1 };
    }
};
exports.pushToUser = pushToUser;
/**
 * Convenience: push to many couples in parallel. Returns aggregate counts.
 */
const pushToCouples = async (coupleIds, payload) => {
    const results = await Promise.all(coupleIds.map((id) => (0, exports.pushToCouple)(id, payload)));
    return results.reduce((acc, r) => ({ sent: acc.sent + r.sent, failed: acc.failed + r.failed }), { sent: 0, failed: 0 });
};
exports.pushToCouples = pushToCouples;
const isPushEnabled = () => enabled;
exports.isPushEnabled = isPushEnabled;
//# sourceMappingURL=push.service.js.map