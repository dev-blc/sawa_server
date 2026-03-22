import { prisma } from '../lib/prisma';
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
    // 0. Preliminary validation: Ensure both emails are not the same
    if (data.yourEmail && data.partnerEmail && data.yourEmail.toLowerCase() === data.partnerEmail.toLowerCase()) {
        logger.warn(`[CoupleService.setupProfile] Partners attempted to use same email: ${data.yourEmail}`);
    }

    let partner = null;
    
    // 1. Update primary user's details (Non-blocking on email conflict)
    try {
      await prisma.user.update({
        where: { id: primaryUserId },
        data: {
          name: data.yourName,
          dob: data.yourDob || undefined,
          email: data.yourEmail || undefined,
          role: 'primary'
        }
      });
    } catch (err: any) {
        if (err.code === 'P2002' && err.meta?.target?.includes('email')) {
            logger.warn(`[CoupleService.setupProfile] Primary email already exists, skipping email update.`);
            // Update just the name/dob
            await prisma.user.update({
                where: { id: primaryUserId },
                data: { name: data.yourName, dob: data.yourDob || undefined, role: 'primary' }
            });
        } else {
            throw err;
        }
    }

    // 2. Find and update the partner user (Non-blocking on email conflict)
    partner = await prisma.user.findFirst({
        where: { coupleId, role: 'partner' }
    });
    
    if (partner) {
        try {
            await prisma.user.update({
                where: { id: partner.id },
                data: {
                    name: data.partnerName,
                    dob: data.partnerDob || undefined,
                    email: data.partnerEmail || undefined,
                }
            });
        } catch (err: any) {
            if (err.code === 'P2002' && err.meta?.target?.includes('email')) {
                logger.warn(`[CoupleService.setupProfile] Partner email already exists, skipping email update.`);
                await prisma.user.update({
                    where: { id: partner.id },
                    data: { name: data.partnerName, dob: data.partnerDob || undefined }
                });
            } else {
                throw err;
            }
        }
    }

    // 3. Upsert the Couple document (Crucial for names/photos)
    const existingCouple = await prisma.couple.findUnique({ where: { coupleId } });
    
    if (!existingCouple) {
      await prisma.couple.create({
        data: {
          coupleId,
          partner1Id: primaryUserId,
          partner2Id: partner?.id || null,
          profileName: `${data.yourName} & ${data.partnerName}`,
          relationshipStatus: data.relationshipStatus,
          locationCity: data.location?.city || 'Unknown',
          locationCountry: data.location?.country || 'India',
          isProfileComplete: false,
        }
      });
    } else {
      await prisma.couple.update({
        where: { id: existingCouple.id },
        data: {
          partner1Id: primaryUserId,
          partner2Id: partner?.id || existingCouple.partner2Id,
          profileName: `${data.yourName} & ${data.partnerName}`,
          relationshipStatus: data.relationshipStatus,
          locationCity: data.location?.city || undefined,
          locationCountry: data.location?.country || undefined,
        }
      });
    }
  }

  /**
   * Upload photos
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

    const existingToKeep = data.keepSecondaryPhotoUrls || [];
    const newPhotos = (data.secondaryPhotosBase64 || [])
      .filter(b64 => b64 && b64.length > 10)
      .map(b64 => (b64.startsWith('data:') ? b64 : 'data:image/jpeg;base64,' + b64));

    if (data.keepSecondaryPhotoUrls !== undefined || data.secondaryPhotosBase64 !== undefined) {
      updateData.secondaryPhotos = [...existingToKeep, ...newPhotos].slice(0, 3);
    }

    await prisma.couple.update({
        where: { coupleId },
        data: updateData
    });
  }

  /**
   * Submit questionnaire answers and mark onboarding COMPLETE
   */
  async submitAnswers(coupleId: string, answers: any[]) {
    // Prisma treats arrays of JSON objects as Json[] in PostgreSQL if defined so, 
    // but in schema.prisma I defined them as specific models if they were important.
    // However, I used Json for answers if I remember correctly.
    // Let's check schema.prisma
    
    await prisma.couple.update({
      where: { coupleId },
      data: { 
          answers: answers as any, 
          isProfileComplete: true 
      }
    });

    // ─── AI BIO GENERATION (BACKGROUND) ─────────────────────────────────────
    (async () => {
      try {
        const questionMap: Record<string, string> = {
          q1: 'Life Stage', q2: 'Couple Personality', q3: 'Favorite Activities',
          q4: 'Meeting Frequency', q5: 'What makes a good match', q6: 'Things to avoid',
        };
        const optionLabelMap: Record<string, string> = {
          'q1-career': 'Building careers', 'q1-family': 'Family first', 'q1-settled': 'Newly settled', 'q1-living': 'Living it up',
          'q2-hosts': "The Hosts", 'q2-yes-couple': "The 'yes' couple", 'q2-planners': 'The Planners', 'q2-explorers': 'The Explorers',
          'q3-dinners-home': 'Dinners at home', 'q3-restaurants': 'Exploring new restaurants', 'q3-outdoor': 'Outdoor activities/nature',
          'q3-cultural': 'Cultural events/museums', 'q3-drinks': 'Casual drinks', 'q3-trips': 'Weekend trips/travel',
          'q4-once-month': 'Meeting once a month', 'q4-twice-month': 'Meeting twice a month', 'q4-once-week': 'Meeting once a week', 'q4-when-fits': 'Meeting whenever it fits',
          'q5-similar-stage': 'Matches in a similar life stage', 'q5-shared-interests': 'Shared interests', 'q5-small-groups': 'Small group settings',
          'q5-structured-plans': 'Structured plans', 'q5-clear-boundaries': 'Clear boundaries', 'q5-weekend-availability': 'Weekend availability',
          'q6-late-night': 'Avoiding late-night plans', 'q6-large-groups': 'Avoiding very large groups', 'q6-alcohol-centric': 'Avoiding alcohol-centric meetups',
          'q6-last-minute': 'Avoiding last-minute/spontaneous plans',
        };

        const qaData = answers.map((a: any) => ({
          question: questionMap[a.questionId] || 'About us',
          answers: a.selectedOptionIds.map((id: string) => optionLabelMap[id] || id),
        }));

        const { generateCoupleBio } = require('../utils/ai');
        const aiResponse = await generateCoupleBio(qaData);

        if (aiResponse) {
          const updateObj: any = {};
          if (aiResponse.bio) updateObj.bio = aiResponse.bio;
          if (aiResponse.matchCriteria && aiResponse.matchCriteria.length > 0) {
            // Store the whole paragraph as the first element of the array for simplicity,
            // or join it if we want it to remain an array of short strings.
            // Since the AI now returns a single paragraph, we store it as is.
            updateObj.matchCriteria = aiResponse.matchCriteria;
          }
          await prisma.couple.update({ where: { coupleId }, data: updateObj });
        }
      } catch (aiErr) {
        logger.error(`[CoupleService] AI background generation failed:`, aiErr);
      }
    })();
  }

  async updateProfile(
    coupleId: string,
    data: {
      bio?: string;
      relationshipStatus?: string;
      preferences?: any;
      yourName?: string; yourDob?: string; yourEmail?: string;
      partnerName?: string; partnerDob?: string; partnerEmail?: string;
      // Added photo support directly in update
      primaryPhotoBase64?: string;
      secondaryPhotosBase64?: string[];
      keepSecondaryPhotoUrls?: string[];
    },
    requestingUserId?: string
  ) {
    const coupleDoc = await prisma.couple.findUnique({ where: { coupleId } });
    if (!coupleDoc) throw new AppError('Couple not found', 404);

    const updateData: any = {};
    if (data.bio !== undefined) updateData.bio = data.bio;
    if (data.relationshipStatus !== undefined) updateData.relationshipStatus = data.relationshipStatus;
    
    // 1. Photos processing
    if (data.primaryPhotoBase64 && data.primaryPhotoBase64.length > 10) {
      updateData.primaryPhoto = data.primaryPhotoBase64.startsWith('data:') 
        ? data.primaryPhotoBase64 
        : 'data:image/jpeg;base64,' + data.primaryPhotoBase64;
    }

    if (data.secondaryPhotosBase64 !== undefined || data.keepSecondaryPhotoUrls !== undefined) {
      const existingToKeep = data.keepSecondaryPhotoUrls || [];
      const newPhotos = (data.secondaryPhotosBase64 || [])
        .filter(b64 => b64 && b64.length > 10)
        .map(b64 => b64.startsWith('data:') ? b64 : 'data:image/jpeg;base64,' + b64);
      updateData.secondaryPhotos = [...existingToKeep, ...newPhotos].slice(0, 3);
    }

    // 2. Map preferences if provided
    if (data.preferences) {
        if (data.preferences.meetingFrequency) updateData.meetingFrequency = data.preferences.meetingFrequency;
        if (data.preferences.socialVibes) updateData.socialVibes = data.preferences.socialVibes;
        if (data.preferences.activities) updateData.activities = data.preferences.activities;
        if (data.preferences.avoidances) updateData.avoidances = data.preferences.avoidances;
        
        if (data.preferences.matchCriteria) {
            updateData.matchCriteria = Array.isArray(data.preferences.matchCriteria) 
                ? data.preferences.matchCriteria 
                : [data.preferences.matchCriteria];
        }
    }

    // Explicit check for matchCriteria at top level (if app sends it that way)
    if ((data as any).matchCriteria) {
        updateData.matchCriteria = Array.isArray((data as any).matchCriteria)
            ? (data as any).matchCriteria
            : [(data as any).matchCriteria];
    }

    const isPartner1Me = requestingUserId && coupleDoc.partner1Id === requestingUserId;
    const myId = isPartner1Me ? coupleDoc.partner1Id : coupleDoc.partner2Id;
    const partnerId = isPartner1Me ? coupleDoc.partner2Id : coupleDoc.partner1Id;

    // 3. Dynamic Profile Name update
    if (data.yourName || data.partnerName) {
      const u1 = await prisma.user.findUnique({ where: { id: coupleDoc.partner1Id || '' } });
      const u2 = await prisma.user.findUnique({ where: { id: coupleDoc.partner2Id || '' } });

      let p1Name = isPartner1Me ? (data.yourName || u1?.name) : (data.partnerName || u1?.name);
      let p2Name = isPartner1Me ? (data.partnerName || u2?.name) : (data.yourName || u2?.name);
      
      updateData.profileName = `${p1Name || 'User 1'} & ${p2Name || 'User 2'}`;
    }

    await prisma.couple.update({ where: { coupleId }, data: updateData });

    // 4. Update individual Users
    if (myId && (data.yourName || data.yourDob || data.yourEmail)) {
      try {
        await prisma.user.update({
            where: { id: myId },
            data: {
              name: data.yourName || undefined,
              dob: data.yourDob || undefined,
              email: data.yourEmail || undefined,
            }
        });
      } catch (err: any) {
        if (err.code === 'P2002' && err.meta?.target?.includes('email')) {
             logger.warn(`[CoupleService.updateProfile] Email conflict for myId ${myId}, skipping email update.`);
             await prisma.user.update({
                where: { id: myId },
                data: { name: data.yourName || undefined, dob: data.yourDob || undefined }
             });
        }
      }
    }

    if (partnerId && (data.partnerName || data.partnerDob || data.partnerEmail)) {
      try {
        await prisma.user.update({
            where: { id: partnerId },
            data: {
              name: data.partnerName || undefined,
              dob: data.partnerDob || undefined,
              email: data.partnerEmail || undefined,
            }
        });
      } catch (err: any) {
        if (err.code === 'P2002' && err.meta?.target?.includes('email')) {
             logger.warn(`[CoupleService.updateProfile] Email conflict for partnerId ${partnerId}, skipping email update.`);
             await prisma.user.update({
                where: { id: partnerId },
                data: { name: data.partnerName || undefined, dob: data.partnerDob || undefined }
             });
        }
      }
    }

    return prisma.couple.findUnique({ where: { coupleId }, include: { partner1: true, partner2: true } });
  }

  async getCouple(coupleId: string): Promise<any | null> {
    const couple = await prisma.couple.findUnique({
      where: { coupleId },
      include: {
        partner1: true,
        partner2: true,
        communityMembers: {
            include: { community: true }
        }
      }
    });

    if (!couple) return null;

    const communities = couple.communityMembers.map((m: any) => ({
      id: m.community.id,
      title: m.community.name,
      subtitle: m.community.city,
      note: m.community.description,
      imageUri: m.community.coverImageUrl
    }));

    return {
      ...couple,
      communities
    };
  }

  async subscribe(coupleId: string) {
    return prisma.couple.update({
      where: { coupleId },
      data: { isSubscribed: true }
    });
  }

  async blockCouple(meId: string, targetId: string) {
    const me = await prisma.couple.findUnique({ where: { id: meId } });
    const blocked = me?.blocked || [];
    if (!blocked.includes(targetId)) {
        return prisma.couple.update({
            where: { id: meId },
            data: { blocked: { set: [...blocked, targetId] } }
        });
    }
    return me;
  }

  async unblockCouple(meId: string, targetId: string) {
    const me = await prisma.couple.findUnique({ where: { id: meId } });
    const blocked = (me?.blocked || []).filter((id: string) => id !== targetId);
    return prisma.couple.update({
        where: { id: meId },
        data: { blocked: { set: blocked } }
    });
  }

  async getBlockedCouples(meId: string) {
    const me = await prisma.couple.findUnique({ where: { id: meId } });
    if (!me?.blocked.length) return [];
    return prisma.couple.findMany({
        where: { id: { in: me.blocked } },
        select: { id: true, profileName: true, primaryPhoto: true, locationCity: true, coupleId: true }
    });
  }

  async deleteMyCouple(coupleId: string) {
    await prisma.user.deleteMany({ where: { coupleId } });
    await prisma.couple.delete({ where: { coupleId } });
    return { success: true };
  }
}

export const coupleService = new CoupleService();
