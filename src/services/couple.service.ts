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
    // 1. Update primary user's details
    await User.findByIdAndUpdate(primaryUserId, {
      name: data.yourName,
      dob: data.yourDob || undefined,
      email: data.yourEmail || undefined,
    });

    // 2. Find and update the partner user attached to the same coupleId
    // The partner could theoretically not be fully onboarded yet, but the user document exists from OTP send
    await User.findOneAndUpdate(
      { coupleId, role: 'partner' },
      {
        name: data.partnerName,
        dob: data.partnerDob || undefined,
        email: data.partnerEmail || undefined,
      }
    );

    // 3. Upsert the Couple document itself (first onboarding step)
    const existingCouple = await Couple.findOne({ coupleId });
    if (!existingCouple) {
      // Find the partner to link object IDs
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
      logger.info(`[CoupleService] Couple doc created for coupleId: ${coupleId}`);
    } else {
      await Couple.findByIdAndUpdate(existingCouple._id, {
        profileName: `${data.yourName} & ${data.partnerName}`,
        relationshipStatus: data.relationshipStatus,
      });
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
    const coupleDoc = await Couple.findOne({ coupleId });
    if (!coupleDoc) {
      throw new AppError('Couple not found', 404);
    }

    coupleDoc.answers = answers;
    coupleDoc.isProfileComplete = true; // Onboarding is officially complete
    
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
