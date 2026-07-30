"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.acknowledgeSubscription = exports.getSubscriptionV2 = exports.isGoogleConfigured = void 0;
const google_auth_library_1 = require("google-auth-library");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
/**
 * Google Play Billing server integration.
 *
 * Verifies subscription purchases directly with Google (the source of truth)
 * using a service account, and acknowledges them (Google auto-refunds any
 * purchase not acknowledged within 3 days). Mirrors appstore.service.ts.
 *
 * No-ops safely until GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is configured.
 */
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
let auth = null;
let loaded = false;
const normalizeJson = (raw) => raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
const init = () => {
    if (loaded)
        return;
    loaded = true;
    const raw = env_1.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
    if (!raw) {
        logger_1.logger.warn('[Play] GOOGLE_PLAY_SERVICE_ACCOUNT_JSON not set — Google verification disabled.');
        return;
    }
    try {
        const credentials = JSON.parse(normalizeJson(raw));
        auth = new google_auth_library_1.GoogleAuth({ credentials, scopes: [SCOPE] });
        logger_1.logger.info(`[Play] Google Play verification ENABLED (pkg: ${env_1.env.GOOGLE_PLAY_PACKAGE_NAME}).`);
    }
    catch (e) {
        logger_1.logger.error(`[Play] Bad GOOGLE_PLAY_SERVICE_ACCOUNT_JSON — verification disabled: ${e?.message}`);
        auth = null;
    }
};
init();
const isGoogleConfigured = () => !!auth;
exports.isGoogleConfigured = isGoogleConfigured;
const getAccessToken = async () => {
    if (!auth)
        return null;
    try {
        const client = await auth.getClient();
        const res = await client.getAccessToken();
        return res.token ?? null;
    }
    catch (e) {
        logger_1.logger.warn(`[Play] Failed to get access token: ${e?.message}`);
        return null;
    }
};
const mapState = (s) => {
    switch (s) {
        case 'SUBSCRIPTION_STATE_ACTIVE':
            return 'ACTIVE';
        case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
            return 'GRACE';
        case 'SUBSCRIPTION_STATE_ON_HOLD':
            return 'ON_HOLD';
        case 'SUBSCRIPTION_STATE_PAUSED':
            return 'PAUSED';
        case 'SUBSCRIPTION_STATE_CANCELED':
            return 'CANCELED';
        case 'SUBSCRIPTION_STATE_EXPIRED':
            return 'EXPIRED';
        case 'SUBSCRIPTION_STATE_PENDING':
        case 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED':
            return 'PENDING';
        default:
            return 'UNKNOWN';
    }
};
/**
 * Fetch the authoritative subscription state for a purchase token
 * (purchases.subscriptionsv2.get). Returns null on any failure.
 */
const getSubscriptionV2 = async (purchaseToken) => {
    init();
    const token = await getAccessToken();
    if (!token)
        return null;
    const pkg = env_1.env.GOOGLE_PLAY_PACKAGE_NAME;
    const url = `${API}/applications/${pkg}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
    try {
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!resp.ok) {
            const body = await resp.text();
            logger_1.logger.warn(`[Play] subscriptionsv2.get ${resp.status}: ${body.slice(0, 300)}`);
            return null;
        }
        const data = await resp.json();
        const lineItems = Array.isArray(data.lineItems) ? data.lineItems : [];
        // Latest expiry across line items.
        let expiryMs = 0;
        let productId = null;
        let autoRenew = false;
        for (const li of lineItems) {
            if (li?.expiryTime) {
                const ms = Date.parse(li.expiryTime);
                if (!Number.isNaN(ms) && ms > expiryMs) {
                    expiryMs = ms;
                    productId = li.productId ?? productId;
                }
            }
            if (li?.productId && !productId)
                productId = li.productId;
            if (li?.autoRenewingPlan?.autoRenewEnabled)
                autoRenew = true;
        }
        return {
            productId,
            expiryMs,
            state: mapState(data.subscriptionState),
            autoRenew,
            acknowledged: data.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
            linkedPurchaseToken: data.linkedPurchaseToken ?? null,
        };
    }
    catch (e) {
        logger_1.logger.warn(`[Play] subscriptionsv2.get failed: ${e?.message}`);
        return null;
    }
};
exports.getSubscriptionV2 = getSubscriptionV2;
/**
 * Acknowledge a subscription purchase so Google does not auto-refund it.
 * Idempotent — safe to call even if the client already acknowledged.
 */
const acknowledgeSubscription = async (productId, purchaseToken) => {
    init();
    const token = await getAccessToken();
    if (!token)
        return;
    const pkg = env_1.env.GOOGLE_PLAY_PACKAGE_NAME;
    const url = `${API}/applications/${pkg}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: '{}',
        });
        if (!resp.ok && resp.status !== 400) {
            // 400 usually means "already acknowledged" — safe to ignore.
            logger_1.logger.warn(`[Play] acknowledge ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        }
    }
    catch (e) {
        logger_1.logger.warn(`[Play] acknowledge failed: ${e?.message}`);
    }
};
exports.acknowledgeSubscription = acknowledgeSubscription;
//# sourceMappingURL=googleplay.service.js.map