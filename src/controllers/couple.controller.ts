import { Request, Response } from 'express';
import { z } from 'zod';
import { coupleService } from '../services/couple.service';
import { prisma } from '../lib/prisma';
import { sendSuccess } from '../utils/response';
import { validate } from '../middleware/validate';
import { AppError } from '../utils/AppError';
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

const SetupProfileSchema = z.object({
  yourName: z.string().min(1, 'Your name is required'),
  yourEmail: z.string().optional().or(z.literal('')),
  yourDob: z.string().optional().or(z.literal('')),
  partnerName: z.string().min(1, "Partner's name is required"),
  partnerEmail: z.string().optional().or(z.literal('')),
  partnerDob: z.string().optional().or(z.literal('')),
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
  yourName: z.string().min(1, 'Your name is required'),
  yourEmail: z.string().optional().or(z.literal('')),
  yourDob: z.string().optional().or(z.literal('')),
  partnerName: z.string().min(1, "Partner's name is required"),
  partnerEmail: z.string().optional().or(z.literal('')),
  partnerDob: z.string().optional().or(z.literal('')),
  relationshipStatus: z.string().optional(),
  primaryPhotoBase64: z.string().optional(),
  secondaryPhotosBase64: z.array(z.string()).max(3).optional(),
  answers: z.array(
    z.object({
      questionId: z.string(),
      selectedOptionIds: z.array(z.string()),
    })
  ),
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
  const resumeData = {
    step,
    isComplete: couple.isProfileComplete,
    profile: {
      profileName: couple.profileName,
      relationshipStatus: couple.relationshipStatus,
      yourName: couple.partner1?.name ?? null,
      yourDob: couple.partner1?.dob ?? null,
      yourEmail: couple.partner1?.email ?? null,
      partnerName: couple.partner2?.name ?? null,
      partnerDob: couple.partner2?.dob ?? null,
      partnerEmail: couple.partner2?.email ?? null,
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
    // 1. First ensure the couple profile exists (Sequential because others depend on it)
    await coupleService.setupProfile(userId, coupleId!, data);

    // 2. Parallelize photo processing and answers (These only update existing fields)
    await Promise.all([
       coupleService.uploadPhotos(coupleId!, data),
       coupleService.submitAnswers(coupleId!, data.answers)
    ]);

    // 3. Fetch final updated profile to return
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

  const couple = await coupleService.updateProfile(coupleId!, data, userId);

  // Update cache immediately so next GET returns fresh data.
  if (couple) await setCachedCoupleProfile(coupleId!, couple);
  else await invalidateCoupleProfile(coupleId!);

  sendSuccess({ res, statusCode: 200, message: 'Profile updated successfully', data: { couple } });
};

export const invitePartner = async (_req: Request, _res: Response) => {
  // Stub for partner invite features (if needed later)
};

/**
 * POST /api/v1/couples/subscribe
 * Marks the current couple as subscribed.
 */
export const subscribe = async (req: Request, res: Response) => {
  const { coupleId } = req.user!;
  const couple = await coupleService.subscribe(coupleId!);
  
  sendSuccess({ 
    res, 
    statusCode: 200, 
    message: 'Subscription activated. First month is on us!',
    data: { couple }
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
   const blocked = await coupleService.getBlockedCouples(coupleMongoId!);
   sendSuccess({ res, statusCode: 200, data: { blocked } });
};
 
export const blockCouple = async (req: Request, res: Response): Promise<void> => {
   const { coupleMongoId } = req.user!;
   const { targetCoupleId } = req.body; // target couple's MONGO _id
   await coupleService.blockCouple(coupleMongoId!, targetCoupleId);
   sendSuccess({ res, statusCode: 200, message: 'Couple blocked' });
};
 
export const unblockCouple = async (req: Request, res: Response): Promise<void> => {
   const { coupleMongoId } = req.user!;
   const { targetCoupleId } = req.body; // target couple's MONGO _id
   await coupleService.unblockCouple(coupleMongoId!, targetCoupleId);
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
