import { Request, Response } from 'express';
import { z } from 'zod';
import { coupleService } from '../services/couple.service';
import { sendSuccess } from '../utils/response';
import { validate } from '../middleware/validate';
import { AppError } from '../utils/AppError';

// ─── Validation ─────────────────────────────────────────────────────────────

const SetupProfileSchema = z.object({
  yourName: z.string().min(1, 'Your name is required'),
  yourEmail: z.string().email('Invalid email').optional().or(z.literal('')),
  yourDob: z.string().optional().or(z.literal('')),
  partnerName: z.string().min(1, "Partner's name is required"),
  partnerEmail: z.string().email('Invalid email').optional().or(z.literal('')),
  partnerDob: z.string().optional().or(z.literal('')),
  relationshipStatus: z.string().optional(),
});

const UploadPhotosSchema = z.object({
  primaryPhotoBase64: z.string().optional(),
  secondaryPhotosBase64: z.array(z.string()).max(3).optional(),
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
  yourEmail: z.string().email('Invalid email').optional().or(z.literal('')),
  yourDob: z.string().optional().or(z.literal('')),
  partnerName: z.string().min(1, "Partner's name is required"),
  partnerEmail: z.string().email('Invalid email').optional().or(z.literal('')),
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
});

export const validateSetupProfile = validate(SetupProfileSchema);
export const validateUploadPhotos = validate(UploadPhotosSchema);
export const validateSubmitAnswers = validate(SubmitAnswersSchema);
export const validateCompleteOnboarding = validate(CompleteOnboardingSchema);

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

  sendSuccess({ res, statusCode: 200, message: 'Photos uploaded successfully' });
};

/**
 * POST /api/v1/couples/onboarding/answers
 * Saves onboarding questionnaire answers and marks profile as complete.
 */
export const submitAnswers = async (req: Request, res: Response) => {
  const { coupleId } = req.user!;
  const data = req.body as z.infer<typeof SubmitAnswersSchema>;

  await coupleService.submitAnswers(coupleId!, data.answers);

  sendSuccess({ res, statusCode: 200, message: 'Onboarding completed successfully' });
};

/**
 * POST /api/v1/couples/onboarding/complete
 * Combines profile, photos, and answers in one single unified flow.
 */
export const completeOnboarding = async (req: Request, res: Response) => {
  const { userId, coupleId } = req.user!;
  const data = req.body as z.infer<typeof CompleteOnboardingSchema>;

  await coupleService.setupProfile(userId, coupleId!, data);
  await coupleService.uploadPhotos(coupleId!, data);
  await coupleService.submitAnswers(coupleId!, data.answers);

  sendSuccess({ res, statusCode: 200, message: 'All Onboarding data completed successfully' });
};

export const createCouple = async (_req: Request, _res: Response) => {
  // Stub for legacy API
};

export const getMyCouple = async (req: Request, res: Response) => {
  const { coupleId } = req.user!;
  const couple = await coupleService.getCouple(coupleId!);
  if (!couple) {
    throw new AppError('Couple profile not found', 404);
  }
  sendSuccess({ res, data: { couple } });
};

export const updateMyCouple = async (_req: Request, _res: Response) => {
  // Stub for Phase 2 settings updates
};

export const invitePartner = async (_req: Request, _res: Response) => {
  // Stub for partner invite features (if needed later)
};
