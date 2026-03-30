import { prisma } from '../lib/prisma';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

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

    // Get interacted IDs
    const interactions = await prisma.match.findMany({
      where: { couple1Id: me.coupleId },
      select: { couple2Id: true }
    });
    const interactedIds = interactions.map((m: any) => m.couple2Id);

    const where: any = {
      coupleId: { not: me.coupleId, notIn: [...interactedIds, ...blockedIds] },
      isProfileComplete: true,
    };

    if (cityFilter && cityFilter !== 'All City' && cityFilter !== 'All Cities' && cityFilter !== 'Unknown') {
       const isSupported = SUPPORTED_CITIES.some(c => cityFilter.toLowerCase().includes(c.toLowerCase()));
       if (isSupported) {
          where.locationCity = { contains: cityFilter, mode: 'insensitive' };
       }
    }

    const potentialCouples = await prisma.couple.findMany({
      where,
      take: 10,
      select: {
        id: true,
        coupleId: true,
        profileName: true,
        primaryPhoto: true,
        locationCity: true,
      }
    });

    return potentialCouples.map((c: any) => ({
      _id: c.id,
      coupleId: c.coupleId,
      profileName: c.profileName,
      primaryPhoto: c.primaryPhoto || 'https://images.unsplash.com/photo-1511285560929-80b456fea0bc?auto=format&fit=crop&w=400&q=80',
      location: c.locationCity || 'Unknown',
      distance: Math.floor(Math.random() * 10) + 2 + ' km away',
      tags: ['Discovery', 'Adventure', 'Book', 'Fitness'].sort(() => 0.5 - Math.random()).slice(0, 3), 
      matchScore: Math.floor(Math.random() * 20) + 80, 
      insights: [
        'Both career-focused and socially intentional',
        'Similar pace - you both prefer meeting once or twice a month',
      ]
    }));
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

    let existingMatch = await prisma.match.findFirst({
      where: {
        OR: [
          { couple1Id: me.coupleId, couple2Id: targetCouple.coupleId },
          { couple1Id: targetCouple.coupleId, couple2Id: me.coupleId }
        ]
      }
    });

    if (existingMatch) {
      if (existingMatch.status === 'pending' && existingMatch.actionById !== me.coupleId) {
          // Mutual like
          await prisma.match.update({
            where: { id: existingMatch.id },
            data: { status: 'accepted', actionById: me.coupleId }
          });

          await prisma.notification.createMany({
            data: [
              {
                recipientId: me.coupleId,
                senderId: targetCouple.coupleId,
                type: 'match',
                title: "You've Connected!",
                message: `You connected with ${targetCouple.profileName}!`,
                data: { 
                  matchId: existingMatch.id, 
                  coupleId: targetCouple.coupleId, 
                  profileName: targetCouple.profileName,
                  primaryPhoto: targetCouple.primaryPhoto,
                  location: targetCouple.locationCity,
                  bio: targetCouple.bio,
                  tags: targetCouple.activities, // Use activities for tags
                  vibes: targetCouple.socialVibes,
                  matchCriteria: targetCouple.matchCriteria,
                  isPending: false 
                }
              },
              {
                recipientId: targetCouple.coupleId,
                senderId: me.coupleId,
                type: 'match',
                title: "You've Connected!",
                message: `You connected with ${me.profileName}!`,
                data: { 
                  matchId: existingMatch.id, 
                  coupleId: me.coupleId, 
                  profileName: me.profileName,
                  primaryPhoto: me.primaryPhoto,
                  location: me.locationCity,
                  bio: me.bio,
                  tags: me.activities, // Use activities for tags
                  vibes: me.socialVibes,
                  matchCriteria: me.matchCriteria,
                  isPending: false 
                }
              }
            ]
          });

          return { isMatch: true, matchId: existingMatch.id };
       }
      
      return { isMatch: existingMatch.status === 'accepted', matchId: existingMatch.id };
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
        await prisma.notification.create({
          data: {
            recipientId: targetCouple!.coupleId,
            senderId: me!.coupleId,
            type: 'match',
            title: 'New Connection Request!',
            message: `${me!.profileName} wants to connect with you!`,
              data: { 
                matchId: newMatch.id, 
                _id: newMatch.id, 
                coupleId: me!.coupleId, 
                profileName: me!.profileName, 
                primaryPhoto: me!.primaryPhoto,
                location: me!.locationCity,
                bio: me!.bio,
                tags: me!.activities, // Use activities for tags
                vibes: me!.socialVibes,
                matchCriteria: me!.matchCriteria,
                isPending: true 
              }
          }
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

    await prisma.match.create({
      data: { 
          couple1Id: me.coupleId, 
          couple2Id: target.coupleId, 
          status: 'skipped', 
          actionById: me.coupleId 
      }
    });

    return { skipped: true };
  }

  async getIncomingRequests(requestingCoupleId: string, coupleMongoId?: string) {
    let meId;
    if (coupleMongoId) {
      const meProfile = await prisma.couple.findUnique({ where: { id: coupleMongoId }, select: { coupleId: true } });
      if (!meProfile) throw new AppError('Profile not found', 404);
      meId = meProfile.coupleId;
    } else {
      const me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId }, select: { id: true, coupleId: true } });
      if (!me) throw new AppError('Profile not found', 404);
      meId = me.coupleId;
    }

    const pending = await prisma.match.findMany({ 
      where: { couple2Id: meId, status: 'pending' },
      include: { couple1: true }
    });

    return pending.map((m: any) => {
      const otherCouple = m.couple1;
      if (!otherCouple) return null;

      return {
        _id: m.id,
        id: m.id,
        coupleId: otherCouple.coupleId,
        profileName: otherCouple.profileName || 'Someone',
        primaryPhoto: otherCouple.primaryPhoto,
        location: otherCouple.locationCity || 'Unknown',
        distance: Math.floor(Math.random() * 8) + 1 + 'km away',
        status: 'pending',
        createdAt: m.createdAt
      };
    }).filter(Boolean);
  }

  async getMatches(requestingCoupleId: string, coupleMongoId?: string) {
    let meId: string;
    if (coupleMongoId) {
      const meProfile = await prisma.couple.findUnique({ where: { id: coupleMongoId }, select: { coupleId: true } });
      if (!meProfile) throw new AppError('Profile not found', 404);
      meId = meProfile.coupleId;
    } else {
      const me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId }, select: { id: true, coupleId: true } });
      if (!me) throw new AppError('Profile not found', 404);
      meId = me.coupleId;
    }

    const matches = await prisma.match.findMany({ 
      where: { OR: [{ couple1Id: meId }, { couple2Id: meId }], status: 'accepted' },
      select: {
        id: true,
        couple1Id: true,
        couple2Id: true,
        status: true,
        createdAt: true,
        couple1: { select: { id: true, coupleId: true, profileName: true, primaryPhoto: true, locationCity: true } },
        couple2: { select: { id: true, coupleId: true, profileName: true, primaryPhoto: true, locationCity: true } }
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
          distance: Math.floor(Math.random() * 8) + 1 + 'km away',
          status: m.status,
          createdAt: m.createdAt
        };
    }).filter(Boolean);
  }

  async acceptMatch(requestingCoupleId: string, targetCoupleIdStr: string, coupleMongoId?: string) {
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

    await prisma.notification.create({
        data: {
          recipientId: target.coupleId,
          senderId: me.coupleId,
          type: 'system',
          title: "Connection Update",
          message: "A couple decided not to connect at this time.",
        }
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
