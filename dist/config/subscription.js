"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.limitsForTier = exports.tierForProduct = exports.isEnforced = exports.ACTIVE_STATUSES = exports.TRIAL_DAYS = exports.TRIAL_TIER = exports.TIER_LIMITS = void 0;
const env_1 = require("./env");
exports.TIER_LIMITS = {
    PRIME: {
        connections: 5,
        groups: 5,
        canCreateGroup: false,
    },
    PRIME_PLUS: {
        // Client confirmed (2026-07): Prime Plus = unlimited connections + groups.
        connections: Number.POSITIVE_INFINITY,
        groups: Number.POSITIVE_INFINITY,
        canCreateGroup: true,
    },
};
/** During the free trial the couple gets PRIME-level access. */
exports.TRIAL_TIER = 'PRIME';
exports.TRIAL_DAYS = 7;
/** Statuses that grant access to gated features. */
exports.ACTIVE_STATUSES = ['TRIALING', 'ACTIVE', 'GRACE'];
/** Is entitlement enforcement turned on? (see env.SUBSCRIPTIONS_ENFORCED) */
const isEnforced = () => env_1.env.SUBSCRIPTIONS_ENFORCED;
exports.isEnforced = isEnforced;
/** Map an Apple/Google product id → our tier. Returns null for unknown products. */
const tierForProduct = (productId) => {
    if (!productId)
        return null;
    if (productId === env_1.env.APPLE_PRODUCT_PRIME || productId === env_1.env.GOOGLE_PRODUCT_PRIME)
        return 'PRIME';
    if (productId === env_1.env.APPLE_PRODUCT_PRIME_PLUS || productId === env_1.env.GOOGLE_PRODUCT_PRIME_PLUS) {
        return 'PRIME_PLUS';
    }
    return null;
};
exports.tierForProduct = tierForProduct;
const limitsForTier = (tier) => exports.TIER_LIMITS[tier];
exports.limitsForTier = limitsForTier;
//# sourceMappingURL=subscription.js.map