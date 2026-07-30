/**
 * Subscription tiers, limits and store-product mapping.
 *
 * Confirmed product rules (client, 2026-07):
 *  - Sawa Prime      ₹499/mo — up to 5 connections, up to 5 group joins,
 *                    CANNOT create groups. A "skip" counts toward the 5 too.
 *  - Sawa Prime Plus ₹799/mo — unlimited group joins, CAN create groups,
 *                    a (higher) capped number of connections.
 *  - 7-day free trial applies to PRIME only, once per couple. No trial for Plus.
 *  - Entitlement is per COUPLE: either partner's purchase unlocks both.
 */
export type Tier = 'PRIME' | 'PRIME_PLUS';
export type SubStatus = 'NONE' | 'TRIALING' | 'ACTIVE' | 'GRACE' | 'EXPIRED' | 'CANCELLED';
export interface TierLimits {
    /** Max profiles a couple may act on in Discovery (skip OR connect both count). */
    connections: number;
    /** Max groups a couple may join. Number.POSITIVE_INFINITY = unlimited. */
    groups: number;
    /** May the couple create their own group? */
    canCreateGroup: boolean;
}
export declare const TIER_LIMITS: Record<Tier, TierLimits>;
/** During the free trial the couple gets PRIME-level access. */
export declare const TRIAL_TIER: Tier;
export declare const TRIAL_DAYS = 7;
/** Statuses that grant access to gated features. */
export declare const ACTIVE_STATUSES: SubStatus[];
/** Is entitlement enforcement turned on? (see env.SUBSCRIPTIONS_ENFORCED) */
export declare const isEnforced: () => boolean;
/** Map an Apple/Google product id → our tier. Returns null for unknown products. */
export declare const tierForProduct: (productId: string | null | undefined) => Tier | null;
export declare const limitsForTier: (tier: Tier) => TierLimits;
//# sourceMappingURL=subscription.d.ts.map