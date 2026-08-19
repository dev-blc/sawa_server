import { prisma } from '../lib/prisma';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import { emitRealtimeNotification } from '../utils/realtime';
import { i18nData } from '../i18n/notif';
import { materializeImageLoose } from '../lib/storage';

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

    // All writes (both user rows + the couple row) commit atomically: a crash
    // mid-way used to be able to leave a renamed primary user with no couple
    // row, or a couple pointing at a partner that was never created.
    //
    // Email-conflict semantics are preserved but implemented as an in-tx
    // pre-check instead of the old catch-P2002-and-retry: a failed statement
    // aborts a Postgres transaction, so catching inside one can't work. The
    // residual check-then-write race (someone commits the same email between
    // our check and our write) still raises P2002 — the transaction rolls
    // back untouched and runTransaction() is retried once below, where the
    // pre-check now sees the committed winner and skips the email.
    const runTransaction = () => prisma.$transaction(async (tx) => {
      /** True when `email` can be written to `excludeUserId` without violating
       *  the unique constraint (unset emails are never "available"). */
      const emailAvailable = async (
        email: string | undefined,
        excludeUserId?: string,
      ): Promise<boolean> => {
        if (!email) return false;
        const owner = await tx.user.findFirst({ where: { email }, select: { id: true } });
        return !owner || owner.id === excludeUserId;
      };

      // 1. Update primary user's details (email stays non-blocking on conflict)
      const canUseYourEmail = await emailAvailable(data.yourEmail, primaryUserId);
      if (data.yourEmail && !canUseYourEmail) {
        logger.warn(`[CoupleService.setupProfile] Primary email already exists, skipping email update.`);
      }
      await tx.user.update({
        where: { id: primaryUserId },
        data: {
          name: data.yourName,
          dob: data.yourDob || undefined,
          email: canUseYourEmail ? data.yourEmail : undefined,
          role: 'primary'
        }
      });

      // 2. Find and update the partner user (email stays non-blocking on conflict)
      let partner = await tx.user.findFirst({
          where: { coupleId, role: 'partner' }
      });

      if (partner) {
          const canUsePartnerEmail = await emailAvailable(data.partnerEmail, partner.id);
          if (data.partnerEmail && !canUsePartnerEmail) {
            logger.warn(`[CoupleService.setupProfile] Partner email already exists, skipping email update.`);
          }
          await tx.user.update({
              where: { id: partner.id },
              data: {
                  name: data.partnerName,
                  dob: data.partnerDob || undefined,
                  email: canUsePartnerEmail ? data.partnerEmail : undefined,
              }
          });
      } else if (data.partnerName) {
          const canUsePartnerEmail = await emailAvailable(data.partnerEmail);
          if (data.partnerEmail && !canUsePartnerEmail) {
            logger.warn(`[CoupleService.setupProfile] Partner email already exists during create, skipping email.`);
          }
          partner = await tx.user.create({
              data: {
                  name: data.partnerName,
                  dob: data.partnerDob || undefined,
                  email: canUsePartnerEmail ? data.partnerEmail : undefined,
                  role: 'partner',
                  coupleId: coupleId
              }
          });
      }

      // 3. Ensure role-based assignment for partner1/partner2 IDs
      // We should always keep the 'primary' user as partner1 and 'partner' user as partner2
      const users = await tx.user.findMany({ where: { coupleId } });
      const primaryUser = users.find(u => u.role === 'primary');
      const partnerUser = users.find(u => u.role === 'partner');

      const partner1Id = primaryUser?.id || primaryUserId;
      const partner2Id = partnerUser?.id || partner?.id || null;

      // 4. Upsert the Couple document
      const existingCouple = await tx.couple.findUnique({ where: { coupleId } });

      if (!existingCouple) {
        await tx.couple.create({
          data: {
            coupleId,
            partner1Id,
            partner2Id,
            profileName: `${data.yourName} & ${data.partnerName}`,
            relationshipStatus: data.relationshipStatus,
            locationCity: data.location?.city || 'Unknown',
            locationCountry: data.location?.country || 'India',
            isProfileComplete: false,
          }
        });
      } else {
        await tx.couple.update({
          where: { id: existingCouple.id },
          data: {
            partner1Id: partner1Id || existingCouple.partner1Id,
            partner2Id: partner2Id || existingCouple.partner2Id,
            profileName: `${data.yourName} & ${data.partnerName}`,
            relationshipStatus: data.relationshipStatus,
            locationCity: data.location?.city || undefined,
            locationCountry: data.location?.country || undefined,
          }
        });
      }
    }, { timeout: 10000 });

    try {
      await runTransaction();
    } catch (err: any) {
      if (err?.code === 'P2002') {
        // A concurrent writer won a unique race (email, or the couple row)
        // mid-transaction. Nothing was committed — retry once so the in-tx
        // pre-checks observe the winner and degrade gracefully, exactly like
        // the old catch-P2002 path did. A second P2002 propagates.
        await runTransaction();
        return;
      }
      throw err;
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
      // materializeImageLoose handles raw base64, data: URIs AND already-hosted
      // URLs (the presigned-upload pipeline sends public /img/ URLs — the old
      // blind `data:image/jpeg;base64,<value>` wrap corrupted those).
      // Stores an S3 URL; falls back to the input if storage is unavailable.
      updateData.primaryPhoto = await materializeImageLoose(data.primaryPhotoBase64, coupleId);
    }

    const existingToKeep = data.keepSecondaryPhotoUrls || [];
    const newPhotos = (
      await Promise.all(
        (data.secondaryPhotosBase64 || [])
          .filter(b64 => b64 && b64.length > 10)
          .map(b64 => materializeImageLoose(b64, coupleId)),
      )
    ).filter((v): v is string => Boolean(v));

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
    
    const wasIncomplete = await prisma.couple.findUnique({
      where: { coupleId },
      select: { isProfileComplete: true, locationCity: true, profileName: true },
    });

    await prisma.couple.update({
      where: { coupleId },
      data: { 
          answers: {
              deleteMany: {},
              create: answers.map((a: any) => ({
                  questionId: a.questionId,
                  selectedOptionIds: a.selectedOptionIds
              }))
          },
          isProfileComplete: true 
      }
    });

    // ─── Notify nearby couples that a new couple just joined their city ───
    // Only fires on the FIRST time onboarding completes (not on re-saves)
    // and only if we know what city they're in.
    if (wasIncomplete && !wasIncomplete.isProfileComplete && wasIncomplete.locationCity) {
      this.notifyNearbyCouples(
        coupleId,
        wasIncomplete.locationCity,
        wasIncomplete.profileName || 'A new couple',
      ).catch((err) => {
        logger.warn(`[CoupleService] notifyNearbyCouples failed: ${err.message}`);
      });
    }

    // ─── AI BIO GENERATION (BACKGROUND) ─────────────────────────────────────
    (async () => {
      try {
        const questionMap: Record<string, string> = {
          q1: 'Life Stage', q2: 'Couple Personality', q3: 'Favorite Activities',
          q4: 'Meeting Frequency', q5: 'What makes a good match', q6: 'Things to avoid',
        };
        const optionLabelMap: Record<string, string> = {
          'q1-career': 'Building careers', 'q1-family': 'Family first', 'q1-settled': 'Newly settled', 'q1-living': 'Living it up',
          'q1-growing': 'Growing together', 'q1-adventure': 'Always exploring',
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
      // Location updates (sent by phone-login / OTP city detection and Settings)
      location?: { city?: string; country?: string };
      locationCity?: string;
      locationCountry?: string;
      locationLatitude?: number;
      locationLongitude?: number;
    },
    requestingUserId?: string
  ) {
    const coupleDoc = await prisma.couple.findUnique({ where: { coupleId } });
    if (!coupleDoc) throw new AppError('Couple not found', 404);

    const updateData: any = {};
    if (data.bio !== undefined) updateData.bio = data.bio;
    if (data.relationshipStatus !== undefined) updateData.relationshipStatus = data.relationshipStatus;
    if ((data as any).isOpenToMeeting !== undefined) updateData.isOpenToMeeting = (data as any).isOpenToMeeting;

    // Location handling — accept both top-level (locationCity/locationCountry)
    // and nested ({ location: { city, country } }) shapes from clients.
    const incomingCity = data.location?.city ?? data.locationCity;
    const incomingCountry = data.location?.country ?? data.locationCountry;
    if (incomingCity !== undefined && incomingCity !== null && String(incomingCity).trim().length > 0) {
      updateData.locationCity = String(incomingCity).trim();
    }
    if (incomingCountry !== undefined && incomingCountry !== null && String(incomingCountry).trim().length > 0) {
      updateData.locationCountry = String(incomingCountry).trim();
    }
    const lat = data.locationLatitude;
    const lng = data.locationLongitude;
    if (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
      // Only persist coordinates within India's service area (lat 6–38, lng 68–98).
      // Emulator defaults like Mountain View, CA (37.4°N, 122°W) are rejected so
      // they never cause "13 000 km away" distances in the discovery feed.
      const inServiceArea = lat >= 6 && lat <= 38 && lng >= 68 && lng <= 98;
      if (inServiceArea) {
        updateData.locationLatitude = lat;
        updateData.locationLongitude = lng;
      }
    }

    // 1. Photos processing — convert incoming base64 to S3 URLs (keeps ~0.5 MB
    // blobs out of Postgres). Falls back to base64 if storage is unavailable.
    // materializeImageLoose also passes hosted URLs through unchanged (the
    // presigned-upload pipeline sends public /img/ URLs — the old blind
    // base64 wrap corrupted those).
    if (data.primaryPhotoBase64 && data.primaryPhotoBase64.length > 10) {
      updateData.primaryPhoto = await materializeImageLoose(data.primaryPhotoBase64, coupleId);
    }

    if (data.secondaryPhotosBase64 !== undefined || data.keepSecondaryPhotoUrls !== undefined) {
      const existingToKeep = data.keepSecondaryPhotoUrls || [];
      const newPhotos = (
        await Promise.all(
          (data.secondaryPhotosBase64 || [])
            .filter(b64 => b64 && b64.length > 10)
            .map(b64 => materializeImageLoose(b64, coupleId)),
        )
      ).filter((v): v is string => Boolean(v));
      updateData.secondaryPhotos = [...existingToKeep, ...newPhotos].slice(0, 3);
    }

    // 2. Map preferences if provided
    if (Array.isArray((data as any).activities)) {
      updateData.activities = (data as any).activities;
    }

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

    const updated = await prisma.couple.findUnique({ where: { coupleId }, include: { partner1: true, partner2: true } });
    return this._formatCouple(updated);
  }

  // Fields on the User model that must NEVER be serialized to a client.
  // (Password hash, refresh-token hash and the raw push token are secrets.)
  private _sanitizePartner(partner: any) {
    if (!partner) return partner;
    const { password, refreshTokenHash, pushToken, ...safe } = partner;
    safe._id = partner.id;
    return safe;
  }

  private _formatCouple(couple: any) {
    if (!couple) return null;
    const formatted = { 
        ...couple, 
        _id: couple.id,
        location: {
            city: couple.locationCity,
            country: couple.locationCountry
        },
        // Add legacy alias for "What we are looking for"
        lookingFor: (couple.matchCriteria && couple.matchCriteria.length > 0) ? couple.matchCriteria[0] : ""
    };
    // Strip partner secrets (password/refreshTokenHash/pushToken) before the
    // couple object is returned to any client.
    if (formatted.partner1) formatted.partner1 = this._sanitizePartner(formatted.partner1);
    if (formatted.partner2) formatted.partner2 = this._sanitizePartner(formatted.partner2);
    return formatted;
  }

  async getCouple(coupleId: string): Promise<any | null> {
    const couple = await prisma.couple.findUnique({
      where: { coupleId },
      include: {
        partner1: true,
        partner2: true,
        communityMembers: {
            include: { community: true }
        },
        answers: true,
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

    return this._formatCouple({
      ...couple,
      communities
    });
  }

  // Lightweight public profile — skips communityMembers and answers.
  // Used by getCoupleById (viewing another couple's profile card).
  async getCoupleSummary(coupleId: string): Promise<any | null> {
    const couple = await prisma.couple.findUnique({
      where: { coupleId },
      include: {
        // Public profile card — never expose partner email addresses here.
        partner1: { select: { id: true, name: true, dob: true } },
        partner2: { select: { id: true, name: true, dob: true } },
      }
    });
    if (!couple) return null;
    // Strip couple-level fields that must never leak to another couple viewing a
    // public profile card:
    //  • blocked / bannedAt / banReason — moderation internals.
    //  • locationLatitude / locationLongitude — EXACT home coordinates. Discovery
    //    only ever exposes a coarse `distance` label; leaking raw lat/lng here is
    //    a stalking/safety risk, so it must never appear on a profile card.
    const publicCouple: any = { ...couple };
    delete publicCouple.blocked;
    delete publicCouple.bannedAt;
    delete publicCouple.banReason;
    delete publicCouple.locationLatitude;
    delete publicCouple.locationLongitude;
    return this._formatCouple({ ...publicCouple, communities: [] });
  }

  async subscribe(coupleId: string) {
    return prisma.couple.update({
      where: { coupleId },
      data: { isSubscribed: true }
    });
  }

  async blockCouple(meId: string, targetId: string) {
    // meId and targetId may be Mongo id or coupleId UUID — resolve both
    const me = await prisma.couple.findUnique({ where: { id: meId }, select: { id: true, coupleId: true, blocked: true } });
    if (!me) return null;

    // Find target by either Mongo id or coupleId
    const target = await (prisma.couple as any).findFirst({
      where: { OR: [{ id: targetId }, { coupleId: targetId }] },
      select: { id: true, coupleId: true },
    });
    const resolvedTargetId = target?.coupleId || targetId;

    const blocked = me.blocked || [];
    if (!blocked.includes(resolvedTargetId)) {
      await Promise.all([
        // Atomic in-DB append (deduped by the ANY guard). The old
        // read-modify-write with `set:` lost one block when two arrived
        // concurrently — unacceptable for a safety feature.
        prisma.$executeRaw`
          UPDATE "couples"
          SET "blocked" = array_append("blocked", ${resolvedTargetId})
          WHERE "id" = ${meId} AND NOT (${resolvedTargetId} = ANY("blocked"))
        `,
        // Always create a report so the admin can see blocks from all sources
        me.coupleId
          ? prisma.report.create({
              data: {
                reporterId: me.coupleId,
                targetId: resolvedTargetId,
                reason: 'Blocked user',
                details: 'User blocked via stop-seeing action',
                status: 'pending',
              },
            })
          : Promise.resolve(),
      ]);
    }
    return me;
  }

  async unblockCouple(meId: string, targetId: string) {
    const me = await prisma.couple.findUnique({ where: { id: meId } });
    if (!me) return null;

    // Resolve all IDs for the target so we can remove whichever format is stored
    const target = await (prisma.couple as any).findFirst({
      where: { OR: [{ id: targetId }, { coupleId: targetId }] },
      select: { id: true, coupleId: true },
    });
    // Atomic in-DB removal of every id form the block may be stored under —
    // no read-modify-write window. Passing the same value twice is harmless.
    await prisma.$executeRaw`
      UPDATE "couples"
      SET "blocked" = array_remove(array_remove(array_remove("blocked", ${targetId}), ${target?.id ?? targetId}), ${target?.coupleId ?? targetId})
      WHERE "id" = ${meId}
    `;
    return prisma.couple.findUnique({ where: { id: meId } });
  }

  async getBlockedCouples(meId: string) {
    const me = await prisma.couple.findUnique({ where: { id: meId } });
    if (!me?.blocked.length) return [];
    // blocked[] may contain either Mongo id OR coupleId (UUID) depending on which
    // block path was used — match both so all blocks are always shown
    return prisma.couple.findMany({
        where: {
          OR: [
            { id: { in: me.blocked } },
            { coupleId: { in: me.blocked } },
          ],
        },
        select: { id: true, profileName: true, primaryPhoto: true, locationCity: true, coupleId: true }
    });
  }

  async getBlockedCommunities(meId: string) {
    const me = await prisma.couple.findUnique({ where: { id: meId } });
    if (!me?.blocked.length) return [];
    // Resolve which blocked IDs belong to communities
    const communities = await prisma.community.findMany({
      where: { id: { in: me.blocked } },
      select: { id: true, name: true, coverImageUrl: true },
    });
    return communities.map((c: any) => ({ id: c.id, name: c.name, image: c.coverImageUrl }));
  }

  async unblockCommunity(meId: string, communityId: string) {
    // Atomic removal — same lost-update reasoning as unblockCouple.
    await prisma.$executeRaw`
      UPDATE "couples"
      SET "blocked" = array_remove("blocked", ${communityId})
      WHERE "id" = ${meId}
    `;
    return prisma.couple.findUnique({ where: { id: meId } });
  }

  /**
   * Fan out a "new couple in your area" notification to all profile-complete,
   * non-banned couples in the same city. This delivers as both an in-app
   * notification (Socket.IO + Notification row) and an OS push (FCM).
   *
   * "Nearby" is currently city-level since we don't store GPS coordinates;
   * upgrade to lat/lng + radius when geolocation is added to the schema.
   */
  private async notifyNearbyCouples(
    newCoupleId: string,
    city: string,
    newCoupleName: string,
  ): Promise<void> {
    const nearby = await prisma.couple.findMany({
      where: {
        coupleId: { not: newCoupleId },
        locationCity: city,
        isProfileComplete: true,
        bannedAt: null,
      },
      select: { coupleId: true },
      take: 200,
    });

    if (nearby.length === 0) return;

    const title = 'A new couple joined nearby';
    const message = `${newCoupleName} just joined SAWA in ${city}. Say hi!`;
    const notifData = { coupleId: newCoupleId, city, ...i18nData('nearby.joined', { name: newCoupleName, city }) };

    // Persist + emit each notification.
    await Promise.all(
      nearby.map(async (c) => {
        const notif = await prisma.notification.create({
          data: {
            recipientId: c.coupleId,
            senderId: newCoupleId,
            type: 'nearby',
            title,
            message,
            data: notifData,
          },
        });
        emitRealtimeNotification(c.coupleId, {
          notificationId: notif.id,
          type: 'nearby',
          title,
          message,
          data: notifData,
        });
      }),
    );

    logger.info(
      `[CoupleService] Notified ${nearby.length} nearby couple(s) in ${city} about ${newCoupleId}`,
    );
  }

  async deleteMyCouple(coupleId: string) {
    const couple = await prisma.couple.findUnique({ where: { coupleId } });
    if (!couple) return { success: true };

    // Private chats hold messages from BOTH couples keyed by matchId. Deleting
    // only `senderId = coupleId` would leave the partner's messages orphaned
    // (matchId set-null) once the matches are removed — so gather this couple's
    // match ids and delete every message under them.
    const myMatches = await prisma.match.findMany({
      where: { OR: [{ couple1Id: coupleId }, { couple2Id: coupleId }, { actionById: coupleId }] },
      select: { id: true },
    });
    const matchIds = myMatches.map((m) => m.id);

    // Run the whole deletion in ONE transaction so a mid-way failure can never
    // leave a half-deleted account (privacy/GDPR: no dangling personal data).
    // Order deletes children-before-parents to satisfy foreign keys. Includes
    // the couple-scoped tables that have no FK to Couple and were previously
    // never cleaned up (Us Space cycle/game data + subscription).
    await prisma.$transaction([
      prisma.onboardingAnswer.deleteMany({ where: { coupleId } }),
      prisma.message.deleteMany({ where: { matchId: { in: matchIds } } }),
      prisma.message.deleteMany({ where: { senderId: coupleId } }),
      prisma.notification.deleteMany({
        where: { OR: [{ recipientId: coupleId }, { senderId: coupleId }] },
      }),
      prisma.match.deleteMany({
        where: { OR: [{ couple1Id: coupleId }, { couple2Id: coupleId }, { actionById: coupleId }] },
      }),
      prisma.communityMember.deleteMany({ where: { coupleId } }),
      prisma.communityAdmin.deleteMany({ where: { coupleId } }),
      prisma.communityJoinRequest.deleteMany({ where: { coupleId } }),
      prisma.report.deleteMany({
        where: { OR: [{ reporterId: coupleId }, { targetId: coupleId }] },
      }),
      prisma.fridgeNote.deleteMany({ where: { coupleId } }),
      prisma.plannedDate.deleteMany({ where: { coupleId } }),
      prisma.usGameScore.deleteMany({ where: { coupleId } }),
      prisma.coupleUsState.deleteMany({ where: { coupleId } }),
      prisma.subscription.deleteMany({ where: { coupleId } }),
      prisma.user.deleteMany({ where: { coupleId } }),
      prisma.couple.delete({ where: { coupleId } }),
    ]);

    return { success: true };
  }
}

export const coupleService = new CoupleService();
