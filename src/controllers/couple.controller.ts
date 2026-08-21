import { Request, Response } from 'express';
import { z } from 'zod';
import { coupleService } from '../services/couple.service';
import { prisma } from '../lib/prisma';
import { sendSuccess } from '../utils/response';
import { validate } from '../middleware/validate';
import { AppError } from '../utils/AppError';
import { isEnforced } from '../config/subscription';
import { ageFromDobString } from '../utils/age';
import {
  getCachedCoupleProfile,
  setCachedCoupleProfile,
  invalidateCoupleProfile,
} from '../lib/cache';

// ─── Onboarding step derivation ─────────────────────────────────────────────
/**
 * Derives the onboarding step a couple should resume from, based on what's
 * already persisted in the DB. No extra DB fields required.
 *
 * Steps (in order):
 *   OnboardingLanguage → ProfileSetup → StoryPhoto → Question →
 *   PermissionRequest → Complete
 */
function deriveOnboardingStep(couple: {
  profileName: string | null;
  partner1Id: string | null;
  primaryPhoto: string | null;
  isProfileComplete: boolean;
  answers: { id: string }[];
}): string {
  if (couple.isProfileComplete) return 'Complete';

  // Answers saved → ready for PermissionRequest ("I'm in!" screen)
  if (couple.answers && couple.answers.length > 0) return 'PermissionRequest';

  // Primary photo saved → ready for Question
  if (couple.primaryPhoto) return 'Question';

  // Profile name set (not the default) AND partner linked → ready for StoryPhoto
  const hasRealName = couple.profileName &&
    couple.profileName !== 'Sawa Couple' &&
    couple.profileName.trim().length > 0;
  if (hasRealName && couple.partner1Id) return 'StoryPhoto';

  // Nothing saved yet — start from language selection
  return 'OnboardingLanguage';
}

// ─── Validation ─────────────────────────────────────────────────────────────

// `ageFromDobString` now lives in `src/utils/age.ts` (shared with the couple
// service's public-card age derivation) so the DOB parsing rules can never drift
// between the 18+ gate and the profile card (RULES §7 DRY).

// Optional DOB that, WHEN present and parseable, must be >= 18 (Sawa is 18+).
// Server-side backstop for the client age gate. Empty / absent / unparseable
// values pass through so older app builds that omit DOB aren't broken; only a
// clearly-parseable under-18 date is rejected.
const optionalAdultDob = z
  .string()
  .optional()
  .or(z.literal(''))
  .refine(
    (v) => {
      if (!v) return true;
      const age = ageFromDobString(v);
      return age === null || age >= 18;
    },
    { message: 'You must be 18 or older to use Sawa' },
  );

const SetupProfileSchema = z.object({
  yourName: z.string().min(1, 'Your name is required'),
  yourEmail: z.string().optional().or(z.literal('')),
  yourDob: optionalAdultDob,
  partnerName: z.string().min(1, "Partner's name is required"),
  partnerEmail: z.string().optional().or(z.literal('')),
  partnerDob: optionalAdultDob,
  relationshipStatus: z.string().optional(),
  location: z.object({
    city: z.string().optional(),
    country: z.string().optional(),
  }).optional(),
});

const UploadPhotosSchema = z.object({
  primaryPhotoBase64: z.string().optional(),
  secondaryPhotosBase64: z.array(z.string()).max(3).optional(),
  keepSecondaryPhotoUrls: z.array(z.string()).optional(),
  // Explicit removal — an ABSENT primaryPhotoBase64 means "keep", so the
  // client's ✕-then-save used to be a silent no-op reported as success.
  removePrimaryPhoto: z.boolean().optional(),
});

const SubmitAnswersSchema = z.object({
  answers: z.array(
    z.object({
      questionId: z.string(),
      selectedOptionIds: z.array(z.string()),
    })
  ),
});

const CompleteOnboardingSchema = z.object({
  // Profile fields are optional — each step saves data to the server immediately,
  // so a reinstall scenario (no local cache) still works because the DB already
  // has the data from earlier steps.  We only call setupProfile when names are present.
  yourName: z.string().min(1).optional().or(z.literal('')),
  yourEmail: z.string().optional().or(z.literal('')),
  yourDob: optionalAdultDob,
  partnerName: z.string().min(1).optional().or(z.literal('')),
  partnerEmail: z.string().optional().or(z.literal('')),
  partnerDob: optionalAdultDob,
  relationshipStatus: z.string().optional(),
  primaryPhotoBase64: z.string().optional(),
  secondaryPhotosBase64: z.array(z.string()).max(3).optional(),
  answers: z.array(
    z.object({
      questionId: z.string(),
      selectedOptionIds: z.array(z.string()),
    })
  ).optional().default([]),
  location: z.object({
    city: z.string().optional(),
    country: z.string().optional(),
  }).optional(),
});
 
const UpdateMyCoupleSchema = z.object({
  bio: z.string().optional(),
  relationshipStatus: z.string().optional(),
  isOpenToMeeting: z.boolean().optional(),
  preferences: z.any().optional(),
  activities: z.array(z.string()).optional(),
  matchCriteria: z.union([z.string(), z.array(z.string())]).optional(),
  yourName: z.string().optional(),
  yourDob: z.string().optional(),
  yourEmail: z.string().optional(),
  partnerName: z.string().optional(),
  partnerDob: z.string().optional(),
  partnerEmail: z.string().optional(),
  location: z
    .object({
      city: z.string().optional(),
      country: z.string().optional(),
    })
    .optional(),
  locationCity: z.string().optional(),
  locationCountry: z.string().optional(),
  locationLatitude: z.number().optional(),
  locationLongitude: z.number().optional(),
});

export const validateSetupProfile = validate(SetupProfileSchema);
export const validateUploadPhotos = validate(UploadPhotosSchema);
export const validateSubmitAnswers = validate(SubmitAnswersSchema);
export const validateCompleteOnboarding = validate(CompleteOnboardingSchema);
export const validateUpdateMyCouple = validate(UpdateMyCoupleSchema);

// ─── Controllers ────────────────────────────────────────────────────────────

/**
 * POST /api/v1/couples/onboarding/profile
 * Saves name, dob, email for both primary and partner users, 
 * and relationship status for the couple.
 * Lazily creates the Couple document if it doesn't exist.
 */
export const setupProfile = async (req: Request, res: Response) => {
  const { userId, coupleId } = req.user!;
  const data = req.body as z.infer<typeof SetupProfileSchema>;

  await coupleService.setupProfile(userId, coupleId!, data);

  sendSuccess({ res, statusCode: 200, message: 'Profile details saved' });
};

/**
 * POST /api/v1/couples/onboarding/photos
 * Simulates uploading base64 photos to a CDN/storage.
 */
export const uploadPhotos = async (req: Request, res: Response) => {
  const { coupleId } = req.user!;
  const data = req.body as z.infer<typeof UploadPhotosSchema>;

  await coupleService.uploadPhotos(coupleId!, data);
  await invalidateCoupleProfile(coupleId!);

  sendSuccess({ res, statusCode: 200, message: 'Photos uploaded successfully' });
};

/**
 * GET /api/v1/couples/onboarding/status
 * Returns the step the couple should resume onboarding from, derived purely
 * from the data already in the DB.  Safe to call on every login.
 */
export const getOnboardingStatus = async (req: Request, res: Response) => {
  const { coupleId, userId } = req.user!;

  const couple = await prisma.couple.findUnique({
    where: { coupleId: coupleId! },
    select: {
      profileName: true,
      partner1Id: true,
      partner2Id: true,
      primaryPhoto: true,
      relationshipStatus: true,
      isProfileComplete: true,
      answers: { select: { id: true } },
      partner1: { select: { id: true, name: true, dob: true, email: true } },
      partner2: { select: { id: true, name: true, dob: true, email: true } },
    },
  });

  if (!couple) {
    throw new AppError('Couple not found', 404);
  }

  const step = deriveOnboardingStep(couple);

  // Return partial profile data so the client can pre-fill onboarding forms
  // after a reinstall without asking the user to retype everything.
  // "your" = the logged-in user, "partner" = the other person.
  const isPartner1 = couple.partner1Id === userId;
  const me = isPartner1 ? couple.partner1 : couple.partner2;
  const other = isPartner1 ? couple.partner2 : couple.partner1;

  const resumeData = {
    step,
    isComplete: couple.isProfileComplete,
    profile: {
      profileName: couple.profileName,
      relationshipStatus: couple.relationshipStatus,
      yourName: me?.name ?? null,
      yourDob: me?.dob ?? null,
      yourEmail: me?.email ?? null,
      partnerName: other?.name ?? null,
      partnerDob: other?.dob ?? null,
      partnerEmail: other?.email ?? null,
    },
    hasPhoto: !!couple.primaryPhoto,
    hasAnswers: (couple.answers?.length ?? 0) > 0,
    userId,
  };

  sendSuccess({ res, data: resumeData });
};

/**
 * POST /api/v1/couples/onboarding/answers
 * Saves onboarding questionnaire answers and marks profile as complete.
 */
export const submitAnswers = async (req: Request, res: Response) => {
  const { coupleId } = req.user!;
  const data = req.body as z.infer<typeof SubmitAnswersSchema>;

  await coupleService.submitAnswers(coupleId!, data.answers);
  await invalidateCoupleProfile(coupleId!);

  sendSuccess({ res, statusCode: 200, message: 'Onboarding completed successfully' });
};

/**
 * POST /api/v1/couples/onboarding/complete
 * Combines profile, photos, and answers in one single unified flow.
 */
export const completeOnboarding = async (req: Request, res: Response) => {
  const { userId, coupleId } = req.user!;
  const data = req.body as z.infer<typeof CompleteOnboardingSchema>;

  console.log(`[CoupleController] completeOnboarding START for coupleId: ${coupleId}`);

  try {
    // 1. Only run setupProfile when names are present in the payload.
    //    Each onboarding step already saves to the server immediately, so on a
    //    reinstall the profile data lives in the DB — we just skip re-saving it.
    const hasProfileData = data.yourName && data.yourName.trim().length > 0
      && data.partnerName && data.partnerName.trim().length > 0;

    if (hasProfileData) {
      await coupleService.setupProfile(userId, coupleId!, data as any);
    } else {
      console.log(`[CoupleController] completeOnboarding: no profile names in payload — skipping setupProfile (reinstall scenario)`);
    }

    // 2. Parallelize photo and answer saves (both are idempotent / additive).
    const tasks: Promise<any>[] = [];
    if (data.primaryPhotoBase64 || (data.secondaryPhotosBase64 && data.secondaryPhotosBase64.length > 0)) {
      tasks.push(coupleService.uploadPhotos(coupleId!, data));
    }
    if (data.answers && data.answers.length > 0) {
      tasks.push(coupleService.submitAnswers(coupleId!, data.answers));
    }
    if (tasks.length > 0) await Promise.all(tasks);

    // 3. Always mark the profile as complete — this is the authoritative step.
    await prisma.couple.update({
      where: { coupleId: coupleId! },
      data: { isProfileComplete: true },
    });
    await invalidateCoupleProfile(coupleId!);

    // 4. Fetch the final profile to return to the client.
    const couple = await coupleService.getCouple(coupleId!);

    console.log(`[CoupleController] completeOnboarding SUCCESS for coupleId: ${coupleId}`);
    sendSuccess({ 
      res, 
      statusCode: 200, 
      message: 'All Onboarding data completed successfully',
      data: { couple } 
    });
  } catch (err) {
    console.error(`[CoupleController] completeOnboarding FAILED:`, err);
    throw err;
  }
};

export const createCouple = async (_req: Request, _res: Response) => {
  // Stub for legacy API
};

export const getMyCouple = async (req: Request, res: Response) => {
  const { coupleId, userId } = req.user!;

  // Serve from cache when available (invalidated by updateMyCouple, uploadPhotos, etc.)
  const cached = await getCachedCoupleProfile(coupleId!);
  if (cached) {
    sendSuccess({ res, data: { couple: cached, userId } });
    return;
  }

  const couple = await coupleService.getCouple(coupleId!);
  if (!couple) {
    throw new AppError('Couple profile not found', 404);
  }

  // Populate cache for subsequent calls within the TTL.
  await setCachedCoupleProfile(coupleId!, couple);

  sendSuccess({ res, data: { couple, userId } });
};

export const updateMyCouple = async (req: Request, res: Response) => {
  const { coupleId, userId } = req.user!;
  const data = req.body as any;

  const { couple, emailConflict } = await coupleService.updateProfile(coupleId!, data, userId);

  // Update cache immediately so next GET returns fresh data.
  if (couple) await setCachedCoupleProfile(coupleId!, couple);
  else await invalidateCoupleProfile(coupleId!);

  // emailConflict: the profile saved but a requested email was already taken
  // and kept unchanged. The client shows this — a silent skip behind
  // "Profile updated successfully" was invisible data loss.
  sendSuccess({
    res,
    statusCode: 200,
    message: 'Profile updated successfully',
    data: { couple, ...(emailConflict ? { emailConflict: true } : {}) },
  });
};

export const invitePartner = async (_req: Request, _res: Response) => {
  // Stub for partner invite features (if needed later)
};

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
export const subscribe = async (req: Request, res: Response) => {
  if (isEnforced()) {
    throw new AppError(
      'This endpoint is no longer available. Purchase Sawa Prime through the app.',
      410,
    );
  }

  const { coupleId } = req.user!;
  const couple = await coupleService.subscribe(coupleId!);

  sendSuccess({
    res,
    statusCode: 200,
    message: 'Subscription activated. First month is on us!',
    data: { couple },
  });
};

export const getCoupleById = async (req: Request, res: Response) => {
  const { id } = req.params;
  // Use lightweight summary — public profile view doesn't need communityMembers or answers
  const couple = await coupleService.getCoupleSummary(id);
  if (!couple) {
    throw new AppError('Couple profile not found', 404);
  }
  sendSuccess({ res, data: { couple } });
};

export const deleteMyAccount = async (req: Request, res: Response): Promise<void> => {
   const { coupleId } = req.user!;
   await coupleService.deleteMyCouple(coupleId!);
   sendSuccess({ res, statusCode: 200, message: 'Account deleted successfully' });
};
 
export const getBlockList = async (req: Request, res: Response): Promise<void> => {
   const { coupleMongoId } = req.user!;
   const blocked = await coupleService.getBlockedCouples(coupleMongoId ?? req.user!.coupleId!);
   sendSuccess({ res, statusCode: 200, data: { blocked } });
};
 
export const blockCouple = async (req: Request, res: Response): Promise<void> => {
   const { coupleMongoId } = req.user!;
   const { targetCoupleId } = req.body; // target couple's MONGO _id
   await coupleService.blockCouple(coupleMongoId ?? req.user!.coupleId!, targetCoupleId);
   sendSuccess({ res, statusCode: 200, message: 'Couple blocked' });
};
 
export const unblockCouple = async (req: Request, res: Response): Promise<void> => {
   const { coupleMongoId } = req.user!;
   const { targetCoupleId } = req.body; // target couple's MONGO _id
   await coupleService.unblockCouple(coupleMongoId ?? req.user!.coupleId!, targetCoupleId);
   sendSuccess({ res, statusCode: 200, message: 'Couple unblocked' });
};

export const getBlockedCommunities = async (req: Request, res: Response): Promise<void> => {
   const { coupleMongoId } = req.user!;
   const communities = await coupleService.getBlockedCommunities(coupleMongoId!);
   sendSuccess({ res, statusCode: 200, data: { communities } });
};

export const unblockCommunity = async (req: Request, res: Response): Promise<void> => {
   const { coupleMongoId } = req.user!;
   const { communityId } = req.body;
   await coupleService.unblockCommunity(coupleMongoId!, communityId);
   sendSuccess({ res, statusCode: 200, message: 'Community unblocked' });
};
