"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireEntitlement = void 0;
const subscription_service_1 = require("../services/subscription.service");
const subscription_1 = require("../config/subscription");
const TIER_RANK = { PRIME: 1, PRIME_PLUS: 2 };
/**
 * Express middleware that enforces subscription entitlement on a gated route.
 *
 * IMPORTANT: this is a NO-OP unless `SUBSCRIPTIONS_ENFORCED=true`. That lets us
 * ship the whole subscription stack (model, verification, webhook, paywall)
 * without locking out today's users, then flip the switch once the paywall +
 * store products are live and users have had a chance to subscribe.
 *
 * On block it returns a stable shape the app maps to the paywall:
 *   402 { error: 'SUBSCRIPTION_REQUIRED', reason, tierNeeded? }
 */
const requireEntitlement = (opts = {}) => {
    return async (req, res, next) => {
        if (!(0, subscription_1.isEnforced)())
            return next();
        const coupleId = req.user?.coupleId;
        if (!coupleId) {
            res.status(400).json({ success: false, error: 'Missing couple context' });
            return;
        }
        const ent = await (0, subscription_service_1.getEntitlement)(coupleId);
        if (!ent.active || !ent.tier || !ent.limits) {
            res.status(402).json({
                success: false,
                error: 'SUBSCRIPTION_REQUIRED',
                reason: ent.state === 'EXPIRED' ? 'EXPIRED' : 'NONE',
            });
            return;
        }
        if (opts.minTier && TIER_RANK[ent.tier] < TIER_RANK[opts.minTier]) {
            res.status(402).json({
                success: false,
                error: 'SUBSCRIPTION_REQUIRED',
                reason: 'TIER_TOO_LOW',
                tierNeeded: opts.minTier,
            });
            return;
        }
        // Per-action limit checks.
        if (opts.gate === 'createGroup' && !ent.limits.canCreateGroup) {
            res.status(402).json({
                success: false,
                error: 'SUBSCRIPTION_REQUIRED',
                reason: 'TIER_TOO_LOW',
                tierNeeded: 'PRIME_PLUS',
            });
            return;
        }
        if (opts.gate === 'connection') {
            const used = await (0, subscription_service_1.connectionsUsed)(coupleId);
            if (used >= ent.limits.connections) {
                res.status(402).json({ success: false, error: 'SUBSCRIPTION_REQUIRED', reason: 'LIMIT_REACHED' });
                return;
            }
        }
        if (opts.gate === 'joinGroup') {
            const used = await (0, subscription_service_1.groupsJoined)(coupleId);
            if (used >= ent.limits.groups) {
                res.status(402).json({ success: false, error: 'SUBSCRIPTION_REQUIRED', reason: 'LIMIT_REACHED' });
                return;
            }
        }
        next();
    };
};
exports.requireEntitlement = requireEntitlement;
//# sourceMappingURL=requireEntitlement.js.map