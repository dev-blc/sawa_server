import { prisma } from '../lib/prisma';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import { emitRealtimeNotification } from '../utils/realtime';
import {
  upsertMatchConnectedNotification,
  upsertMatchPendingNotification,
} from './notification.service';
import { distanceLabelBetween } from '../utils/geo';

const COUPLE_GEO_SELECT = {
  locationCity: true,
  locationLatitude: true,
  locationLongitude: true,
} as const;

export class MatchService {
  /**
   * Fetches the discovery feed of couples
   */
  async getDiscoveryFeed(requestingCoupleId: string, cityFilter?: string, coupleMongoId?: string) {
    let me;
    if (coupleMongoId) {
      me = await prisma.couple.findUnique({ where: { id: coupleMongoId } });
    } else {
      me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId } });
    }
    
    if (!me) throw new AppError('Couple profile not found', 404);

    const blockedIds = me.blocked || [];
    const SUPPORTED_CITIES = ['Bangalore', 'Chennai', 'New Delhi', 'Delhi', 'Mumbai', 'Gurgaon', 'Noida', 'Hyderabad', 'Goa'];

    // Get interacted IDs in BOTH directions so already-connected couples don't re-appear
    const interactions = await prisma.match.findMany({
      where: { OR: [{ couple1Id: me.coupleId }, { couple2Id: me.coupleId }] },
      select: { couple1Id: true, couple2Id: true }
    });
    const interactedIds = Array.from(new Set(
      interactions.flatMap((m: any) => [m.couple1Id, m.couple2Id]).filter((id: string) => id !== me.coupleId)
    ));

    const where: any = {
      coupleId: { not: me.coupleId, notIn: [...interactedIds, ...blockedIds] },
      isProfileComplete: true,
      isOpenToMeeting: true,
    };

    if (cityFilter && cityFilter !== 'All City' && cityFilter !== 'All Cities' && cityFilter !== 'Unknown') {
       const isSupported = SUPPORTED_CITIES.some(c => cityFilter.toLowerCase().includes(c.toLowerCase()));
       if (isSupported) {
          where.locationCity = { contains: cityFilter, mode: 'insensitive' };
       }
    }

    const Q3_TITLES: Record<string, string> = {
      'q3-dinners-home': 'Dinners at home',
      'q3-restaurants': 'Exploring restaurants',
      'q3-outdoor': 'Outdoor activities',
      'q3-cultural': 'Cultural events',
      'q3-drinks': 'Casual drinks',
      'q3-trips': 'Weekend trips',
    };

    const potentialCouples = await prisma.couple.findMany({
      where,
      take: 10,
      select: {
        id: true,
        coupleId: true,
        profileName: true,
        primaryPhoto: true,
        ...COUPLE_GEO_SELECT,
        bio: true,
        matchCriteria: true,
        relationshipStatus: true,
        answers: {
          where: { questionId: 'q3' },
          select: { selectedOptionIds: true },
        },
      },
    });

    return potentialCouples.map((c: any) => {
      const q3Answer = c.answers?.[0];
      const tags: string[] = q3Answer
        ? (q3Answer.selectedOptionIds as string[])
            // Resolve ID → title; if value is already a title (no key match) keep it as-is
            .map((id: string) => Q3_TITLES[id] || id)
            .filter((v: string) => Boolean(v) && v.trim().length > 0)
        : [];

      return {
        _id: c.id,
        coupleId: c.coupleId,
        profileName: c.profileName,
        primaryPhoto: c.primaryPhoto || 'https://images.unsplash.com/photo-1511285560929-80b456fea0bc?auto=format&fit=crop&w=400&q=80',
        location: c.locationCity || 'Unknown',
        bio: c.bio || undefined,
        matchCriteria: c.matchCriteria || undefined,
        relationshipStatus: c.relationshipStatus || undefined,
        distance: distanceLabelBetween(me, c),
        tags,
        matchScore: Math.floor(Math.random() * 20) + 80,
        insights: [
          'Both career-focused and socially intentional',
          'Similar pace - you both prefer meeting once or twice a month',
        ],
      };
    });
  }

  /**
   * Say hello (like) to a couple
   */
  async sayHello(requestingCoupleId: string, targetCoupleIdStr: string, coupleMongoId?: string) {
    let me;
    if (coupleMongoId) {
      me = await prisma.couple.findUnique({ where: { id: coupleMongoId } });
    } else {
      me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId } });
    }
    
    if (!me) throw new AppError('Profile not found', 404);

    let targetCouple = await prisma.couple.findFirst({
        where: { OR: [{ id: targetCoupleIdStr }, { coupleId: targetCoupleIdStr }] }
    });

    if (!targetCouple) {
       logger.info(`[MatchService] Say Hello for unknown couple ${targetCoupleIdStr} - success (no DB)`);
       return { isMatch: false };
    }

    // Fetch ALL rows between these two couples and pick in priority order:
    // accepted > incoming-pending > my-pending > skipped
    const allExisting = await prisma.match.findMany({
      where: {
        OR: [
          { couple1Id: me.coupleId, couple2Id: targetCouple.coupleId },
          { couple1Id: targetCouple.coupleId, couple2Id: me.coupleId }
        ]
      },
      orderBy: { createdAt: 'asc' }
    });

    const accepted      = allExisting.find(m => m.status === 'accepted');
    const incomingPending = allExisting.find(m => m.status === 'pending' && m.actionById !== me.coupleId);
    const myPending     = allExisting.find(m => m.status === 'pending' && m.actionById === me.coupleId);

    // Already connected
    if (accepted) {
      return { isMatch: true, matchId: accepted.id };
    }

    // Treat the incoming-pending as the canonical match to accept
    const existingMatch = incomingPending || myPending || allExisting[0] || null;

    if (existingMatch) {
      // The other person sent us a hello — accept it
      if (existingMatch.status === 'skipped') {
        // Reset skipped to pending; ensure initiator (me) is couple1 so getIncomingRequests finds it
        const updatedMatch = await prisma.match.update({
          where: { id: existingMatch.id },
          data: {
            status: 'pending',
            actionById: me.coupleId,
            couple1Id: me.coupleId,
            couple2Id: targetCouple.coupleId,
          }
        });

        // Notify the other couple (who was skipped) so they know this person said hello.
        // Previously this returned early without any notification, silently dropping the request.
        (async () => {
          try {
            await upsertMatchPendingNotification({
              recipientId: targetCouple.coupleId,
              senderId: me.coupleId,
              matchId: updatedMatch.id,
              profileName: me.profileName || 'Couple',
              primaryPhoto: me.primaryPhoto,
              location: me.locationCity,
              bio: me.bio,
              tags: me.activities,
              vibes: me.socialVibes,
              matchCriteria: me.matchCriteria,
            });
          } catch (err) {
            logger.error('[MatchService] Failed to notify skipped couple of new hello:', err);
          }
        })();

        return { isMatch: false };
      }

      // I already sent a pending hello; nothing to do
      if (existingMatch.actionById === me.coupleId) {
        return { isMatch: false };
      }

      if (existingMatch.status === 'pending' && existingMatch.actionById !== me.coupleId) {
          // Mutual like
          await prisma.match.update({
            where: { id: existingMatch.id },
            data: { status: 'accepted', actionById: me.coupleId }
          });

          // Delete the original "New Connection Request" pending notifications for this match
          // so they no longer show "Say Hello Back" after accepting.
          // The new "You've Connected!" notifications created below replace them.
          await upsertMatchConnectedNotification({
            recipientId: me.coupleId,
            senderId: targetCouple.coupleId,
            matchId: existingMatch.id,
            coupleId: targetCouple.coupleId,
            profileName: targetCouple.profileName || 'Couple',
            primaryPhoto: targetCouple.primaryPhoto,
            location: targetCouple.locationCity,
            bio: targetCouple.bio,
            tags: targetCouple.activities,
            vibes: targetCouple.socialVibes,
            matchCriteria: targetCouple.matchCriteria,
          });
          await upsertMatchConnectedNotification({
            recipientId: targetCouple.coupleId,
            senderId: me.coupleId,
            matchId: existingMatch.id,
            coupleId: me.coupleId,
            profileName: me.profileName || 'Couple',
            primaryPhoto: me.primaryPhoto,
            location: me.locationCity,
            bio: me.bio,
            tags: me.activities,
            vibes: me.socialVibes,
            matchCriteria: me.matchCriteria,
          });

          // Emit match:accepted so both couples' PrivateChatScreen lists refresh instantly
          const io = (global as any).io;
          if (io) {
            const acceptedPayload = {
              matchId: existingMatch.id,
              couple1Id: me.coupleId,
              couple2Id: targetCouple.coupleId,
            };
            io.to(`couple:${me.coupleId}`).emit('match:accepted', acceptedPayload);
            io.to(`couple:${targetCouple.coupleId}`).emit('match:accepted', acceptedPayload);
          }

          return { isMatch: true, matchId: existingMatch.id };
       }

      return { isMatch: false };
    }

    const newMatch = await prisma.match.create({
      data: {
        couple1Id: me.coupleId,
        couple2Id: targetCouple.coupleId,
        status: 'pending',
        actionById: me.coupleId,
      }
    });

    (async () => {
      try {
        await upsertMatchPendingNotification({
          recipientId: targetCouple!.coupleId,
          senderId: me!.coupleId,
          matchId: newMatch.id,
          profileName: me!.profileName || 'Couple',
          primaryPhoto: me!.primaryPhoto,
          location: me!.locationCity,
          bio: me!.bio,
          tags: me!.activities,
          vibes: me!.socialVibes,
          matchCriteria: me!.matchCriteria,
        });
      } catch (err) {
        logger.error(`[MatchService] Background notification failed:`, err);
      }
    })();

    return { isMatch: false };
  }

  async skipCouple(requestingCoupleId: string, targetCoupleIdStr: string) {
    const me = await prisma.couple.findUnique({ 
        where: { coupleId: requestingCoupleId }, 
        select: { id: true, coupleId: true } 
    });
    if (!me) {
        logger.error(`[MatchService.skipCouple] Requesting couple not found: ${requestingCoupleId}`);
        throw new AppError('Profile not found', 404);
    }

    const target = await prisma.couple.findFirst({
        where: { OR: [{ id: targetCoupleIdStr }, { coupleId: targetCoupleIdStr }] },
        select: { id: true, coupleId: true }
    });
    if (!target) {
        logger.warn(`[MatchService.skipCouple] Target couple not found: ${targetCoupleIdStr}`);
        return { skipped: true };
    }

    // Only create a skip record if there is no existing interaction (accepted stays accepted)
    const existing = await prisma.match.findFirst({
      where: {
        OR: [
          { couple1Id: me.coupleId, couple2Id: target.coupleId },
          { couple1Id: target.coupleId, couple2Id: me.coupleId },
        ],
      },
    });

    if (!existing) {
      await prisma.match.create({
        data: { 
            couple1Id: me.coupleId, 
            couple2Id: target.coupleId, 
            status: 'skipped', 
            actionById: me.coupleId 
        }
      });
    }
    // If already accepted, leave it alone; if already skipped, no need to duplicate

    return { skipped: true };
  }

  async getIncomingRequests(requestingCoupleId: string, coupleMongoId?: string) {
    let meId: string;
    let meGeo: { locationCity?: string | null; locationLatitude?: number | null; locationLongitude?: number | null };
    if (coupleMongoId) {
      const meProfile = await prisma.couple.findUnique({
        where: { id: coupleMongoId },
        select: { coupleId: true, ...COUPLE_GEO_SELECT },
      });
      if (!meProfile) throw new AppError('Profile not found', 404);
      meId = meProfile.coupleId;
      meGeo = meProfile;
    } else {
      const me = await prisma.couple.findUnique({
        where: { coupleId: requestingCoupleId },
        select: { id: true, coupleId: true, ...COUPLE_GEO_SELECT },
      });
      if (!me) throw new AppError('Profile not found', 404);
      meId = me.coupleId;
      meGeo = me;
    }

    // Incoming requests: pending matches where the OTHER person initiated (actionById ≠ meId)
    const pending = await prisma.match.findMany({ 
      where: {
        status: 'pending',
        actionById: { not: meId },
        OR: [{ couple1Id: meId }, { couple2Id: meId }],
      },
      include: { couple1: true, couple2: true }
    });

    return pending.map((m: any) => {
      const otherCouple = m.couple1Id === meId ? m.couple2 : m.couple1;
      if (!otherCouple) return null;

      return {
        _id: m.id,
        id: m.id,
        coupleId: otherCouple.coupleId,
        profileName: otherCouple.profileName || 'Someone',
        primaryPhoto: otherCouple.primaryPhoto,
        location: otherCouple.locationCity || 'Unknown',
        distance: distanceLabelBetween(meGeo, otherCouple),
        status: 'pending',
        createdAt: m.createdAt
      };
    }).filter(Boolean);
  }

  async getMatches(requestingCoupleId: string, coupleMongoId?: string) {
    let meId: string;
    let meGeo: { locationCity?: string | null; locationLatitude?: number | null; locationLongitude?: number | null };
    if (coupleMongoId) {
      const meProfile = await prisma.couple.findUnique({
        where: { id: coupleMongoId },
        select: { coupleId: true, ...COUPLE_GEO_SELECT },
      });
      if (!meProfile) throw new AppError('Profile not found', 404);
      meId = meProfile.coupleId;
      meGeo = meProfile;
    } else {
      const me = await prisma.couple.findUnique({
        where: { coupleId: requestingCoupleId },
        select: { id: true, coupleId: true, ...COUPLE_GEO_SELECT },
      });
      if (!me) throw new AppError('Profile not found', 404);
      meId = me.coupleId;
      meGeo = me;
    }

    const matches = await prisma.match.findMany({ 
      where: { OR: [{ couple1Id: meId }, { couple2Id: meId }], status: 'accepted' },
      select: {
        id: true,
        couple1Id: true,
        couple2Id: true,
        status: true,
        createdAt: true,
        couple1: {
          select: {
            id: true,
            coupleId: true,
            profileName: true,
            primaryPhoto: true,
            ...COUPLE_GEO_SELECT,
          },
        },
        couple2: {
          select: {
            id: true,
            coupleId: true,
            profileName: true,
            primaryPhoto: true,
            ...COUPLE_GEO_SELECT,
          },
        },
      }
    });

    return matches.map((m: any) => {
        const otherCouple = m.couple1Id === meId ? m.couple2 : m.couple1;
        if (!otherCouple) return null;

        return {
          _id: m.id,
          id: m.id,
          coupleId: otherCouple.coupleId,
          profileName: otherCouple.profileName || 'Unknown Couple',
          primaryPhoto: otherCouple.primaryPhoto,
          location: otherCouple.locationCity || 'Unknown',
          distance: distanceLabelBetween(meGeo, otherCouple),
          status: m.status,
          createdAt: m.createdAt
        };
    }).filter(Boolean);
  }

  /** Accept an incoming pending match by id (used by notifications + accept endpoint). */
  private async acceptPendingMatchRecord(
    match: { id: string; actionById: string; couple1Id: string; couple2Id: string },
    me: { coupleId: string },
  ) {
    const initiatorCoupleId = match.actionById;
    const otherCoupleId =
      match.couple1Id === me.coupleId ? match.couple2Id : match.couple1Id;

    await prisma.match.update({
      where: { id: match.id },
      data: { status: 'accepted', actionById: me.coupleId },
    });

    const targetCouple = await prisma.couple.findUnique({
      where: { coupleId: initiatorCoupleId },
    });
    const meCouple = await prisma.couple.findUnique({
      where: { coupleId: me.coupleId },
      select: { profileName: true, coupleId: true },
    });

    if (targetCouple && meCouple) {
      const meFull = await prisma.couple.findUnique({ where: { coupleId: me.coupleId } });
      await upsertMatchConnectedNotification({
        recipientId: me.coupleId,
        senderId: targetCouple.coupleId,
        matchId: match.id,
        coupleId: targetCouple.coupleId,
        profileName: targetCouple.profileName || 'Couple',
        primaryPhoto: targetCouple.primaryPhoto,
        location: targetCouple.locationCity,
        bio: targetCouple.bio,
        tags: targetCouple.activities,
        vibes: targetCouple.socialVibes,
        matchCriteria: targetCouple.matchCriteria,
      });
      await upsertMatchConnectedNotification({
        recipientId: targetCouple.coupleId,
        senderId: me.coupleId,
        matchId: match.id,
        coupleId: me.coupleId,
        profileName: meCouple.profileName || 'Couple',
        primaryPhoto: meFull?.primaryPhoto,
        location: meFull?.locationCity,
        bio: meFull?.bio,
        tags: meFull?.activities,
        vibes: meFull?.socialVibes,
        matchCriteria: meFull?.matchCriteria,
      });

      const io = (global as any).io;
      if (io) {
        io.to(`couple:${me.coupleId}`).emit('match:accepted', { matchId: match.id });
        io.to(`couple:${targetCouple.coupleId}`).emit('match:accepted', { matchId: match.id });
      }
    }

    return { isMatch: true, matchId: match.id, otherCoupleId };
  }

  async acceptMatch(requestingCoupleId: string, targetCoupleIdStr: string, coupleMongoId?: string, matchId?: string) {
    const me = coupleMongoId
      ? await prisma.couple.findUnique({ where: { id: coupleMongoId }, select: { coupleId: true } })
      : await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId }, select: { coupleId: true } });
    if (!me) throw new AppError('Profile not found', 404);

    // Prefer exact matchId from notification — avoids picking the wrong pending row.
    if (matchId) {
      const match = await prisma.match.findUnique({ where: { id: matchId } });
      if (!match) {
        return this.sayHello(requestingCoupleId, targetCoupleIdStr, coupleMongoId);
      }

      const iAmInvolved =
        match.couple1Id === me.coupleId || match.couple2Id === me.coupleId;
      if (!iAmInvolved) {
        return this.sayHello(requestingCoupleId, targetCoupleIdStr, coupleMongoId);
      }

      if (match.status === 'accepted') {
        return { isMatch: true, matchId: match.id };
      }

      if (match.status === 'pending') {
        if (match.actionById === me.coupleId) {
          return { isMatch: false, reason: 'outgoing_pending' };
        }
        return this.acceptPendingMatchRecord(match, me);
      }
    }

    return this.sayHello(requestingCoupleId, targetCoupleIdStr, coupleMongoId);
  }

  async rejectMatch(requestingCoupleId: string, targetCoupleIdStr: string) {
    const me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId }, select: { id: true, coupleId: true } });
    if (!me) throw new AppError('Profile not found', 404);

    const target = await prisma.couple.findFirst({
        where: { OR: [{ id: targetCoupleIdStr }, { coupleId: targetCoupleIdStr }] },
        select: { id: true, coupleId: true }
    });
    if (!target) throw new AppError('Target profile not found', 404);

    await prisma.match.deleteMany({
      where: {
        OR: [{ couple1Id: me.coupleId, couple2Id: target.coupleId }, { couple1Id: target.coupleId, couple2Id: me.coupleId }],
        status: 'pending'
      }
    });

    const notification = await prisma.notification.create({
        data: {
          recipientId: target.coupleId,
          senderId: me.coupleId,
          type: 'system',
          title: "Connection Update",
          message: "A couple decided not to connect at this time.",
        }
    });

    emitRealtimeNotification(target.coupleId, {
      notificationId: notification.id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      data: notification.data,
    });

    return { success: true };
  }

  async refreshDiscovery(requestingCoupleId: string) {
    const me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId }, select: { id: true, coupleId: true } });
    if (!me) throw new AppError('Profile not found', 404);

    await prisma.match.deleteMany({
      where: {
        OR: [{ couple1Id: me.coupleId }, { couple2Id: me.coupleId }],
        status: { in: ['skipped', 'pending'] }
      }
    });

    return { success: true };
  }

  async blockCouple(requestingCoupleId: string, targetCoupleIdStr: string) {
    const me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId }, select: { coupleId: true } });
    if (!me) throw new AppError('Profile not found', 404);

    const target = await prisma.couple.findFirst({
      where: { OR: [{ id: targetCoupleIdStr }, { coupleId: targetCoupleIdStr }] },
      select: { coupleId: true }
    });
    if (!target) throw new AppError('Target profile not found', 404);

    // 1. Add to blocked list
    await prisma.couple.update({
      where: { coupleId: me.coupleId },
      data: {
        blocked: {
          push: target.coupleId
        }
      }
    });

    // 2. Destroy matches permanently
    await prisma.match.deleteMany({
      where: {
        OR: [{ couple1Id: me.coupleId, couple2Id: target.coupleId }, { couple2Id: me.coupleId, couple1Id: target.coupleId }]
      }
    });

    // 3. Emit event to trigger UI refresh for blocker
    const io = (global as any).io;
    if (io) {
      io.to(`couple:${me.coupleId}`).emit('match:accepted', { 
        targetCoupleId: target.coupleId, 
        action: 'blocked' 
      });
    }

    return { success: true };
  }
}

export const matchService = new MatchService();
