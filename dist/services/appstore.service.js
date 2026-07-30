"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeSignedTransaction = exports.decodeNotification = exports.verifyTransactionById = exports.isAppleConfigured = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const app_store_server_library_1 = require("@apple/app-store-server-library");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
/**
 * Apple App Store server integration.
 *
 * Two responsibilities:
 *  1. Verify a purchase the app reports (client sends a transactionId; we ask
 *     Apple's App Store Server API for the authoritative, signed transaction and
 *     cryptographically verify it against Apple's root CAs).
 *  2. Verify + decode App Store Server Notifications V2 (the webhook Apple calls
 *     on renew / cancel / refund / expire / billing-retry).
 *
 * Everything here no-ops safely until APPLE_ISSUER_ID / APPLE_KEY_ID /
 * APPLE_PRIVATE_KEY are configured, so the server boots fine before the client
 * finishes App Store Connect setup.
 */
const ROOT_CA_DIR = path_1.default.resolve(__dirname, '../../certs/apple');
let loaded = false;
let rootCAs = [];
// One client + verifier per Apple environment. Apple recommends trying
// Production first and falling back to Sandbox (TestFlight uses Sandbox).
let prodClient = null;
let sandboxClient = null;
let prodVerifier = null;
let sandboxVerifier = null;
const loadRootCAs = () => {
    try {
        const files = fs_1.default.readdirSync(ROOT_CA_DIR).filter((f) => f.endsWith('.cer'));
        return files.map((f) => fs_1.default.readFileSync(path_1.default.join(ROOT_CA_DIR, f)));
    }
    catch (err) {
        logger_1.logger.warn(`[AppStore] Could not load Apple root CAs from ${ROOT_CA_DIR}`, err);
        return [];
    }
};
const normalizeKey = (raw) => raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
const init = () => {
    if (loaded)
        return;
    loaded = true;
    const { APPLE_ISSUER_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY, APPLE_BUNDLE_ID, APPLE_APP_APPLE_ID } = env_1.env;
    if (!APPLE_ISSUER_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY) {
        logger_1.logger.warn('[AppStore] APPLE_ISSUER_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY not set — ' +
            'Apple purchase verification disabled until configured.');
        return;
    }
    rootCAs = loadRootCAs();
    if (rootCAs.length === 0) {
        logger_1.logger.warn('[AppStore] No Apple root CAs found — signature verification will fail.');
    }
    const key = normalizeKey(APPLE_PRIVATE_KEY);
    try {
        prodClient = new app_store_server_library_1.AppStoreServerAPIClient(key, APPLE_KEY_ID, APPLE_ISSUER_ID, APPLE_BUNDLE_ID, app_store_server_library_1.Environment.PRODUCTION);
        sandboxClient = new app_store_server_library_1.AppStoreServerAPIClient(key, APPLE_KEY_ID, APPLE_ISSUER_ID, APPLE_BUNDLE_ID, app_store_server_library_1.Environment.SANDBOX);
        prodVerifier = new app_store_server_library_1.SignedDataVerifier(rootCAs, true, app_store_server_library_1.Environment.PRODUCTION, APPLE_BUNDLE_ID, APPLE_APP_APPLE_ID);
        sandboxVerifier = new app_store_server_library_1.SignedDataVerifier(rootCAs, true, app_store_server_library_1.Environment.SANDBOX, APPLE_BUNDLE_ID, APPLE_APP_APPLE_ID);
        logger_1.logger.info(`[AppStore] Apple verification ENABLED (bundle: ${APPLE_BUNDLE_ID}).`);
    }
    catch (err) {
        logger_1.logger.error(`[AppStore] Init failed — verification disabled: ${err?.message}`);
        prodClient = sandboxClient = null;
        prodVerifier = sandboxVerifier = null;
    }
};
init();
const isAppleConfigured = () => !!(prodClient && prodVerifier);
exports.isAppleConfigured = isAppleConfigured;
/**
 * Ask Apple for the authoritative signed transaction, verify it, and return the
 * decoded payload. Tries Production first, then Sandbox (per Apple guidance) so
 * the same code path works for App Store, TestFlight and sandbox testers.
 */
const verifyTransactionById = async (transactionId) => {
    init();
    if (!(0, exports.isAppleConfigured)())
        return null;
    const attempts = [
        { client: prodClient, verifier: prodVerifier },
        { client: sandboxClient, verifier: sandboxVerifier },
    ];
    let lastErr = null;
    for (const { client, verifier } of attempts) {
        try {
            const resp = await client.getTransactionInfo(transactionId);
            if (!resp?.signedTransactionInfo)
                continue;
            return await verifier.verifyAndDecodeTransaction(resp.signedTransactionInfo);
        }
        catch (err) {
            lastErr = err;
            // Fall through to the next environment (likely an env mismatch).
        }
    }
    logger_1.logger.warn(`[AppStore] verifyTransactionById(${transactionId}) failed: ${lastErr?.message ?? lastErr}`);
    return null;
};
exports.verifyTransactionById = verifyTransactionById;
/**
 * Verify + decode an App Store Server Notification V2 signedPayload.
 * Tries both environment verifiers.
 */
const decodeNotification = async (signedPayload) => {
    init();
    if (!prodVerifier && !sandboxVerifier)
        return null;
    const verifiers = [prodVerifier, sandboxVerifier].filter(Boolean);
    let lastErr = null;
    for (const v of verifiers) {
        try {
            return await v.verifyAndDecodeNotification(signedPayload);
        }
        catch (err) {
            lastErr = err;
        }
    }
    logger_1.logger.warn(`[AppStore] decodeNotification failed: ${lastErr?.message ?? lastErr}`);
    return null;
};
exports.decodeNotification = decodeNotification;
/** Verify + decode a single signed transaction string (used inside notifications). */
const decodeSignedTransaction = async (signedTransactionInfo) => {
    init();
    const verifiers = [prodVerifier, sandboxVerifier].filter(Boolean);
    for (const v of verifiers) {
        try {
            return await v.verifyAndDecodeTransaction(signedTransactionInfo);
        }
        catch { /* try next */ }
    }
    return null;
};
exports.decodeSignedTransaction = decodeSignedTransaction;
//# sourceMappingURL=appstore.service.js.map