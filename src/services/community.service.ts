import { prisma } from '../lib/prisma';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

export class CommunityService {

  async getAllCommunities(requestingCoupleId: string, cityFilter?: string) {
    const me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId } });
    if (!me) throw new AppError('Profile not found', 404);

    const SUPPORTED_CITIES = ['Bangalore', 'Chennai', 'New Delhi', 'Delhi', 'Mumbai', 'Gurgaon', 'Noida', 'Hyderabad', 'Goa'];

    const where: any = {};
    if (cityFilter && !['All City', 'All Cities', 'Unknown'].includes(cityFilter)) {
       const isSupported = SUPPORTED_CITIES.some(c => cityFilter.toLowerCase().includes(c.toLowerCase()));
       if (isSupported) {
          where.city = { contains: cityFilter, mode: 'insensitive' };
       }
    }

    const comms = await prisma.community.findMany({
      where,
      include: {
        members: true,
        admins: true,
        joinRequests: { where: { coupleId: me.coupleId } }
      }
    });

    return comms.map((c: any) => {
      const isMember = c.members.some((m: any) => m.coupleId === me.coupleId);
      const isAdmin = c.admins.some((a: any) => a.coupleId === me.coupleId);
      const isRequested = c.joinRequests.length > 0;
      
      return {
        _id: c.id,
        id: c.id,
        title: c.name,
        about: c.description,
        city: c.city,
        couples: c.members.length,
        imageUri: c.coverImageUrl,
        isMember,
        isAdmin,
        isRequested,
        members: Array.from({ length: c.members.length }).map((_, i) => ({
          _id: `member-${i}`,
          id: `member-${i}`,
          name: `Couple ${i + 1}`,
          city: c.city,
          accent: '#DBCBA6'
        }))
      };
    });
  }

  async getMyCommunities(requestingCoupleId: string) {
    const me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId } });
    if (!me) throw new AppError('Profile not found', 404);

    const memberships = await prisma.communityMember.findMany({
      where: { coupleId: me.coupleId },
      include: {
        community: {
          include: {
            members: true,
            admins: true
          }
        }
      }
    });

    return memberships.map((m: any) => {
      const c = m.community;
      const isAdmin = c.admins.some((a: any) => a.coupleId === me.coupleId);
      return {
        _id: c.id,
        id: c.id,
        title: c.name,
        about: c.description,
        city: c.city,
        couples: c.members.length,
        imageUri: c.coverImageUrl,
        isMember: true,
        isAdmin,
        members: []
      };
    });
  }

  async createCommunity(requestingCoupleId: string, data: any) {
    const me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId } });
    if (!me) throw new AppError('Profile not found', 404);

    const community = await prisma.community.create({
      data: {
        name: data.name,
        description: data.description,
        city: data.city,
        coverImageUrl: data.coverImageUrl,
        tags: data.tags || [],
        admins: { create: { coupleId: me.coupleId } },
        members: { create: { coupleId: me.coupleId } }
      }
    });

    if (data.invitedCoupleIds && data.invitedCoupleIds.length > 0) {
      for (const rawId of data.invitedCoupleIds) {
        try {
          const targetCouple = await prisma.couple.findUnique({
            where: rawId.includes('-') ? { coupleId: rawId } : { id: rawId },
            select: { coupleId: true }
          });
          if (!targetCouple) continue;
          const targetCoupleId = targetCouple.coupleId;

          const match = await prisma.match.findFirst({
            where: {
              OR: [
                { couple1Id: me.coupleId, couple2Id: targetCoupleId, status: 'accepted' },
                { couple1Id: targetCoupleId, couple2Id: me.coupleId, status: 'accepted' }
              ]
            }
          });

          if (match) {
            await prisma.notification.create({
              data: {
                recipientId: targetCoupleId,
                senderId: me.coupleId,
                type: 'community',
                title: 'Community Invitation',
                message: `${me.profileName} invited you to join ${community.name}`,
                data: { communityId: community.id, name: community.name }
              }
            });
          }
        } catch (err) {
          logger.error(`[CommunityService] Failed to notify couple ${rawId}: ${err}`);
        }
      }
    }

    return { _id: community.id, id: community.id, name: community.name };
  }

  
  async joinCommunity(requestingCoupleId: string, communityId: string) {
    const me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId } });
    if (!me) throw new AppError('Profile not found', 404);

    const isMember = await prisma.communityMember.findUnique({
        where: { communityId_coupleId: { communityId, coupleId: me.coupleId } }
    });
    if (isMember) return { status: 'already-member' };

    const invitation = await prisma.notification.findFirst({
      where: { recipientId: me.coupleId, type: 'community', data: { path: ['communityId'], equals: communityId } as any }
    });

    if (invitation) {
       await prisma.communityMember.create({ data: { communityId, coupleId: me.coupleId } });
       return { status: 'joined' };
    }

    const isRequested = await prisma.communityJoinRequest.findUnique({
        where: { communityId_coupleId: { communityId, coupleId: me.coupleId } }
    });
    if (isRequested) return { status: 'already-requested' };

    await prisma.communityJoinRequest.create({ data: { communityId, coupleId: me.coupleId } });

    const admins = await prisma.communityAdmin.findMany({ where: { communityId } });
    for (const admin of admins) {
      await prisma.notification.create({
        data: {
          recipientId: admin.coupleId,
          senderId: me.coupleId,
          type: 'community',
          title: 'New Join Request',
          message: `${me.profileName} wants to join.`,
          data: { communityId, requestId: me.coupleId }
        }
      });
    }

    return { status: 'requested' };
  }

  async leaveCommunity(requestingCoupleId: string, communityId: string) {
    const me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId } });
    if (!me) throw new AppError('Profile not found', 404);

    await prisma.communityMember.deleteMany({ where: { communityId, coupleId: me.coupleId } });
    await prisma.communityAdmin.deleteMany({ where: { communityId, coupleId: me.coupleId } });

    const remainingAdmins = await prisma.communityAdmin.findMany({ where: { communityId } });
    const remainingMembers = await prisma.communityMember.findMany({ where: { communityId } });

    if (remainingAdmins.length === 0 && remainingMembers.length > 0) {
      await prisma.communityAdmin.create({ data: { communityId, coupleId: remainingMembers[0].coupleId } });
    }

    if (remainingMembers.length === 0) {
      await prisma.community.delete({ where: { id: communityId } });
      return { status: 'deleted' };
    }

    return { status: 'left' };
  }

  async processJoinRequest(requestingCoupleId: string, communityId: string, requestId: string, decision: 'accept' | 'reject') {
    const me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId } });
    if (!me) throw new AppError('Profile not found', 404);

    const isAdmin = await prisma.communityAdmin.findUnique({
        where: { communityId_coupleId: { communityId, coupleId: me.coupleId } }
    });
    if (!isAdmin) throw new AppError('Admin only', 403);

    // The requestId from the frontend might be the Mongo-style ID (CUID). 
    // We must resolve it to the business ID (UUID) for the CommunityMember relation.
    const targetCouple = await prisma.couple.findUnique({
      where: requestId.includes('-') ? { coupleId: requestId } : { id: requestId },
      select: { coupleId: true }
    });
    if (!targetCouple) throw new AppError('Couple not found', 404);
    const targetId = targetCouple.coupleId;

    await prisma.communityJoinRequest.deleteMany({ where: { communityId, coupleId: targetId } });

    if (decision === 'accept') {
       await prisma.communityMember.upsert({
           where: { communityId_coupleId: { communityId, coupleId: targetId } },
           update: {},
           create: { communityId, coupleId: targetId }
       });

       await prisma.notification.create({
          data: {
             recipientId: targetId,
             senderId: me.coupleId,
             type: 'community',
             title: 'Request Accepted!',
             message: `You joined the community!`,
             data: { communityId }
          }
       });
       return { message: 'Accepted' };
    }
    return { message: 'Rejected' };
  }

  async getCommunityDetail(requestingCoupleId: string, communityId: string) {
    const me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId } });
    if (!me) throw new AppError('Profile not found', 404);

    const c = await prisma.community.findUnique({
      where: { id: communityId },
      include: {
        members: { include: { couple: true } },
        admins: { include: { couple: { include: { partner1: true, partner2: true } } } },
        joinRequests: { include: { couple: true } }
      }
    });

    if (!c) throw new AppError('Not found', 404);

    const isMember = c.members.some((m: any) => m.coupleId === me.coupleId);
    const isAdmin = c.admins.some((a: any) => a.coupleId === me.coupleId);
    const isRequested = c.joinRequests.some((r: any) => r.coupleId === me.coupleId);
    
    const invitation = await prisma.notification.findFirst({
        where: { recipientId: me.coupleId, type: 'community', data: { path: ['communityId'], equals: communityId } as any }
    });
    
    const hosts = c.admins.map(a => ({
        id: a.couple.id,
        coupleId: a.couple.coupleId,
        name: a.couple.profileName || 'Host',
        city: a.couple.locationCity || 'Unknown',
        accent: '#DBCBA6',
        image: a.couple.primaryPhoto
    }));

    return {
      id: c.id,
      title: c.name,
      about: c.description,
      city: c.city,
      couples: c.members.length,
      imageUri: c.coverImageUrl,
      isMember,
      isAdmin,
      isRequested,
      isInvited: !!invitation,
      hosts,
      members: c.members.map((m: any) => ({
        id: m.couple.id,
        coupleId: m.couple.coupleId,
        name: m.couple.profileName,
        city: m.couple.locationCity || 'Unknown',
        accent: '#DBCBA6',
        image: m.couple.primaryPhoto
      })),
      joinRequests: isAdmin ? c.joinRequests.map((r: any) => ({
        id: r.couple.id,
        coupleId: r.couple.coupleId,
        name: r.couple.profileName,
        city: r.couple.locationCity || 'Unknown',
        accent: '#3CA6C7',
        image: r.couple.primaryPhoto
      })) : []
    };
  }

  async deleteCommunity(requestingCoupleId: string, communityId: string) {
    const me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId } });
    if (!me) throw new AppError('Profile not found', 404);

    const isAdmin = await prisma.communityAdmin.findUnique({
        where: { communityId_coupleId: { communityId, coupleId: me.coupleId } }
    });
    if (!isAdmin) throw new AppError('Admin only', 403);

    await prisma.community.delete({ where: { id: communityId } });
    return { success: true };
  }

  async getInviteableCouples(requestingCoupleId: string, communityId: string) {
    const me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId } });
    if (!me) throw new AppError('Profile not found', 404);

    const matches = await prisma.match.findMany({
      where: { OR: [{ couple1Id: me.coupleId }, { couple2Id: me.coupleId }], status: 'accepted' },
      include: { couple1: true, couple2: true }
    });

    const members = await prisma.communityMember.findMany({ where: { communityId } });
    const memberIds = members.map(m => m.coupleId);

    return matches.map((m: any) => {
      const other = m.couple1Id === me.coupleId ? m.couple2 : m.couple1;
      const status = memberIds.includes(other.coupleId) ? 'member' : 'available';

      return {
        id: other.id,
        coupleId: other.coupleId,
        name: other.profileName,
        city: other.locationCity || 'India',
        image: other.primaryPhoto,
        status
      };
    });
  }

  async inviteToCommunity(requestingCoupleId: string, communityId: string, invitedCoupleIds: string[]) {
    const me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId } });
    if (!me) throw new AppError('Profile not found', 404);

    const community = await prisma.community.findUnique({ where: { id: communityId } });
    if (!community) throw new AppError('Community not found', 404);

    for (const rawId of invitedCoupleIds) {
      try {
        const targetCouple = await prisma.couple.findUnique({
          where: rawId.includes('-') ? { coupleId: rawId } : { id: rawId },
          select: { coupleId: true }
        });
        if (!targetCouple) continue;

        await prisma.notification.create({
          data: {
            recipientId: targetCouple.coupleId,
            senderId: me.coupleId,
            type: 'community',
            title: 'Community Invitation',
            message: `${me.profileName} invited you to join ${community.name}`,
            data: { communityId: community.id, name: community.name }
          }
        });
      } catch (err) {
        logger.error(`[CommunityService] Failed to invite couple ${rawId}: ${err}`);
      }
    }
    return { success: true };
  }
}

export const communityService = new CommunityService();
