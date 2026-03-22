import mongoose from 'mongoose';
import { Couple, ICouple, IOnboardingAnswer } from '../models/Couple.model';
import { User } from '../models/User.model';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import { Community } from '../models/Community.model';

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

    // 1. Update primary user's details (ALWAYS the one signing up/submitting)
    const primaryUpdate = await User.findByIdAndUpdate(primaryUserId, {
      name: data.yourName,
      dob: data.yourDob || undefined,
      email: data.yourEmail || undefined,
      role: 'primary' // Enforce role
    });
    logger.info(`[CoupleService.setupProfile] Primary user update: ${!!primaryUpdate} (${primaryUserId})`);

    // 2. Find and update the partner user
    const partner = await User.findOneAndUpdate(
      { coupleId, role: 'partner' },
      {
        name: data.partnerName,
        dob: data.partnerDob || undefined,
        email: data.partnerEmail || undefined,
      },
      { new: true }
    );
    logger.info(`[CoupleService.setupProfile] Partner user update: ${!!partner}`);

    // 3. Upsert the Couple document
    // We enforce: partner1 = PRIMARY (Boy), partner2 = PARTNER (Girl)
    const existingCouple = await Couple.findOne({ coupleId });
    if (!existingCouple) {
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
        partner1: primaryUserId, // Re-enforce alignment
        partner2: partner?._id ?? existingCouple.partner2,
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
  /**
   * Upload photos (dummy base64 logic — actual app would upload to Cloudinary or AWS S3)
   */
  async uploadPhotos(
    coupleId: string,
    data: { 
      primaryPhotoBase64?: string; 
      secondaryPhotosBase64?: string[]; 
      keepSecondaryPhotoUrls?: string[];
    }
  ) {
    const updateData: any = {};
    
    if (data.primaryPhotoBase64 && data.primaryPhotoBase64.length > 10) {
      const prefix = data.primaryPhotoBase64.startsWith('data:') ? '' : 'data:image/jpeg;base64,';
      updateData.primaryPhoto = prefix + data.primaryPhotoBase64;
    }

    // Identify which photos to keep vs which to add
    const existingToKeep = data.keepSecondaryPhotoUrls || [];
    const newPhotos = (data.secondaryPhotosBase64 || [])
      .filter(b64 => b64 && b64.length > 10)
      .map(b64 => (b64.startsWith('data:') ? b64 : 'data:image/jpeg;base64,' + b64));

    // Result is the combination of kept URLs and new base64s
    // NOTE: This replaces the previous secondaryPhotos array entirely with the new merged set
    if (data.keepSecondaryPhotoUrls !== undefined || data.secondaryPhotosBase64 !== undefined) {
      updateData.secondaryPhotos = [...existingToKeep, ...newPhotos].slice(0, 3);
    }

    await Couple.findOneAndUpdate({ coupleId }, { $set: updateData });
    logger.info(`[CoupleService] Photos saved for coupleId: ${coupleId}`);
  }

  /**
   * Submit questionnaire answers and mark onboarding COMPLETE
   */
  async submitAnswers(coupleId: string, answers: IOnboardingAnswer[]) {
    // 1. Mark as complete atomically first to avoid fetch/save races
    const coupleDoc = await Couple.findOneAndUpdate(
      { coupleId },
      { $set: { answers, isProfileComplete: true } },
      { new: true }
    );

    if (!coupleDoc) {
      throw new AppError('Couple not found', 404);
    }

    // ─── AI BIO GENERATION (BACKGROUND) ─────────────────────────────────────
    (async () => {
      try {
        const questionMap: Record<string, string> = {
          q1: 'Life Stage',
          q2: 'Couple Personality',
          q3: 'Favorite Activities',
          q4: 'Meeting Frequency',
          q5: 'What makes a good match',
          q6: 'Things to avoid',
        };

        const optionLabelMap: Record<string, string> = {
          'q1-career': 'Building careers (Work is a big part of our lives right now)',
          'q1-family': 'Family first (Home and the people in it are priority #1)',
          'q1-settled': 'Newly settled (Finding our footing in a new place)',
          'q1-living': 'Living it up (Making the most of our current stage)',
          'q2-hosts': "The Hosts (Prefer inviting people over vs going out)",
          'q2-yes-couple': "The 'yes' couple (Usually up for whatever is on)",
          'q2-planners': 'The Planners (Like to know what we are doing in advance)',
          'q2-explorers': 'The Explorers (Always looking for something new to try)',
          'q3-dinners-home': 'Dinners at home',
          'q3-restaurants': 'Exploring new restaurants',
          'q3-outdoor': 'Outdoor activities/nature',
          'q3-cultural': 'Cultural events/museums',
          'q3-drinks': 'Casual drinks',
          'q3-trips': 'Weekend trips/travel',
          'q4-once-month': 'Meeting once a month (Quality over quantity)',
          'q4-twice-month': 'Meeting twice a month',
          'q4-once-week': 'Meeting once a week (Very social)',
          'q4-when-fits': 'Meeting whenever it fits (Go with the flow)',
          'q5-similar-stage': 'Matches in a similar life stage',
          'q5-shared-interests': 'Shared interests',
          'q5-small-groups': 'Small group settings',
          'q5-structured-plans': 'Structured plans',
          'q5-clear-boundaries': 'Clear boundaries',
          'q5-weekend-availability': 'Weekend availability',
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
          const updateObj: any = {};
          if (aiResponse.bio) updateObj.bio = aiResponse.bio;
          if (aiResponse.matchCriteria && aiResponse.matchCriteria.length > 0) {
            updateObj['preferences.matchCriteria'] = aiResponse.matchCriteria;
          }
          await Couple.findOneAndUpdate({ coupleId }, { $set: updateObj });
          logger.info(`[CoupleService] AI bio background completion SUCCESS for ${coupleId}`);
        }
      } catch (aiErr) {
        logger.error(`[CoupleService] AI background generation failed:`, aiErr);
      }
    })();
    // ─────────────────────────────────────────────────────────────────────────

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
    },
    requestingUserId?: string
  ) {
    const coupleDoc = await Couple.findOne({ coupleId });
    if (!coupleDoc) throw new AppError('Couple not found', 404);

    if (data.bio !== undefined) coupleDoc.bio = data.bio;
    if (data.relationshipStatus !== undefined) coupleDoc.relationshipStatus = data.relationshipStatus;
    if (data.preferences !== undefined) coupleDoc.preferences = data.preferences;

    // Identify who is 'You' (submitter) vs 'Partner' for the incoming request
    const isPartner1Me = requestingUserId && coupleDoc.partner1?.toString() === requestingUserId.toString();
    const myId = isPartner1Me ? coupleDoc.partner1 : coupleDoc.partner2;
    const partnerId = isPartner1Me ? coupleDoc.partner2 : coupleDoc.partner1;

    // Update partner names for profile title (Always: Partner1 & Partner2)
    if (data.yourName || data.partnerName) {
      const [u1, u2] = await Promise.all([
        User.findById(coupleDoc.partner1).select('name'),
        User.findById(coupleDoc.partner2).select('name')
      ]);

      // p1 is always partner1 (Primary)
      let p1Name = isPartner1Me ? (data.yourName || u1?.name) : (data.partnerName || u1?.name);
      // p2 is always partner2 (Partner)
      let p2Name = isPartner1Me ? (data.partnerName || u2?.name) : (data.yourName || u2?.name);
      
      p1Name = p1Name || 'User 1';
      p2Name = p2Name || 'User 2';
      coupleDoc.profileName = `${p1Name} & ${p2Name}`;
    }

    // Save couple doc and update User records in parallel
    const updatePromises: Promise<any>[] = [coupleDoc.save()];

    // Update 'submitter'
    if (myId && (data.yourName || data.yourDob || data.yourEmail)) {
      updatePromises.push(User.findByIdAndUpdate(myId, {
        name: data.yourName || undefined,
        dob: data.yourDob || undefined,
        email: data.yourEmail || undefined,
      }));
    }

    // Update 'other partner'
    if (partnerId && (data.partnerName || data.partnerDob || data.partnerEmail)) {
      updatePromises.push(User.findByIdAndUpdate(partnerId, {
        name: data.partnerName || undefined,
        dob: data.partnerDob || undefined,
        email: data.partnerEmail || undefined,
      }));
    }

    await Promise.all(updatePromises);

    return coupleDoc;
  }

  async getCouple(coupleId: string): Promise<any | null> {
    // 1. Initial lookup to get the MongoDB _id for the community search
    const coupleBasic = await Couple.findOne({ coupleId }).select('_id').lean();
    if (!coupleBasic) return null;

    // 2. Parallelize population and community search
    const [couple, communityDocs] = await Promise.all([
      Couple.findById(coupleBasic._id)
        .populate('partner1', 'name phone dob email')
        .populate('partner2', 'name phone dob email')
        .lean(),
      Community.find({ members: coupleBasic._id })
        .select('name city description coverImageUrl')
        .lean()
    ]);

    if (!couple) return null;

    const communities = communityDocs.map(c => ({
      id: c._id,
      title: c.name,
      subtitle: c.city,
      note: c.description,
      imageUri: c.coverImageUrl
    }));

    return {
      ...couple,
      communities
    };
  }

  async subscribe(coupleId: string): Promise<ICouple | null> {
    const couple = await Couple.findOneAndUpdate(
      { coupleId },
      { isSubscribed: true },
      { new: true }
    );
    if (!couple) throw new AppError('Couple not found', 404);
    return couple;
  }

  async blockCouple(meMongoId: string, targetMongoId: string) {
    return Couple.findByIdAndUpdate(
      meMongoId,
      { $addToSet: { blocked: new mongoose.Types.ObjectId(targetMongoId) } },
      { new: true }
    );
  }

  async unblockCouple(meMongoId: string, targetMongoId: string) {
    return Couple.findByIdAndUpdate(
      meMongoId,
      { $pull: { blocked: new mongoose.Types.ObjectId(targetMongoId) } },
      { new: true }
    );
  }

  async getBlockedCouples(meMongoId: string) {
    const me = await Couple.findById(meMongoId)
      .populate({
        path: 'blocked',
        select: 'profileName primaryPhoto location coupleId'
      })
      .lean();
    return me?.blocked || [];
  }

  async deleteMyCouple(coupleId: string) {
    // 1. Delete all Users associated with this coupleId
    await User.deleteMany({ coupleId });
    // 2. Delete the Couple document
    await Couple.deleteOne({ coupleId });
    return { success: true };
  }
}

export const coupleService = new CoupleService();
