import { prisma } from '../lib/prisma';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import { emitRealtimeNotification } from '../utils/realtime';
import { upsertGroupedNotification } from './notification.service';
import { i18nData } from '../i18n/notif';
import { cacheGet, cacheSet, cacheInvalidatePattern } from '../lib/cache';
import { materializeImageLoose } from '../lib/storage';

/** Normalize a cover image field (base64/data-uri/url) to a stored S3 URL. */
async function materializeCover(
  value: string | undefined | null,
  coupleId?: string,
): Promise<string | undefined> {
  return (await materializeImageLoose(value, coupleId)) ?? undefined;
}

// Shared TTL cache for getAllCommunities — avoids repeated heavy queries for
// the same user within 30 seconds. Backed by Redis so hits AND invalidations
// (join/leave/create/invite) are consistent across PM2 cluster workers; falls
// back to an in-process map automatically when Redis isn't configured.
const COMM_CACHE_TTL_SECONDS = 30;

function commCacheKey(coupleId: string, city?: string) {
  return `sawa:commlist:${coupleId}:${city ?? ''}`;
}

export class CommunityService {

  async getAllCommunities(requestingCoupleId: string, cityFilter?: string) {
    // Serve from cache if still fresh
    const cacheKey = commCacheKey(requestingCoupleId, cityFilter);
    const cachedRaw = await cacheGet(cacheKey);
    if (cachedRaw) {
      try {
        return JSON.parse(cachedRaw);
      } catch {
        /* corrupt entry — fall through and rebuild */
      }
    }
    const me = await prisma.couple.findUnique({
      where: { coupleId: requestingCoupleId },
      select: { coupleId: true, blocked: true },
    });
    if (!me) throw new AppError('Profile not found', 404);

    const SUPPORTED_CITIES = ['Bangalore', 'Chennai', 'New Delhi', 'Delhi', 'Mumbai', 'Gurgaon', 'Noida', 'Hyderabad', 'Goa'];

    const where: any = {};
    if (cityFilter && !['All City', 'All Cities', 'Unknown'].includes(cityFilter)) {
       const isSupported = SUPPORTED_CITIES.some(c => cityFilter.toLowerCase().includes(c.toLowerCase()));
       if (isSupported) {
          where.city = { contains: cityFilter, mode: 'insensitive' };
       }
    }

    if (me.blocked && me.blocked.length > 0) {
       where.id = { notIn: me.blocked };
    }

    const comms = await prisma.community.findMany({
      where,
      select: {
        id: true,
        name: true,
        description: true,
        city: true,
        coverImageUrl: true,
        _count: {
          select: { members: true }
        },
        members: { where: { coupleId: me.coupleId }, select: { coupleId: true } },
        admins: { where: { coupleId: me.coupleId }, select: { coupleId: true } },
        joinRequests: { where: { coupleId: me.coupleId }, select: { coupleId: true } }
      }
    });

    const invitedNotifications = await prisma.notification.findMany({
      where: {
        recipientId: me.coupleId,
        type: 'community',
      },
      select: {
        data: true,
      },
    });

    const invitedCommunityIds = new Set(
      invitedNotifications
        .map((notification: any) => String(notification?.data?.communityId || '').trim())
        .filter(Boolean),
    );

    const result = comms.map((c: any) => {
      const isMember = c.members.length > 0;
      const isAdmin = c.admins.length > 0;
      const isRequested = c.joinRequests.length > 0;
      const isInvited = invitedCommunityIds.has(c.id);
      const membersCount = c._count.members;
      
      return {
        _id: c.id,
        id: c.id,
        title: c.name,
        about: c.description,
        city: c.city,
        couples: membersCount,
        imageUri: c.coverImageUrl,
        isMember,
        isAdmin,
        isRequested,
        isInvited,
        members: Array.from({ length: Math.min(membersCount, 5) }).map((_, i) => ({
          _id: `member-${i}`,
          id: `member-${i}`,
          name: `Couple ${i + 1}`,
          city: c.city,
          accent: '#DBCBA6'
        }))
      };
    });

    // Store in cache (best-effort — never block the response on the write)
    await cacheSet(cacheKey, JSON.stringify(result), COMM_CACHE_TTL_SECONDS);
    return result;
  }

  // Invalidate all cache entries for a couple (call after join/leave/create/invite)
  async invalidateCommListCache(coupleId: string) {
    await cacheInvalidatePattern(`sawa:commlist:${coupleId}:*`);
  }

  async getMyCommunities(requestingCoupleId: string) {
    const me = await prisma.couple.findUnique({
      where: { coupleId: requestingCoupleId },
      select: { coupleId: true, blocked: true },
    });
    if (!me) throw new AppError('Profile not found', 404);

    const memberships = await prisma.communityMember.findMany({
      where: { 
        coupleId: me.coupleId,
        communityId: { notIn: me.blocked || [] }
      },
      select: {
        community: {
          select: {
            id: true,
            name: true,
            description: true,
            city: true,
            coverImageUrl: true,
            _count: { select: { members: true } },
            admins: { where: { coupleId: me.coupleId }, select: { coupleId: true } }
          }
        }
      }
    });

    return memberships.map((m: any) => {
      const c = m.community;
      const isAdmin = c.admins?.length > 0;
      return {
        _id: c.id,
        id: c.id,
        title: c.name,
        about: c.description,
        city: c.city,
        couples: c._count.members,
        imageUri: c.coverImageUrl,
        isMember: true,
        isAdmin,
        members: []
      };
    });
  }

  async createCommunity(requestingCoupleId: string, data: any) {
    const me = await prisma.couple.findUnique({
      where: { coupleId: requestingCoupleId },
      select: { coupleId: true, profileName: true, primaryPhoto: true },
    });
    if (!me) throw new AppError('Profile not found', 404);

    // Check for duplicate name up-front to give a clear error instead of a 500
    const existing = await prisma.community.findUnique({ where: { name: data.name }, select: { id: true } });
    if (existing) throw new AppError('A group with this name already exists. Please choose a different name.', 409);

    const coverImageUrl = await materializeCover(data.coverImageUrl, me.coupleId);

    const community = await prisma.community.create({
      data: {
        name: data.name,
        description: data.description,
        city: data.city,
        coverImageUrl,
        tags: data.tags || [],
        admins: { create: { coupleId: me.coupleId } },
        members: { create: { coupleId: me.coupleId } }
      }
    });

    if (data.invitedCoupleIds && data.invitedCoupleIds.length > 0) {
      // Process all invites in parallel instead of serially.
      await Promise.all(
        (data.invitedCoupleIds as string[]).map(async (rawId) => {
          try {
            const targetCouple = await prisma.couple.findUnique({
              where: rawId.includes('-') ? { coupleId: rawId } : { id: rawId },
              select: { coupleId: true },
            });
            if (!targetCouple) return;
            const targetCoupleId = targetCouple.coupleId;

            const match = await prisma.match.findFirst({
              where: {
                OR: [
                  { couple1Id: me.coupleId, couple2Id: targetCoupleId, status: 'accepted' },
                  { couple1Id: targetCoupleId, couple2Id: me.coupleId, status: 'accepted' },
                ],
              },
            });

            if (match) {
              const notification = await prisma.notification.create({
                data: {
                  recipientId: targetCoupleId,
                  senderId: me.coupleId,
                  type: 'community',
                  title: 'Group Invitation',
                  message: `${me.profileName} invited you to join ${community.name}`,
                  data: {
                    communityId: community.id,
                    name: community.name,
                    communityName: community.name,
                    isInvited: true,
                    invited: true,
                    status: 'invited',
                    ...i18nData('community.invite', { name: me.profileName ?? '', community: community.name }),
                  },
                },
              });
              emitRealtimeNotification(targetCoupleId, {
                notificationId: notification.id,
                type: notification.type,
                title: notification.title,
                message: notification.message,
                data: notification.data,
              });
            }
          } catch (err) {
            logger.error(`[CommunityService] Failed to notify couple ${rawId}: ${err}`);
          }
        }),
      );
    }

    await this.invalidateCommListCache(requestingCoupleId);
    return { _id: community.id, id: community.id, name: community.name };
  }

  
  async joinCommunity(requestingCoupleId: string, communityId: string) {
    const me = await prisma.couple.findUnique({
      where: { coupleId: requestingCoupleId },
      select: { coupleId: true, profileName: true, primaryPhoto: true },
    });
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
       
       // Clean up the invitation so it can't be reused after an exit
       await prisma.notification.deleteMany({
         where: { 
           recipientId: me.coupleId, 
           type: 'community', 
           data: { path: ['communityId'], equals: communityId } as any 
         }
       });

       return { status: 'joined' };
    }

    const isRequested = await prisma.communityJoinRequest.findUnique({
        where: { communityId_coupleId: { communityId, coupleId: me.coupleId } }
    });
    if (isRequested) return { status: 'already-requested' };

    await prisma.communityJoinRequest.create({ data: { communityId, coupleId: me.coupleId } });

    const community = await prisma.community.findUnique({
      where: { id: communityId },
      select: { name: true },
    });

    const admins = await prisma.communityAdmin.findMany({ where: { communityId } });
    const notificationData = {
      communityId,
      requestId: me.coupleId,
      requestType: 'join',
      requesterCoupleId: me.coupleId,
      requesterName: me.profileName,
      communityName: community?.name || 'Community',
      primaryPhoto: me.primaryPhoto || null,
      ...i18nData('community.joinRequest', { name: me.profileName ?? '' }),
    };

    // Notify all admins in parallel instead of sequentially.
    await Promise.all(
      admins.map((admin) =>
        upsertGroupedNotification({
          recipientId: admin.coupleId,
          senderId: me.coupleId,
          type: 'community',
          title: 'New Join Request',
          message: `${me.profileName} wants to join.`,
          groupKey: `community:join:${communityId}:${me.coupleId}`,
          data: notificationData,
        }),
      ),
    );

    await this.invalidateCommListCache(requestingCoupleId);
    return { status: 'requested' };
  }

  async leaveCommunity(requestingCoupleId: string, communityId: string) {
    const me = await prisma.couple.findUnique({
      where: { coupleId: requestingCoupleId },
      select: { coupleId: true },
    });
    if (!me) throw new AppError('Profile not found', 404);

    await prisma.communityMember.deleteMany({ where: { communityId, coupleId: me.coupleId } });
    await prisma.communityAdmin.deleteMany({ where: { communityId, coupleId: me.coupleId } });
    await prisma.communityJoinRequest.deleteMany({ where: { communityId, coupleId: me.coupleId } });

    // Ensure no old invitations linger after leaving
    await prisma.notification.deleteMany({
      where: { 
        recipientId: me.coupleId, 
        type: 'community', 
        data: { path: ['communityId'], equals: communityId } as any 
      }
    });

    const [remainingAdmins, remainingMembers] = await Promise.all([
      prisma.communityAdmin.findMany({ where: { communityId }, select: { coupleId: true } }),
      prisma.communityMember.findMany({ where: { communityId }, select: { coupleId: true } }),
    ]);

    if (remainingAdmins.length === 0 && remainingMembers.length > 0) {
      await prisma.communityAdmin.create({ data: { communityId, coupleId: remainingMembers[0].coupleId } });
    }

    if (remainingMembers.length === 0) {
      // Manual cascade delete
      await prisma.$transaction([
        prisma.message.deleteMany({ where: { communityId } }),
        prisma.communityAdmin.deleteMany({ where: { communityId } }),
        prisma.communityJoinRequest.deleteMany({ where: { communityId } }),
        prisma.community.delete({ where: { id: communityId } })
      ]);
      await this.invalidateCommListCache(requestingCoupleId);
      return { status: 'deleted' };
    }

    await this.invalidateCommListCache(requestingCoupleId);
    return { status: 'left' };
  }

  async processJoinRequest(requestingCoupleId: string, communityId: string, requestId: string, decision: 'accept' | 'reject') {
    const me = await prisma.couple.findUnique({
      where: { coupleId: requestingCoupleId },
      select: { coupleId: true },
    });
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

    await prisma.notification.deleteMany({
      where: {
        senderId: targetId,
        type: 'community',
        title: 'New Join Request',
        data: { path: ['communityId'], equals: communityId } as any,
      },
    });

    if (decision === 'accept') {
       await prisma.communityMember.upsert({
           where: { communityId_coupleId: { communityId, coupleId: targetId } },
           update: {},
           create: { communityId, coupleId: targetId }
       });

       const notification = await prisma.notification.create({
          data: {
             recipientId: targetId,
             senderId: me.coupleId,
             type: 'community',
             title: 'Request Accepted!',
             message: `You joined the group!`,
             data: { communityId, requestType: 'accepted', ...i18nData('community.requestAccepted') },
          },
       });

       emitRealtimeNotification(targetId, {
         notificationId: notification.id,
         type: notification.type,
         title: notification.title,
         message: notification.message,
         data: notification.data,
       });
       return { message: 'Accepted' };
    }
    return { message: 'Rejected' };
  }

  async getCommunityDetail(requestingCoupleId: string, communityId: string) {
    const me = await prisma.couple.findUnique({
      where: { coupleId: requestingCoupleId },
      select: { coupleId: true },
    });
    if (!me) throw new AppError('Profile not found', 404);

    const COUPLE_DETAIL_SELECT = {
      id: true, coupleId: true, profileName: true, primaryPhoto: true, locationCity: true,
    } as const;

    const c = await prisma.community.findUnique({
      where: { id: communityId },
      select: {
        id: true, name: true, description: true, city: true, coverImageUrl: true,
        members: {
          select: { coupleId: true, couple: { select: COUPLE_DETAIL_SELECT } },
        },
        admins: {
          select: { coupleId: true, couple: { select: COUPLE_DETAIL_SELECT } },
        },
        joinRequests: {
          select: { coupleId: true, couple: { select: COUPLE_DETAIL_SELECT } },
        },
      },
    });

    if (!c) throw new AppError('Not found', 404);

    const isMember = c.members.some((m: any) => m.coupleId === me.coupleId);
    const isAdmin = c.admins.some((a: any) => a.coupleId === me.coupleId);
    const isRequested = c.joinRequests.some((r: any) => r.coupleId === me.coupleId);

    const memberCoupleIds = c.members
      .map((m: any) => m.coupleId)
      .filter((coupleId: string) => coupleId && coupleId !== me.coupleId);

    const acceptedMatches = memberCoupleIds.length
      ? await prisma.match.findMany({
          where: {
            status: 'accepted',
            OR: [
              { couple1Id: me.coupleId, couple2Id: { in: memberCoupleIds } },
              { couple2Id: me.coupleId, couple1Id: { in: memberCoupleIds } }
            ]
          },
          select: {
            id: true,
            couple1Id: true,
            couple2Id: true
          }
        })
      : [];

    const acceptedMatchByCoupleId = new Map(
      acceptedMatches.map((match: any) => [
        match.couple1Id === me.coupleId ? match.couple2Id : match.couple1Id,
        match
      ])
    );
    
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
      members: c.members.map((m: any) => {
        const matchedConnection = acceptedMatchByCoupleId.get(m.couple.coupleId);

        return {
          id: m.couple.id,
          coupleId: m.couple.coupleId,
          name: m.couple.profileName,
          city: m.couple.locationCity || 'Unknown',
          accent: '#DBCBA6',
          image: m.couple.primaryPhoto,
          isAlreadyMatched: !!matchedConnection,
          matchId: matchedConnection?.id || null
        };
      }),
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

  async updateCommunity(
    requestingCoupleId: string,
    communityId: string,
    data: { name?: string; description?: string; coverImageUrl?: string; coverImageBase64?: string },
  ) {
    const me = await prisma.couple.findUnique({
      where: { coupleId: requestingCoupleId },
      select: { coupleId: true },
    });
    if (!me) throw new AppError('Profile not found', 404);

    const isAdmin = await prisma.communityAdmin.findUnique({
      where: { communityId_coupleId: { communityId, coupleId: me.coupleId } },
    });
    if (!isAdmin) throw new AppError('Only community admins can edit this community', 403);

    const updateData: Record<string, any> = {};
    if (data.name?.trim()) updateData.name = data.name.trim();
    if (data.description !== undefined) updateData.description = data.description;
    if (data.coverImageBase64 && data.coverImageBase64.length > 10) {
      updateData.coverImageUrl = await materializeCover(data.coverImageBase64, me.coupleId);
    } else if (data.coverImageUrl !== undefined) {
      updateData.coverImageUrl = await materializeCover(data.coverImageUrl, me.coupleId);
    }

    const community = await prisma.community.update({
      where: { id: communityId },
      data: updateData,
    });

    // A renamed/re-covered group used to keep its old identity in every
    // member's list for up to ~45s (30s server cache + 15s client cache) —
    // join/leave/create all invalidate; edit was the one writer that didn't.
    await this.invalidateCommListCache(requestingCoupleId);

    return community;
  }

  async deleteCommunity(requestingCoupleId: string, communityId: string) {
    const me = await prisma.couple.findUnique({
      where: { coupleId: requestingCoupleId },
      select: { coupleId: true },
    });
    if (!me) throw new AppError('Profile not found', 404);

    const isAdmin = await prisma.communityAdmin.findUnique({
      where: { communityId_coupleId: { communityId, coupleId: me.coupleId } }
    });
    if (!isAdmin) throw new AppError('Admin only', 403);

    // Manual cascade delete because relations aren't set to CASCADE in prisma
    await prisma.$transaction([
      prisma.message.deleteMany({ where: { communityId } }),
      prisma.communityMember.deleteMany({ where: { communityId } }),
      prisma.communityAdmin.deleteMany({ where: { communityId } }),
      prisma.communityJoinRequest.deleteMany({ where: { communityId } }),
      prisma.community.delete({ where: { id: communityId } })
    ]);

    return { success: true };
  }

  async getInviteableCouples(requestingCoupleId: string, communityId: string) {
    const me = await prisma.couple.findUnique({
      where: { coupleId: requestingCoupleId },
      select: { coupleId: true },
    });
    if (!me) throw new AppError('Profile not found', 404);

    const INVITE_COUPLE_SELECT = {
      id: true, coupleId: true, profileName: true, primaryPhoto: true, locationCity: true,
    } as const;

    const [matches, members] = await Promise.all([
      prisma.match.findMany({
        where: { OR: [{ couple1Id: me.coupleId }, { couple2Id: me.coupleId }], status: 'accepted' },
        select: {
          id: true, couple1Id: true, couple2Id: true,
          couple1: { select: INVITE_COUPLE_SELECT },
          couple2: { select: INVITE_COUPLE_SELECT },
        },
      }),
      prisma.communityMember.findMany({ where: { communityId }, select: { coupleId: true } }),
    ]);
    const memberIds = members.map(m => m.coupleId);

    const matchedCoupleIds = matches
      .map((match: any) => (match.couple1Id === me.coupleId ? match.couple2Id : match.couple1Id))
      .filter(Boolean);

    const invitationNotifications =
      matchedCoupleIds.length > 0
        ? await prisma.notification.findMany({
            where: {
              recipientId: { in: matchedCoupleIds },
              type: 'community',
            },
            select: {
              recipientId: true,
              data: true,
            },
          })
        : [];

    const invitedCoupleIds = new Set(
      invitationNotifications
        .filter((notification: any) => notification?.data?.communityId === communityId)
        .map((notification: any) => notification.recipientId),
    );

    return matches.map((m: any) => {
      const other = m.couple1Id === me.coupleId ? m.couple2 : m.couple1;
      const status = memberIds.includes(other.coupleId)
        ? 'member'
        : invitedCoupleIds.has(other.coupleId)
          ? 'invited'
          : 'available';

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
    const me = await prisma.couple.findUnique({
      where: { coupleId: requestingCoupleId },
      select: { coupleId: true, profileName: true },
    });
    if (!me) throw new AppError('Profile not found', 404);

    const community = await prisma.community.findUnique({ where: { id: communityId } });
    if (!community) throw new AppError('Community not found', 404);

    // Authorization: only a member of the community may invite other couples.
    // Without this any authenticated user could spam invites for any community.
    const membership = await prisma.communityMember.findUnique({
      where: { communityId_coupleId: { communityId, coupleId: me.coupleId } },
    });
    if (!membership) throw new AppError('Only members can invite couples to this community', 403);

    // Process all invites in parallel instead of sequentially.
    await Promise.all(
      invitedCoupleIds.map(async (rawId) => {
        try {
          const targetCouple = await prisma.couple.findUnique({
            where: rawId.includes('-') ? { coupleId: rawId } : { id: rawId },
            select: { coupleId: true },
          });
          if (!targetCouple) return;

          const [isAlreadyMember, existingInvite] = await Promise.all([
            prisma.communityMember.findUnique({
              where: { communityId_coupleId: { communityId, coupleId: targetCouple.coupleId } },
            }),
            prisma.notification.findFirst({
              where: {
                recipientId: targetCouple.coupleId,
                type: 'community',
                data: { path: ['communityId'], equals: community.id } as any,
              },
            }),
          ]);

          if (isAlreadyMember) return;

          if (existingInvite) {
            emitRealtimeNotification(targetCouple.coupleId, {
              notificationId: existingInvite.id,
              type: existingInvite.type,
              title: existingInvite.title,
              message: existingInvite.message,
              data: existingInvite.data,
            });
            return;
          }

          const notification = await prisma.notification.create({
            data: {
              recipientId: targetCouple.coupleId,
              senderId: me.coupleId,
              type: 'community',
              title: 'Group Invitation',
              message: `${me.profileName} invited you to join ${community.name}`,
              data: {
                communityId: community.id,
                name: community.name,
                communityName: community.name,
                isInvited: true,
                invited: true,
                status: 'invited',
                ...i18nData('community.invite', { name: me.profileName ?? '', community: community.name }),
              },
            },
          });
          emitRealtimeNotification(targetCouple.coupleId, {
            notificationId: notification.id,
            type: notification.type,
            title: notification.title,
            message: notification.message,
            data: notification.data,
          });
        } catch (err) {
          logger.error(`[CommunityService] Failed to invite couple ${rawId}: ${err}`);
        }
      }),
    );
    return { success: true };
  }
}

export const communityService = new CommunityService();
