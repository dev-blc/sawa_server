import { Request, Response, NextFunction } from 'express';
type Gate = 'connection' | 'joinGroup' | 'createGroup' | 'chat' | 'discovery';
interface Options {
    /** The action being gated — drives limit checks. */
    gate?: Gate;
}
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
export declare const requireEntitlement: (opts?: Options) => (req: Request, res: Response, next: NextFunction) => Promise<void>;
export {};
//# sourceMappingURL=requireEntitlement.d.ts.map