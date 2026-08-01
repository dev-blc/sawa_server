/**
 * Subscription tier, billing plans, limits and store-product mapping.
 *
 * Confirmed product rules (client, 2026-08):
 *  - ONE tier: **Sawa Prime**. Billed either **monthly ₹699** or **yearly ₹7999**
 *    (same access, only the billing period differs).
 *  - 7-day free trial, once per couple, no card required (server-granted). During
 *    the trial the couple gets a TASTE: 5 swipes + 5 groups, no group creation.
 *  - After paying (monthly or yearly), Sawa Prime is FULL access: unlimited
 *    swipes, unlimited group joins, and can create their own groups.
 *  - Entitlement is per COUPLE: either partner's purchase unlocks both.
 */
/** The app has a single paid tier. */
export type Tier = 'PRIME';
/** Billing period the couple chose. */
export type Plan = 'monthly' | 'yearly';
export type SubStatus = 'NONE' | 'TRIALING' | 'ACTIVE' | 'GRACE' | 'EXPIRED' | 'CANCELLED';
export interface TierLimits {
    /** Max profiles a couple may act on in Discovery (skip OR connect both count). */
    connections: number;
    /** Max groups a couple may join. Number.POSITIVE_INFINITY = unlimited. */
    groups: number;
    /** May the couple create their own group? */
    canCreateGroup: boolean;
}
/** Paid Sawa Prime (monthly or yearly) — full access. */
export declare const PAID_LIMITS: TierLimits;
/** The 7-day free trial — a taste: 5 swipes, 5 group joins, no group creation. */
export declare const TRIAL_LIMITS: TierLimits;
export declare const TRIAL_DAYS = 7;
/** Statuses that grant access to gated features. */
export declare const ACTIVE_STATUSES: SubStatus[];
/** Is entitlement enforcement turned on? (see env.SUBSCRIPTIONS_ENFORCED) */
export declare const isEnforced: () => boolean;
/** Map an Apple/Google product id → our tier. Monthly & yearly both = PRIME. */
export declare const tierForProduct: (productId: string | null | undefined) => Tier | null;
/** Map a product id → its billing plan (monthly/yearly). */
export declare const planForProduct: (productId: string | null | undefined) => Plan | null;
/** Limits for a given live state — the trial gets a reduced set. */
export declare const limitsForState: (state: SubStatus) => TierLimits | null;
//# sourceMappingURL=subscription.d.ts.map