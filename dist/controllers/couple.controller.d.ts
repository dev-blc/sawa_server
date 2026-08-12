import { Request, Response } from 'express';
export declare const validateSetupProfile: (req: Request, _res: Response, next: import("express").NextFunction) => void;
export declare const validateUploadPhotos: (req: Request, _res: Response, next: import("express").NextFunction) => void;
export declare const validateSubmitAnswers: (req: Request, _res: Response, next: import("express").NextFunction) => void;
export declare const validateCompleteOnboarding: (req: Request, _res: Response, next: import("express").NextFunction) => void;
export declare const validateUpdateMyCouple: (req: Request, _res: Response, next: import("express").NextFunction) => void;
/**
 * POST /api/v1/couples/onboarding/profile
 * Saves name, dob, email for both primary and partner users,
 * and relationship status for the couple.
 * Lazily creates the Couple document if it doesn't exist.
 */
export declare const setupProfile: (req: Request, res: Response) => Promise<void>;
/**
 * POST /api/v1/couples/onboarding/photos
 * Simulates uploading base64 photos to a CDN/storage.
 */
export declare const uploadPhotos: (req: Request, res: Response) => Promise<void>;
/**
 * GET /api/v1/couples/onboarding/status
 * Returns the step the couple should resume onboarding from, derived purely
 * from the data already in the DB.  Safe to call on every login.
 */
export declare const getOnboardingStatus: (req: Request, res: Response) => Promise<void>;
/**
 * POST /api/v1/couples/onboarding/answers
 * Saves onboarding questionnaire answers and marks profile as complete.
 */
export declare const submitAnswers: (req: Request, res: Response) => Promise<void>;
/**
 * POST /api/v1/couples/onboarding/complete
 * Combines profile, photos, and answers in one single unified flow.
 */
export declare const completeOnboarding: (req: Request, res: Response) => Promise<void>;
export declare const createCouple: (_req: Request, _res: Response) => Promise<void>;
export declare const getMyCouple: (req: Request, res: Response) => Promise<void>;
export declare const updateMyCouple: (req: Request, res: Response) => Promise<void>;
export declare const invitePartner: (_req: Request, _res: Response) => Promise<void>;
/**
 * POST /api/v1/couples/subscribe
 *
 * LEGACY endpoint. It only flips the cosmetic `Couple.isSubscribed` flag used by
 * the pre-paywall "activate free access" flow while SUBSCRIPTIONS_ENFORCED is
 * off. It grants NO paid entitlement: real feature gating reads the verified
 * `Subscription` table (populated only via App Store / Play receipt
 * verification at /subscriptions/apple|google/verify), never this flag.
 *
 * Once real enforcement is enabled, this self-serve path is disabled so it can
 * never set a stale/unverified flag — clients must go through IAP verification.
 */
export declare const subscribe: (req: Request, res: Response) => Promise<void>;
export declare const getCoupleById: (req: Request, res: Response) => Promise<void>;
export declare const deleteMyAccount: (req: Request, res: Response) => Promise<void>;
export declare const getBlockList: (req: Request, res: Response) => Promise<void>;
export declare const blockCouple: (req: Request, res: Response) => Promise<void>;
export declare const unblockCouple: (req: Request, res: Response) => Promise<void>;
export declare const getBlockedCommunities: (req: Request, res: Response) => Promise<void>;
export declare const unblockCommunity: (req: Request, res: Response) => Promise<void>;
//# sourceMappingURL=couple.controller.d.ts.map