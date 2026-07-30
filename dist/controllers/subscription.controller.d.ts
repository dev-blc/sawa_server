import { Request, Response } from 'express';
/** GET /api/v1/subscriptions/me — current entitlement + usage counts. */
export declare const getMySubscription: (req: Request, res: Response) => Promise<void>;
/** POST /api/v1/subscriptions/trial — start the one-time 7-day PRIME trial. */
export declare const startTrialHandler: (req: Request, res: Response) => Promise<void>;
/**
 * POST /api/v1/subscriptions/apple/verify
 * Body: { transactionId }
 * The app calls this right after a successful StoreKit purchase/restore. We ask
 * Apple for the authoritative signed transaction, verify it, and set entitlement.
 */
export declare const verifyApple: (req: Request, res: Response) => Promise<void>;
/**
 * POST /api/v1/subscriptions/apple/notifications
 * App Store Server Notifications V2 webhook. Unauthenticated by design — Apple
 * signs the payload, and we cryptographically verify that signature before
 * trusting anything. Always 200 quickly so Apple doesn't retry-storm.
 */
export declare const appleNotifications: (req: Request, res: Response) => Promise<void>;
//# sourceMappingURL=subscription.controller.d.ts.map