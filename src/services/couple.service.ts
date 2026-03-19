import { Couple, ICouple, IOnboardingAnswer } from '../models/Couple.model';
import { User } from '../models/User.model';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

export class CoupleService {
  /**
   * Upsert the couple document and update both users' details
   */
  async setupProfile(
    primaryUserId: string,
    coupleId: string,
    data: {
      yourName: string;
      yourDob?: string;
      yourEmail?: string;
      partnerName: string;
      partnerDob?: string;
      partnerEmail?: string;
      relationshipStatus?: string;
    }
  ) {
    logger.info(`[CoupleService.setupProfile] START - coupleId: ${coupleId}`);

    // 1. Update primary user's details
    const primaryUpdate = await User.findByIdAndUpdate(primaryUserId, {
      name: data.yourName,
      dob: data.yourDob || undefined,
      email: data.yourEmail || undefined,
    });
    logger.info(`[CoupleService.setupProfile] Primary user update: ${!!primaryUpdate} (${primaryUserId})`);

    // 2. Find and update the partner user
    const partnerUpdate = await User.findOneAndUpdate(
      { coupleId, role: 'partner' },
      {
        name: data.partnerName,
        dob: data.partnerDob || undefined,
        email: data.partnerEmail || undefined,
      }
    );
    logger.info(`[CoupleService.setupProfile] Partner user update: ${!!partnerUpdate}`);

    // 3. Upsert the Couple document
    const existingCouple = await Couple.findOne({ coupleId });
    if (!existingCouple) {
      const partner = await User.findOne({ coupleId, role: 'partner' });
      await Couple.create({
        coupleId,
        partner1: primaryUserId,
        partner2: partner?._id ?? null,
        profileName: `${data.yourName} & ${data.partnerName}`,
        relationshipStatus: data.relationshipStatus,
        answers: [],
        secondaryPhotos: [],
        isProfileComplete: false,
      });
      logger.info(`[CoupleService.setupProfile] Couple document created for: ${coupleId}`);
    } else {
      await Couple.findByIdAndUpdate(existingCouple._id, {
        profileName: `${data.yourName} & ${data.partnerName}`,
        relationshipStatus: data.relationshipStatus,
      });
      logger.info(`[CoupleService.setupProfile] Existing Couple document updated: ${existingCouple._id}`);
    }
  }

  /**
   * Upload photos (dummy base64 logic — actual app would upload to Cloudinary or AWS S3)
   * Instead of saving raw base64 in Mongo (too large), we just pretend and save a fake URL.
   */
  async uploadPhotos(
    coupleId: string,
    data: { primaryPhotoBase64?: string; secondaryPhotosBase64?: string[] }
  ) {
    const coupleDoc = await Couple.findOne({ coupleId });
    if (!coupleDoc) {
      throw new AppError('Couple not found (setup profile first)', 404);
    }

    if (data.primaryPhotoBase64 && data.primaryPhotoBase64.length > 10) {
      // Check if it's already a data URI or raw base64
      const prefix = data.primaryPhotoBase64.startsWith('data:') ? '' : 'data:image/jpeg;base64,';
      coupleDoc.primaryPhoto = prefix + data.primaryPhotoBase64;
    }

    if (data.secondaryPhotosBase64 && data.secondaryPhotosBase64.length > 0) {
      coupleDoc.secondaryPhotos = data.secondaryPhotosBase64
        .filter(b64 => b64 && b64.length > 10)
        .map(b64 => (b64.startsWith('data:') ? b64 : 'data:image/jpeg;base64,' + b64));
    }

    await coupleDoc.save();
    logger.info(`[CoupleService] Photos saved for coupleId: ${coupleId}`);
  }

  /**
   * Submit questionnaire answers and mark onboarding COMPLETE
   */
  async submitAnswers(coupleId: string, answers: IOnboardingAnswer[]) {
    const coupleDoc = await Couple.findOne({ coupleId })
      .populate('partner1')
      .populate('partner2');

    if (!coupleDoc) {
      throw new AppError('Couple not found', 404);
    }

    coupleDoc.answers = answers;
    coupleDoc.isProfileComplete = true; // Onboarding is officially complete

    // ─── AI BIO GENERATION ──────────────────────────────────────────────────
    try {
      logger.info(`[CoupleService] Generating AI bio for coupleId: ${coupleId}`);

      // We'll map the answers to a text format for the AI
      // In a real app, you'd fetch the actual question text here.
      // For now, we'll use a placeholder mapping based on question IDs.
      const questionMap: Record<string, string> = {
        q1: 'What is your current focus as a couple?',
        q2: 'What kind of social activities do you enjoy?',
        q3: 'What are you looking for on SAWA?',
        q4: 'How would you describe your weekend vibe?',
      };

      const qaData = answers.map((a) => ({
        question: questionMap[a.questionId] || 'About us',
        answers: a.selectedOptionIds,
      }));

      const { generateCoupleBio } = require('../utils/ai');
      const aiBio = await generateCoupleBio(qaData);

      if (aiBio) {
        coupleDoc.bio = aiBio;
        logger.info(`[CoupleService] AI bio generated successfully for ${coupleId}`);
      }
    } catch (aiErr) {
      logger.error(`[CoupleService] AI bio generation failed (non-critical):`, aiErr);
    }
    // ─────────────────────────────────────────────────────────────────────────

    await coupleDoc.save();
    logger.info(`[CoupleService] Onboarding complete for coupleId: ${coupleId}`);
  }

  async getCouple(coupleId: string): Promise<ICouple | null> {
    return Couple.findOne({ coupleId })
      .populate('partner1', 'name phone dob email')
      .populate('partner2', 'name phone dob email')
      .exec();
  }
}

export const coupleService = new CoupleService();
