import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env';
import { logger } from '../utils/logger';

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

export type GooglePurchaseState =
  | 'ACTIVE'
  | 'GRACE'
  | 'ON_HOLD'
  | 'PAUSED'
  | 'CANCELED'
  | 'EXPIRED'
  | 'PENDING'
  | 'UNKNOWN';

export interface GoogleSubInfo {
  productId: string | null;
  expiryMs: number; // 0 when unknown
  state: GooglePurchaseState;
  autoRenew: boolean;
  acknowledged: boolean;
  linkedPurchaseToken: string | null;
}

let auth: GoogleAuth | null = null;
let loaded = false;

const normalizeJson = (raw: string): string =>
  raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;

const init = (): void => {
  if (loaded) return;
  loaded = true;
  const raw = env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    logger.warn('[Play] GOOGLE_PLAY_SERVICE_ACCOUNT_JSON not set — Google verification disabled.');
    return;
  }
  try {
    const credentials = JSON.parse(normalizeJson(raw));
    auth = new GoogleAuth({ credentials, scopes: [SCOPE] });
    logger.info(`[Play] Google Play verification ENABLED (pkg: ${env.GOOGLE_PLAY_PACKAGE_NAME}).`);
  } catch (e: any) {
    logger.error(`[Play] Bad GOOGLE_PLAY_SERVICE_ACCOUNT_JSON — verification disabled: ${e?.message}`);
    auth = null;
  }
};

init();

export const isGoogleConfigured = (): boolean => !!auth;

const getAccessToken = async (): Promise<string | null> => {
  if (!auth) return null;
  try {
    const client = await auth.getClient();
    const res = await client.getAccessToken();
    return res.token ?? null;
  } catch (e: any) {
    logger.warn(`[Play] Failed to get access token: ${e?.message}`);
    return null;
  }
};

const mapState = (s: string | undefined): GooglePurchaseState => {
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
export const getSubscriptionV2 = async (
  purchaseToken: string,
): Promise<GoogleSubInfo | null> => {
  init();
  const token = await getAccessToken();
  if (!token) return null;

  const pkg = env.GOOGLE_PLAY_PACKAGE_NAME;
  const url = `${API}/applications/${pkg}/purchases/subscriptionsv2/tokens/${encodeURIComponent(
    purchaseToken,
  )}`;

  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      const body = await resp.text();
      logger.warn(`[Play] subscriptionsv2.get ${resp.status}: ${body.slice(0, 300)}`);
      return null;
    }
    const data: any = await resp.json();
    const lineItems: any[] = Array.isArray(data.lineItems) ? data.lineItems : [];

    // Latest expiry across line items.
    let expiryMs = 0;
    let productId: string | null = null;
    let autoRenew = false;
    for (const li of lineItems) {
      if (li?.expiryTime) {
        const ms = Date.parse(li.expiryTime);
        if (!Number.isNaN(ms) && ms > expiryMs) {
          expiryMs = ms;
          productId = li.productId ?? productId;
        }
      }
      if (li?.productId && !productId) productId = li.productId;
      if (li?.autoRenewingPlan?.autoRenewEnabled) autoRenew = true;
    }

    return {
      productId,
      expiryMs,
      state: mapState(data.subscriptionState),
      autoRenew,
      acknowledged: data.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
      linkedPurchaseToken: data.linkedPurchaseToken ?? null,
    };
  } catch (e: any) {
    logger.warn(`[Play] subscriptionsv2.get failed: ${e?.message}`);
    return null;
  }
};

/**
 * Acknowledge a subscription purchase so Google does not auto-refund it.
 * Idempotent — safe to call even if the client already acknowledged.
 */
export const acknowledgeSubscription = async (
  productId: string,
  purchaseToken: string,
): Promise<void> => {
  init();
  const token = await getAccessToken();
  if (!token) return;
  const pkg = env.GOOGLE_PLAY_PACKAGE_NAME;
  const url = `${API}/applications/${pkg}/purchases/subscriptions/${encodeURIComponent(
    productId,
  )}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!resp.ok && resp.status !== 400) {
      // 400 usually means "already acknowledged" — safe to ignore.
      logger.warn(`[Play] acknowledge ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
  } catch (e: any) {
    logger.warn(`[Play] acknowledge failed: ${e?.message}`);
  }
};
