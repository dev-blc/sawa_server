import { prisma } from '../lib/prisma';
import { invalidateBanCache } from '../middleware/authenticate';
import { emitRealtimeNotification } from '../utils/realtime';
import { logger } from '../utils/logger';

/**
 * Inactivity threshold (days). A user with no `lastActiveAt` ping in this
 * window is considered inactive in the admin tables. Configurable via env;
 * defaults to 7 days per stakeholder requirement.
 */
const INACTIVITY_DAYS = Number(process.env.INACTIVITY_DAYS || 7);

const isInactive = (lastActiveAt: Date | null | undefined): boolean => {
  if (!lastActiveAt) return true;
  const cutoff = Date.now() - INACTIVITY_DAYS * 24 * 60 * 60 * 1000;
  return new Date(lastActiveAt).getTime() < cutoff;
};

export class AdminService {
  async getStats() {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      totalCouples,
      totalCommunities,
      _totalMatches,
      totalPrompts,
      pendingReports,
      activeToday,
      bannedCouples,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.couple.count(),
      prisma.community.count(),
      prisma.match.count({ where: { status: 'accepted' } }),
      prisma.prompt.count({ where: { isActive: true } }),
      prisma.report.count({ where: { status: 'pending' } }),
      // Real activity now: pinged within last 24h via lastActiveAt.
      prisma.user.count({ where: { lastActiveAt: { gte: dayAgo } } }),
      prisma.couple.count({ where: { bannedAt: { not: null } } }),
    ]);

    return {
      totalUsers,
      totalCouples,
      totalCommunities,
      totalPrompts,
      activeToday,
      pendingReports,
      bannedCouples,
    };
  }

  async getUsers() {
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

    const dummyCities = ['Chennai', 'Goa', 'Mumbai', 'Delhi', 'Bangalore', 'Pune'];

    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { 
        coupleProfile: {
          include: { answers: true }
        } 
      },
    });

    return users.map((u, idx) => {
      // Status hierarchy: banned > unverified > inactive (no recent activity) > active.
      let status: 'banned' | 'inactive' | 'active' = 'active';
      if (u.coupleProfile?.bannedAt) status = 'banned';
      else if (!u.isPhoneVerified) status = 'inactive';
      else if (isInactive(u.lastActiveAt)) status = 'inactive';

      return {
        _id: u.id,
        id: u.id,
        name: u.name || 'Unknown',
        phone: u.phone,
        city: (u.coupleProfile?.locationCity && u.coupleProfile?.locationCity !== 'Unknown')
          ? u.coupleProfile.locationCity
          : dummyCities[idx % dummyCities.length],
        status,
        joinedAt: u.createdAt,
        lastActiveAt: u.lastActiveAt,
        coupleId: u.coupleId,
        bannedAt: u.coupleProfile?.bannedAt ?? null,
        banReason: u.coupleProfile?.banReason ?? null,
        relationshipStatus: u.coupleProfile?.relationshipStatus ?? null,
        profile: u.coupleProfile ? {
          bio: u.coupleProfile.bio,
          primaryPhoto: u.coupleProfile.primaryPhoto,
          relationshipStatus: u.coupleProfile.relationshipStatus,
          answers: u.coupleProfile.answers.map(a => ({
            question: questionMap[a.questionId] || a.questionId,
            options: a.selectedOptionIds.map(oid => optionLabelMap[oid] || oid)
          }))
        } : null
      };
    });
  }

  async getCouples() {
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

    const dummyCities = ['Chennai', 'Goa', 'Mumbai', 'Delhi', 'Bangalore', 'Pune'];

    const couples = await prisma.couple.findMany({
      orderBy: { createdAt: 'desc' },
      include: { 
        partner1: true,
        partner2: true,
        answers: true,
      },
      take: 100,
    });

    return couples.map((c, idx) => {
      // Couple is "inactive" only if BOTH partners are inactive.
      const bothInactive =
        isInactive(c.partner1?.lastActiveAt ?? null) &&
        isInactive(c.partner2?.lastActiveAt ?? null);

      let status: 'banned' | 'inactive' | 'engaged' | 'new' = 'new';
      if (c.bannedAt) status = 'banned';
      else if (c.isProfileComplete && bothInactive) status = 'inactive';
      else if (c.isProfileComplete) status = 'engaged';

      return {
        _id: c.coupleId,
        id: c.coupleId,
        pairName: c.profileName || 'Anonymous Pair',
        city: (c.locationCity && c.locationCity !== 'Unknown')
          ? c.locationCity
          : dummyCities[idx % dummyCities.length],
        compatibilityScore: Math.floor(Math.random() * 30) + 70,
        streakDays: 0,
        status,
        relationshipStatus: c.relationshipStatus,
        bannedAt: c.bannedAt,
        banReason: c.banReason,
        bio: c.bio,
        primaryPhoto: c.primaryPhoto,
        partners: [
          c.partner1 ? {
            id: c.partner1.id,
            name: c.partner1.name,
            phone: c.partner1.phone,
            lastActiveAt: c.partner1.lastActiveAt,
          } : null,
          c.partner2 ? {
            id: c.partner2.id,
            name: c.partner2.name,
            phone: c.partner2.phone,
            lastActiveAt: c.partner2.lastActiveAt,
          } : null,
        ].filter(Boolean),
        answers: c.answers.map(a => ({
          question: questionMap[a.questionId] || a.questionId,
          options: a.selectedOptionIds.map(oid => optionLabelMap[oid] || oid)
        }))
      };
    });
  }

  async getCityDistribution() {
    const dummyCities = ['Chennai', 'Goa', 'Mumbai', 'Delhi', 'Bangalore', 'Pune'];
    const distribution: Record<string, { city: string; users: number; couples: number }> = {};
    
    // Default dummy distribution if DB is empty
    dummyCities.forEach(city => {
      distribution[city] = { city, users: 0, couples: 0 };
    });

    const [users, couples] = await Promise.all([
      prisma.user.findMany({ include: { coupleProfile: true } }),
      prisma.couple.findMany(),
    ]);

    users.forEach((u, idx) => {
      const dbCity = u.coupleProfile?.locationCity;
      const city = (dbCity && dbCity !== 'Unknown') ? dbCity : dummyCities[idx % dummyCities.length];
      if (!distribution[city]) distribution[city] = { city, users: 0, couples: 0 };
      distribution[city].users++;
    });

    couples.forEach((c, idx) => {
      const dbCity = c.locationCity;
      const city = (dbCity && dbCity !== 'Unknown') ? dbCity : dummyCities[idx % dummyCities.length];
      if (!distribution[city]) distribution[city] = { city, users: 0, couples: 0 };
      distribution[city].couples++;
    });

    return Object.values(distribution).sort((a, b) => b.users - a.users).slice(0, 10);
  }

  async deleteCouple(coupleId: string) {
    const couple = await prisma.couple.findUnique({
      where: { coupleId },
      include: { partner1: true, partner2: true }
    });

    if (!couple) throw new Error('Couple not found');

    const userIds = [couple.partner1Id, couple.partner2Id].filter(id => !!id) as string[];

    return prisma.$transaction([
      prisma.notification.deleteMany({ where: { OR: [{ recipientId: coupleId }, { senderId: coupleId }] } }),
      prisma.match.deleteMany({ where: { OR: [{ couple1Id: coupleId }, { couple2Id: coupleId }, { actionById: coupleId }] } }),
      prisma.message.deleteMany({ where: { OR: [{ matchId: { not: null } }, { communityId: { not: null } }], senderId: coupleId } }),
      prisma.communityMember.deleteMany({ where: { coupleId } }),
      prisma.communityAdmin.deleteMany({ where: { coupleId } }),
      prisma.onboardingAnswer.deleteMany({ where: { coupleId } }),
      prisma.report.deleteMany({ where: { OR: [{ reporterId: coupleId }, { targetId: coupleId }] } }),
      prisma.couple.delete({ where: { coupleId } }),
      prisma.user.deleteMany({ where: { id: { in: userIds } } }),
    ]);
  }

  async getCommunities() {
    const comms = await prisma.community.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        members: { include: { couple: true } },
        admins: { include: { couple: true } },
        joinRequests: { include: { couple: true } },
      },
    });

    return comms.map(c => ({
      _id: c.id,
      id: c.id,
      name: c.name,
      description: c.description,
      city: c.city,
      coverImageUrl: c.coverImageUrl,
      tags: c.tags,
      category: c.tags?.[0] || c.city || 'General',
      memberCount: c.members.length,
      members: c.members.map(m => ({
        id: m.coupleId,
        name: m.couple.profileName || 'Anonymous',
        photo: m.couple.primaryPhoto
      })),
      hosts: c.admins.map(a => ({
        id: a.coupleId,
        name: a.couple.profileName || 'Anonymous',
        photo: a.couple.primaryPhoto
      })),
      pendingRequests: c.joinRequests.map(r => ({
        id: r.id,
        coupleId: r.coupleId,
        name: r.couple.profileName || 'Anonymous',
        photo: r.couple.primaryPhoto,
      })),
      hasNoHost: c.admins.length === 0,
      growthRate: 0,
    }));
  }

  async getActivities() {
    const [notifs, users, communities] = await Promise.all([
      prisma.notification.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { sender: true },
      }),
      prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
      prisma.community.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);

    const activities: any[] = [];

    notifs.forEach(n => {
      activities.push({
        _id: `notif-${n.id}`,
        id: `notif-${n.id}`,
        title: n.title,
        actor: n.sender?.profileName || 'System',
        type: n.type === 'match' ? 'couple_matched' : 'system_alert',
        happenedAt: n.createdAt,
      });
    });

    users.forEach(u => {
      activities.push({
        _id: `user-${u.id}`,
        id: `user-${u.id}`,
        title: 'New User Registered',
        actor: u.name || 'Anonymous User',
        type: 'user_registration',
        happenedAt: u.createdAt,
      });
    });

    communities.forEach(c => {
      activities.push({
        _id: `comm-${c.id}`,
        id: `comm-${c.id}`,
        title: 'New Community Created',
        actor: c.name,
        type: 'community_creation',
        happenedAt: c.createdAt,
      });
    });

    return activities
      .sort((a, b) => {
        const dateA = a.happenedAt ? new Date(a.happenedAt).getTime() : 0;
        const dateB = b.happenedAt ? new Date(b.happenedAt).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, 20);
  }

  async getPrompts() {
    const list = await prisma.prompt.findMany({ orderBy: { createdAt: 'desc' } });
    return list.map(p => ({
      _id: p.id,
      id: p.id,
      title: p.text,
      question: p.text,
      category: p.category,
      tags: [],
      active: p.isActive,
      createdAt: p.createdAt,
    }));
  }

  async getReports() {
    const list = await prisma.report.findMany({
      orderBy: { createdAt: 'desc' },
      include: { reporter: true },
    });

    const reportsWithTargets = await Promise.all(list.map(async (r: any) => {
      let targetName = 'Unknown Target';
      
      const cp = await (prisma.couple as any).findUnique({ where: { coupleId: r.targetId }, select: { profileName: true } });
      if (cp) {
        targetName = cp.profileName || 'Anonymous Couple';
      } else {
        const cm = await (prisma.community as any).findUnique({ where: { id: r.targetId }, select: { name: true } });
        if (cm) targetName = cm.name;
      }

      return {
        _id: r.id,
        id: r.id,
        reporter: r.reporter?.profileName || 'Unknown',
        target: targetName,
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt,
      };
    }));
    
    return reportsWithTargets;
  }

  async getBlocks() {
    // Find all couples that have blocked at least one entity
    const couples = await prisma.couple.findMany({
      where: { blocked: { isEmpty: false } },
      select: { coupleId: true, profileName: true, blocked: true },
      orderBy: { coupleId: 'asc' },
    });

    // For each blocked ID, resolve whether it's a couple or community
    const rows: any[] = [];
    for (const c of couples) {
      for (const blockedId of c.blocked) {
        let targetName = 'Unknown';
        let targetType: 'user' | 'community' = 'user';

        const cp = await (prisma.couple as any).findUnique({
          where: { coupleId: blockedId },
          select: { profileName: true },
        });
        if (cp) {
          targetName = cp.profileName || 'Anonymous Couple';
          targetType = 'user';
        } else {
          const cm = await (prisma.community as any).findUnique({
            where: { id: blockedId },
            select: { name: true },
          });
          if (cm) {
            targetName = cm.name;
            targetType = 'community';
          }
        }

        rows.push({
          id: `${c.coupleId}:${blockedId}`,
          blockerName: c.profileName || 'Unknown',
          blockerCoupleId: c.coupleId,
          targetName,
          targetId: blockedId,
          targetType,
        });
      }
    }
    return rows;
  }

  async getChartData() {
    // Generate last 6 months growth data
    const data = [];
    for (let i = 5; i >= 0; i--) {
      const date = new Date();
      date.setMonth(date.getMonth() - i);
      const month = date.toLocaleString('default', { month: 'short' });
      
      const startOfMonth = new Date(date.getFullYear(), date.getMonth(), 1);
      const endOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0);

      const [u, c, comm] = await Promise.all([
        prisma.user.count({ where: { createdAt: { lte: endOfMonth } } }),
        prisma.couple.count({ where: { createdAt: { lte: endOfMonth } } }),
        prisma.community.count({ where: { createdAt: { lte: endOfMonth } } }),
      ]);

      data.push({ name: month, users: u, couples: c, communities: comm });
    }
    return data;
  }

  async getUserLogs() {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return users.map(u => ({
      id: u.id,
      title: 'New Registration',
      actor: u.name || u.phone || 'New User',
      happenedAt: u.createdAt,
      type: 'user_registration'
    }));
  }

  async getCommunityLogs() {
    const comms = await prisma.community.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return comms.map(c => ({
      id: c.id,
      title: 'Community Created',
      actor: c.name,
      happenedAt: c.createdAt,
      type: 'community_creation'
    }));
  }

  /**
   * Admin community creation. Accepts an optional `hostCoupleId` — if provided,
   * that couple is wired up as both admin and member so they can approve join
   * requests from the mobile app. If omitted, the community has no host and the
   * admin can use `processJoinRequestAsAdmin` to approve requests directly.
   */
  async createCommunity(data: {
    name: string;
    description?: string;
    city: string;
    tags?: string[];
    coverImageUrl?: string;
    hostCoupleId?: string | null;
  }) {
    let hostExists = false;
    if (data.hostCoupleId) {
      const host = await prisma.couple.findUnique({
        where: { coupleId: data.hostCoupleId },
        select: { coupleId: true },
      });
      hostExists = !!host;
    }

    return prisma.community.create({
      data: {
        name: data.name,
        description: data.description,
        city: data.city,
        tags: data.tags || [],
        coverImageUrl: data.coverImageUrl,
        ...(hostExists && data.hostCoupleId
          ? {
              admins: { create: { coupleId: data.hostCoupleId } },
              members: { create: { coupleId: data.hostCoupleId } },
            }
          : {}),
      }
    });
  }

  /**
   * Process a community join request from the admin panel.
   * Bypasses the per-couple-admin check used by mobile, so admin-created
   * (host-less) communities can still have requests approved.
   */
  async processJoinRequestAsAdmin(
    communityId: string,
    requestId: string,
    decision: 'accept' | 'reject',
  ) {
    const request = await prisma.communityJoinRequest.findUnique({
      where: { id: requestId },
    });
    if (!request || request.communityId !== communityId) {
      throw new Error('Join request not found');
    }

    await prisma.communityJoinRequest.delete({ where: { id: requestId } });

    if (decision === 'accept') {
      await prisma.communityMember.upsert({
        where: { communityId_coupleId: { communityId, coupleId: request.coupleId } },
        update: {},
        create: { communityId, coupleId: request.coupleId },
      });

      const community = await prisma.community.findUnique({
        where: { id: communityId },
        select: { name: true },
      });

      const notification = await prisma.notification.create({
        data: {
          recipientId: request.coupleId,
          type: 'community',
          title: 'Request Accepted!',
          message: `You joined ${community?.name || 'the community'}!`,
          data: { communityId },
        },
      });

      emitRealtimeNotification(request.coupleId, {
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

  /**
   * Ban a couple. Both partners are immediately blocked from logging in or
   * making authenticated requests via existing tokens.
   */
  async banCouple(coupleId: string, reason?: string) {
    const couple = await prisma.couple.update({
      where: { coupleId },
      data: {
        bannedAt: new Date(),
        banReason: reason || null,
      },
    });
    invalidateBanCache(coupleId);

    // Also revoke any active refresh tokens so previously-issued sessions die.
    await prisma.user.updateMany({
      where: { coupleId },
      data: { refreshTokenHash: null },
    });

    logger.warn(`[Admin] Banned couple ${coupleId} (reason: ${reason || 'n/a'})`);
    return couple;
  }

  /**
   * Unban a previously-banned couple. They can log in again immediately.
   */
  async unbanCouple(coupleId: string) {
    const couple = await prisma.couple.update({
      where: { coupleId },
      data: { bannedAt: null, banReason: null },
    });
    invalidateBanCache(coupleId);
    logger.info(`[Admin] Unbanned couple ${coupleId}`);
    return couple;
  }

  async addPrompt(text: string, category: string) {
    return prisma.prompt.create({ data: { text, category } });
  }

  async togglePrompt(id: string) {
    const p = await prisma.prompt.findUnique({ where: { id } });
    if (!p) throw new Error('Prompt not found');
    return prisma.prompt.update({ where: { id }, data: { isActive: !p.isActive } });
  }

  async deletePrompt(id: string) {
    return prisma.prompt.delete({ where: { id } });
  }

  async sendNotification(title: string, message: string, recipientIds?: string[]) {
    let validCoupleIds: string[];

    if (recipientIds && recipientIds.length > 0) {
      // Validate — only keep IDs that actually exist in the couples table
      const existing = await prisma.couple.findMany({
        where: { coupleId: { in: recipientIds } },
        select: { coupleId: true },
      });
      validCoupleIds = existing.map(c => c.coupleId);
    } else {
      // Broadcast: fetch all valid coupleIds (exclude nulls just in case)
      const allCouples = await prisma.couple.findMany({
        where: { coupleId: { not: '' } },
        select: { coupleId: true },
      });
      validCoupleIds = allCouples.map(c => c.coupleId).filter(Boolean);
    }

    if (validCoupleIds.length === 0) {
      return { count: 0 };
    }

    const data = validCoupleIds.map(rid => ({
      recipientId: rid,
      type: 'admin' as any,
      title,
      message,
    }));

    const result = await prisma.notification.createMany({ data, skipDuplicates: true });

    // Real-time fan-out: in-app socket + OS push (FCM) per recipient.
    for (const coupleId of validCoupleIds) {
      emitRealtimeNotification(coupleId, {
        type: 'admin',
        title,
        message,
      });
    }

    return result;
  }
}
