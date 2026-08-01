"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.limitsForState = exports.planForProduct = exports.tierForProduct = exports.isEnforced = exports.ACTIVE_STATUSES = exports.TRIAL_DAYS = exports.TRIAL_LIMITS = exports.PAID_LIMITS = void 0;
const env_1 = require("./env");
/** Paid Sawa Prime (monthly or yearly) — full access. */
exports.PAID_LIMITS = {
    connections: Number.POSITIVE_INFINITY,
    groups: Number.POSITIVE_INFINITY,
    canCreateGroup: true,
};
/** The 7-day free trial — a taste: 5 swipes, 5 group joins, no group creation. */
exports.TRIAL_LIMITS = {
    connections: 5,
    groups: 5,
    canCreateGroup: false,
};
exports.TRIAL_DAYS = 7;
/** Statuses that grant access to gated features. */
exports.ACTIVE_STATUSES = ['TRIALING', 'ACTIVE', 'GRACE'];
/** Is entitlement enforcement turned on? (see env.SUBSCRIPTIONS_ENFORCED) */
const isEnforced = () => env_1.env.SUBSCRIPTIONS_ENFORCED;
exports.isEnforced = isEnforced;
/** Map an Apple/Google product id → our tier. Monthly & yearly both = PRIME. */
const tierForProduct = (productId) => {
    if (!productId)
        return null;
    if (productId === env_1.env.APPLE_PRODUCT_PRIME_MONTHLY ||
        productId === env_1.env.APPLE_PRODUCT_PRIME_YEARLY ||
        productId === env_1.env.GOOGLE_PRODUCT_PRIME_MONTHLY ||
        productId === env_1.env.GOOGLE_PRODUCT_PRIME_YEARLY) {
        return 'PRIME';
    }
    return null;
};
exports.tierForProduct = tierForProduct;
/** Map a product id → its billing plan (monthly/yearly). */
const planForProduct = (productId) => {
    if (!productId)
        return null;
    if (productId === env_1.env.APPLE_PRODUCT_PRIME_MONTHLY ||
        productId === env_1.env.GOOGLE_PRODUCT_PRIME_MONTHLY) {
        return 'monthly';
    }
    if (productId === env_1.env.APPLE_PRODUCT_PRIME_YEARLY ||
        productId === env_1.env.GOOGLE_PRODUCT_PRIME_YEARLY) {
        return 'yearly';
    }
    return null;
};
exports.planForProduct = planForProduct;
/** Limits for a given live state — the trial gets a reduced set. */
const limitsForState = (state) => {
    if (state === 'TRIALING')
        return exports.TRIAL_LIMITS;
    if (state === 'ACTIVE' || state === 'GRACE')
        return exports.PAID_LIMITS;
    return null;
};
exports.limitsForState = limitsForState;
//# sourceMappingURL=subscription.js.map