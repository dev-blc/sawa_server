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
      location?: { city?: string; country?: string };
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
        location: data.location || { city: 'Unknown' },
        answers: [],
        secondaryPhotos: [],
        isProfileComplete: false,
      });
      logger.info(`[CoupleService.setupProfile] Couple document created for: ${coupleId}`);
    } else {
      await Couple.findByIdAndUpdate(existingCouple._id, {
        profileName: `${data.yourName} & ${data.partnerName}`,
        relationshipStatus: data.relationshipStatus,
        location: data.location || undefined,
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
        q1: 'Life Stage',
        q2: 'Couple Personality',
        q3: 'Favorite Activities',
        q4: 'Meeting Frequency',
        q5: 'What makes a good match',
        q6: 'Things to avoid',
      };

      // Map option IDs to friendly labels for better LLM context
      // Including subtitles/descriptions where they add significant flavor
      const optionLabelMap: Record<string, string> = {
        // Q1: Life Stage
        'q1-career': 'Building careers (Work is a big part of our lives right now)',
        'q1-family': 'Family first (Home and the people in it are priority #1)',
        'q1-settled': 'Newly settled (Finding our footing in a new place)',
        'q1-living': 'Living it up (Making the most of our current stage)',
        // Q2: Personality
        'q2-hosts': "The Hosts (Prefer inviting people over vs going out)",
        'q2-yes-couple': "The 'yes' couple (Usually up for whatever is on)",
        'q2-planners': 'The Planners (Like to know what we are doing in advance)',
        'q2-explorers': 'The Explorers (Always looking for something new to try)',
        // Q3: Activities
        'q3-dinners-home': 'Dinners at home',
        'q3-restaurants': 'Exploring new restaurants',
        'q3-outdoor': 'Outdoor activities/nature',
        'q3-cultural': 'Cultural events/museums',
        'q3-drinks': 'Casual drinks',
        'q3-trips': 'Weekend trips/travel',
        // Q4: Frequency
        'q4-once-month': 'Meeting once a month (Quality over quantity)',
        'q4-twice-month': 'Meeting twice a month',
        'q4-once-week': 'Meeting once a week (Very social)',
        'q4-when-fits': 'Meeting whenever it fits (Go with the flow)',
        // Q5: Good Match
        'q5-similar-stage': 'Matches in a similar life stage',
        'q5-shared-interests': 'Shared interests',
        'q5-small-groups': 'Small group settings',
        'q5-structured-plans': 'Structured plans',
        'q5-clear-boundaries': 'Clear boundaries',
        'q5-weekend-availability': 'Weekend availability',
        // Q6: Avoid
        'q6-late-night': 'Avoiding late-night plans',
        'q6-large-groups': 'Avoiding very large groups',
        'q6-alcohol-centric': 'Avoiding alcohol-centric meetups',
        'q6-last-minute': 'Avoiding last-minute/spontaneous plans',
      };

      const qaData = answers.map((a) => ({
        question: questionMap[a.questionId] || 'About us',
        answers: a.selectedOptionIds.map(id => optionLabelMap[id] || id),
      }));

      const { generateCoupleBio } = require('../utils/ai');
      const aiResponse = await generateCoupleBio(qaData);

      if (aiResponse) {
        if (aiResponse.bio) coupleDoc.bio = aiResponse.bio;
        if (aiResponse.matchCriteria && aiResponse.matchCriteria.length > 0) {
          if (!coupleDoc.preferences) coupleDoc.preferences = {};
          coupleDoc.preferences.matchCriteria = aiResponse.matchCriteria;
        }
        logger.info(`[CoupleService] AI bio & criteria generated for ${coupleId}`);
      }
    } catch (aiErr) {
      logger.error(`[CoupleService] AI generation failed (non-critical):`, aiErr);
    }
    // ─────────────────────────────────────────────────────────────────────────

    await coupleDoc.save();
    logger.info(`[CoupleService] Onboarding complete for coupleId: ${coupleId}`);
  }

  async updateProfile(
    coupleId: string,
    data: {
      bio?: string;
      relationshipStatus?: string;
      preferences?: any;
      yourName?: string;
      yourDob?: string;
      yourEmail?: string;
      partnerName?: string;
      partnerDob?: string;
      partnerEmail?: string;
    }
  ) {
    const coupleDoc = await Couple.findOne({ coupleId });
    if (!coupleDoc) throw new AppError('Couple not found', 404);

    if (data.bio !== undefined) coupleDoc.bio = data.bio;
    if (data.relationshipStatus !== undefined) coupleDoc.relationshipStatus = data.relationshipStatus;
    if (data.preferences !== undefined) coupleDoc.preferences = data.preferences;

    // Update partner names if provided
    if (data.yourName || data.partnerName) {
      const p1Name = data.yourName || (await User.findById(coupleDoc.partner1))?.name || 'Partner 1';
      const p2Name = data.partnerName || (await User.findById(coupleDoc.partner2))?.name || 'Partner 2';
      coupleDoc.profileName = `${p1Name} & ${p2Name}`;
    }

    await coupleDoc.save();

    // Update individual User records
    if (coupleDoc.partner1 && (data.yourName || data.yourDob || data.yourEmail)) {
      await User.findByIdAndUpdate(coupleDoc.partner1, {
        name: data.yourName,
        dob: data.yourDob,
        email: data.yourEmail,
      });
    }

    if (coupleDoc.partner2 && (data.partnerName || data.partnerDob || data.partnerEmail)) {
      await User.findByIdAndUpdate(coupleDoc.partner2, {
        name: data.partnerName,
        dob: data.partnerDob,
        email: data.partnerEmail,
      });
    }

    return coupleDoc;
  }

  async getCouple(coupleId: string): Promise<ICouple | null> {
    return Couple.findOne({ coupleId })
      .populate('partner1', 'name phone dob email')
      .populate('partner2', 'name phone dob email')
      .exec();
  }
}

export const coupleService = new CoupleService();
