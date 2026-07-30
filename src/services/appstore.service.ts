import fs from 'fs';
import path from 'path';
import {
  AppStoreServerAPIClient,
  SignedDataVerifier,
  Environment,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from '@apple/app-store-server-library';
import { env } from '../config/env';
import { logger } from '../utils/logger';

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

const ROOT_CA_DIR = path.resolve(__dirname, '../../certs/apple');

let loaded = false;
let rootCAs: Buffer[] = [];
// One client + verifier per Apple environment. Apple recommends trying
// Production first and falling back to Sandbox (TestFlight uses Sandbox).
let prodClient: AppStoreServerAPIClient | null = null;
let sandboxClient: AppStoreServerAPIClient | null = null;
let prodVerifier: SignedDataVerifier | null = null;
let sandboxVerifier: SignedDataVerifier | null = null;

const loadRootCAs = (): Buffer[] => {
  try {
    const files = fs.readdirSync(ROOT_CA_DIR).filter((f) => f.endsWith('.cer'));
    return files.map((f) => fs.readFileSync(path.join(ROOT_CA_DIR, f)));
  } catch (err) {
    logger.warn(`[AppStore] Could not load Apple root CAs from ${ROOT_CA_DIR}`, err);
    return [];
  }
};

const normalizeKey = (raw: string): string =>
  raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;

const init = (): void => {
  if (loaded) return;
  loaded = true;

  const { APPLE_ISSUER_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY, APPLE_BUNDLE_ID, APPLE_APP_APPLE_ID } = env;
  if (!APPLE_ISSUER_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY) {
    logger.warn(
      '[AppStore] APPLE_ISSUER_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY not set — ' +
        'Apple purchase verification disabled until configured.',
    );
    return;
  }

  rootCAs = loadRootCAs();
  if (rootCAs.length === 0) {
    logger.warn('[AppStore] No Apple root CAs found — signature verification will fail.');
  }

  const key = normalizeKey(APPLE_PRIVATE_KEY);
  try {
    prodClient = new AppStoreServerAPIClient(key, APPLE_KEY_ID, APPLE_ISSUER_ID, APPLE_BUNDLE_ID, Environment.PRODUCTION);
    sandboxClient = new AppStoreServerAPIClient(key, APPLE_KEY_ID, APPLE_ISSUER_ID, APPLE_BUNDLE_ID, Environment.SANDBOX);
    prodVerifier = new SignedDataVerifier(rootCAs, true, Environment.PRODUCTION, APPLE_BUNDLE_ID, APPLE_APP_APPLE_ID);
    sandboxVerifier = new SignedDataVerifier(rootCAs, true, Environment.SANDBOX, APPLE_BUNDLE_ID, APPLE_APP_APPLE_ID);
    logger.info(`[AppStore] Apple verification ENABLED (bundle: ${APPLE_BUNDLE_ID}).`);
  } catch (err: any) {
    logger.error(`[AppStore] Init failed — verification disabled: ${err?.message}`);
    prodClient = sandboxClient = null;
    prodVerifier = sandboxVerifier = null;
  }
};

init();

export const isAppleConfigured = (): boolean => !!(prodClient && prodVerifier);

/**
 * Ask Apple for the authoritative signed transaction, verify it, and return the
 * decoded payload. Tries Production first, then Sandbox (per Apple guidance) so
 * the same code path works for App Store, TestFlight and sandbox testers.
 */
export const verifyTransactionById = async (
  transactionId: string,
): Promise<JWSTransactionDecodedPayload | null> => {
  init();
  if (!isAppleConfigured()) return null;

  const attempts: Array<{ client: AppStoreServerAPIClient; verifier: SignedDataVerifier }> = [
    { client: prodClient!, verifier: prodVerifier! },
    { client: sandboxClient!, verifier: sandboxVerifier! },
  ];

  let lastErr: unknown = null;
  for (const { client, verifier } of attempts) {
    try {
      const resp = await client.getTransactionInfo(transactionId);
      if (!resp?.signedTransactionInfo) continue;
      return await verifier.verifyAndDecodeTransaction(resp.signedTransactionInfo);
    } catch (err) {
      lastErr = err;
      // Fall through to the next environment (likely an env mismatch).
    }
  }
  logger.warn(`[AppStore] verifyTransactionById(${transactionId}) failed: ${(lastErr as any)?.message ?? lastErr}`);
  return null;
};

/**
 * Verify + decode an App Store Server Notification V2 signedPayload.
 * Tries both environment verifiers.
 */
export const decodeNotification = async (
  signedPayload: string,
): Promise<ResponseBodyV2DecodedPayload | null> => {
  init();
  if (!prodVerifier && !sandboxVerifier) return null;
  const verifiers = [prodVerifier, sandboxVerifier].filter(Boolean) as SignedDataVerifier[];
  let lastErr: unknown = null;
  for (const v of verifiers) {
    try {
      return await v.verifyAndDecodeNotification(signedPayload);
    } catch (err) {
      lastErr = err;
    }
  }
  logger.warn(`[AppStore] decodeNotification failed: ${(lastErr as any)?.message ?? lastErr}`);
  return null;
};

/** Verify + decode a single signed transaction string (used inside notifications). */
export const decodeSignedTransaction = async (
  signedTransactionInfo: string,
): Promise<JWSTransactionDecodedPayload | null> => {
  init();
  const verifiers = [prodVerifier, sandboxVerifier].filter(Boolean) as SignedDataVerifier[];
  for (const v of verifiers) {
    try {
      return await v.verifyAndDecodeTransaction(signedTransactionInfo);
    } catch { /* try next */ }
  }
  return null;
};
