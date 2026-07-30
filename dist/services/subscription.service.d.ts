import { TIER_LIMITS, type Tier, type SubStatus, type TierLimits } from '../config/subscription';
import type { JWSTransactionDecodedPayload } from '@apple/app-store-server-library';
export interface Entitlement {
    state: SubStatus;
    tier: Tier | null;
    active: boolean;
    limits: TierLimits | null;
    trialUsed: boolean;
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
    /** Whether the app should actually enforce gating (master switch). */
    enforced: boolean;
}
/**
 * Resolve the couple's live entitlement, downgrading TRIALING/ACTIVE to EXPIRED
 * when the trial/period end date has passed (the webhook keeps this fresh, but
 * this guards the read path too).
 */
export declare const getEntitlement: (coupleId: string) => Promise<Entitlement>;
/** How many Discovery profiles the couple has acted on (skip + connect both count). */
export declare const connectionsUsed: (coupleId: string) => Promise<number>;
/** How many groups the couple has joined. */
export declare const groupsJoined: (coupleId: string) => Promise<number>;
/**
 * Start the one-time 7-day PRIME free trial for a couple.
 * Returns { ok:false, reason } if the trial was already used.
 */
export declare const startTrial: (coupleId: string) => Promise<{
    ok: true;
    entitlement: Entitlement;
} | {
    ok: false;
    reason: string;
}>;
/**
 * Apply a verified Apple transaction to a couple's entitlement.
 * Used by both the client verify endpoint and the webhook.
 */
export declare const applyAppleTransaction: (coupleId: string, tx: JWSTransactionDecodedPayload, opts?: {
    autoRenew?: boolean;
}) => Promise<Entitlement>;
/**
 * Apply a transaction that arrived via webhook. We don't get our coupleId from
 * Apple, so we locate the couple by originalTransactionId (set on first verify).
 */
export declare const applyAppleTransactionByOriginalId: (tx: JWSTransactionDecodedPayload, opts?: {
    autoRenew?: boolean;
    forceStatus?: SubStatus;
}) => Promise<void>;
export { TIER_LIMITS };
//# sourceMappingURL=subscription.service.d.ts.map