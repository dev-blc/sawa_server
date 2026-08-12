"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireEntitlement = void 0;
const subscription_service_1 = require("../services/subscription.service");
const subscription_1 = require("../config/subscription");
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
        const limits = ent.limits;
        // limits is only null if no access path is defined for the state (should not
        // happen now that free couples get FREE_LIMITS). Treat as paywalled.
        if (!limits) {
            res.status(402).json({
                success: false,
                error: 'SUBSCRIPTION_REQUIRED',
                reason: ent.state === 'EXPIRED' ? 'EXPIRED' : 'NONE',
            });
            return;
        }
        // Per-action limit checks. Free and trial couples are allowed up to their
        // limits; they only hit the paywall when they exceed them. Paid Prime has
        // unlimited limits (INFINITY_SENTINEL), so these checks never trip for them.
        // Creating a group needs a PAID plan — free/trial can't create groups.
        if (opts.gate === 'createGroup' && !limits.canCreateGroup) {
            res.status(402).json({
                success: false,
                error: 'SUBSCRIPTION_REQUIRED',
                reason: 'PAID_REQUIRED',
            });
            return;
        }
        if (opts.gate === 'connection') {
            // Per-DAY quota (5/day for free & trial), not lifetime.
            const used = await (0, subscription_service_1.connectionsUsedToday)(coupleId);
            if (used >= limits.connections) {
                res.status(402).json({ success: false, error: 'SUBSCRIPTION_REQUIRED', reason: 'LIMIT_REACHED' });
                return;
            }
        }
        if (opts.gate === 'joinGroup') {
            // Total groups joined (5 total for free & trial).
            const used = await (0, subscription_service_1.groupsJoined)(coupleId);
            if (used >= limits.groups) {
                res.status(402).json({ success: false, error: 'SUBSCRIPTION_REQUIRED', reason: 'LIMIT_REACHED' });
                return;
            }
        }
        next();
    };
};
exports.requireEntitlement = requireEntitlement;
//# sourceMappingURL=requireEntitlement.js.map