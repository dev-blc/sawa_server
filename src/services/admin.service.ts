import { prisma } from '../lib/prisma';
import { invalidateBanCache } from '../middleware/authenticate';
import { emitRealtimeNotification } from '../utils/realtime';
import { i18nData } from '../i18n/notif';
import { logger } from '../utils/logger';
import { materializeImageLoose } from '../lib/storage';

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

/**
 * Build an admin media URL that lazily serves an image (couple photo / community
 * cover) instead of embedding multi-MB base64 blobs in the /admin/data payload.
 * The dashboard renders these directly as <img src>, so the browser fetches &
 * caches each image on demand. The token is carried in the query string because
 * <img> cannot send an Authorization header.
 */
function adminMediaUrl(kind: 'couple' | 'community', id: string, token?: string): string {
  const base = (process.env.APP_URL || '').replace(/\/$/, '');
  const t = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${base}/api/v1/admin/media/${kind}/${encodeURIComponent(id)}${t}`;
}

/**
 * Returns a lightweight image reference: if the stored value is an inline base64
 * data URL, swap it for a lazy media URL; if it's already an http(s) URL, keep it.
 */
function imageRef(
  kind: 'couple' | 'community',
  id: string | null | undefined,
  value: string | null | undefined,
  token?: string,
): string | null {
  if (!value) return null;
  if (id && value.startsWith('data:')) return adminMediaUrl(kind, id, token);
  return value;
}

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

  async getUsers(token?: string) {
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
      include: { 
        coupleProfile: {
          include: { answers: true }
        } 
      },
    });

    const mapped = users.map((u, idx) => {
      // Status hierarchy: banned > unverified > inactive (no recent activity) > active.
      let status: 'banned' | 'inactive' | 'active' = 'active';
      if (u.coupleProfile?.bannedAt) status = 'banned';
      else if (!u.isPhoneVerified) status = 'inactive';
      else if (isInactive(u.lastActiveAt)) status = 'inactive';

      // Users who never finished onboarding have no `name`; the only identifying
      // data captured at signup is their phone number, so fall back to that
      // instead of a meaningless "Unknown".
      const realName = (u.name ?? '').trim();

      return {
        _hasName: realName !== '',
        _id: u.id,
        id: u.id,
        name: realName || u.phone || 'Unknown',
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
          primaryPhoto: imageRef('couple', u.coupleId, u.coupleProfile.primaryPhoto, token),
          relationshipStatus: u.coupleProfile.relationshipStatus,
          answers: u.coupleProfile.answers.map(a => ({
            question: questionMap[a.questionId] || a.questionId,
            options: a.selectedOptionIds.map(oid => optionLabelMap[oid] || oid)
          }))
        } : null
      };
    });

    // Named users first (recency preserved within each group via stable sort),
    // phone-only users at the bottom. Strip the helper flag.
    mapped.sort((a, b) => Number(b._hasName) - Number(a._hasName));
    return mapped.map(({ _hasName, ...rest }) => rest);
  }

  async getCouples(token?: string) {
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
        // The actual partners are the Users linked by coupleId. partner1Id /
        // partner2Id are legacy pointers that are frequently unset, so relying on
        // them alone made most couples show no partners (and fall back to the
        // "Sawa Couple" placeholder name).
        users: true,
        answers: true,
      },
    });

    const mapped = couples.map((c, idx) => {
      // Prefer the real membership (users linked by coupleId); fall back to the
      // legacy partner1/partner2 pointers only if the membership list is empty.
      const memberUsers = (c.users && c.users.length > 0
        ? c.users
        : [c.partner1, c.partner2].filter(Boolean) as typeof c.users);

      // Couple is "inactive" only if it has members and ALL of them are inactive.
      const bothInactive =
        memberUsers.length > 0 &&
        memberUsers.every(u => isInactive(u?.lastActiveAt ?? null));

      let status: 'banned' | 'inactive' | 'engaged' | 'new' = 'new';
      if (c.bannedAt) status = 'banned';
      else if (c.isProfileComplete && bothInactive) status = 'inactive';
      else if (c.isProfileComplete) status = 'engaged';

      // The couple's display name. `profileName` starts life as the generic
      // "Sawa Couple" placeholder (set at registration) and is only replaced
      // once a couple customizes it, so on its own it makes every un-customized
      // couple read as "Sawa Couple" in the dashboard. Prefer the real partner
      // names ("Alice & Bob"), then a genuinely customized profileName, and only
      // fall back to a generic label when we have nothing else.
      const partnerNames = memberUsers
        .map(u => (u?.name ?? '').trim())
        .filter(Boolean);
      const customProfileName =
        c.profileName && c.profileName.trim() && c.profileName.trim() !== 'Sawa Couple'
          ? c.profileName.trim()
          : '';
      // Couples that signed up but never finished onboarding have no `User.name`,
      // no partner1/2 pointers and the default "Sawa Couple" profileName — the
      // only identifying data they carry is the phone number captured at signup.
      // Use that as a last-resort label so the dashboard stays useful instead of
      // collapsing every incomplete couple into "Anonymous Pair".
      const partnerPhones = memberUsers
        .map(u => (u?.phone ?? '').trim())
        .filter(Boolean);
      const pairName =
        partnerNames.length >= 2
          ? partnerNames.slice(0, 2).join(' & ')
          : customProfileName ||
            partnerNames[0] ||
            (partnerPhones.length >= 2
              ? partnerPhones.slice(0, 2).join(' & ')
              : partnerPhones[0]) ||
            'Anonymous Pair';

      // Couples that have entered a real name (either partner names or a
      // customized profileName) are surfaced at the top of the dashboard;
      // nameless signups (phone-only) sink to the bottom.
      const hasName = partnerNames.length > 0 || customProfileName !== '';

      return {
        _hasName: hasName,
        _id: c.coupleId,
        id: c.coupleId,
        pairName,
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
        primaryPhoto: imageRef('couple', c.coupleId, c.primaryPhoto, token),
        partners: memberUsers.map(u => ({
          id: u.id,
          name: u.name,
          phone: u.phone,
          lastActiveAt: u.lastActiveAt,
        })),
        answers: c.answers.map(a => ({
          question: questionMap[a.questionId] || a.questionId,
          options: a.selectedOptionIds.map(oid => optionLabelMap[oid] || oid)
        }))
      };
    });

    // Named couples first (kept in recency order within each group via the
    // stable sort), phone-only couples at the bottom. Strip the helper flag.
    mapped.sort((a, b) => Number(b._hasName) - Number(a._hasName));
    return mapped.map(({ _hasName, ...rest }) => rest);
  }

  /** Fetch the raw stored image (base64 data URL or http URL) for lazy serving. */
  async getRawImage(kind: 'couple' | 'community', id: string): Promise<string | null> {
    if (kind === 'couple') {
      const c = await prisma.couple.findUnique({
        where: { coupleId: id },
        select: { primaryPhoto: true },
      });
      return c?.primaryPhoto ?? null;
    }
    const cm = await prisma.community.findUnique({
      where: { id },
      select: { coverImageUrl: true },
    });
    return cm?.coverImageUrl ?? null;
  }

  async getCityDistribution() {
    const dummyCities = ['Chennai', 'Goa', 'Mumbai', 'Delhi', 'Bangalore', 'Pune'];
    const distribution: Record<string, { city: string; users: number; couples: number }> = {};
    
    // Default dummy distribution if DB is empty
    dummyCities.forEach(city => {
      distribution[city] = { city, users: 0, couples: 0 };
    });

    // Only the city strings — the old include/no-select loaded every full
    // user + couple row (photos, bios, hashes) into memory per dashboard hit.
    const [users, couples] = await Promise.all([
      prisma.user.findMany({
        select: { coupleProfile: { select: { locationCity: true } } },
      }),
      prisma.couple.findMany({ select: { locationCity: true } }),
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
      include: { partner1: true, partner2: true },
    });

    if (!couple) throw new Error('Couple not found');

    const userIds = [couple.partner1Id, couple.partner2Id].filter(Boolean) as string[];

    // Sequential transaction so we can respect FK constraints and break circular deps
    await prisma.$transaction(async (tx) => {
      // 1. Delete ALL messages sent by this couple (any chat type)
      await tx.message.deleteMany({ where: { senderId: coupleId } });

      // 2. Delete messages inside any match this couple was part of
      //    (sent by the other couple in those conversations)
      const coupleMatches = await tx.match.findMany({
        where: { OR: [{ couple1Id: coupleId }, { couple2Id: coupleId }] },
        select: { id: true },
      });
      const matchIds = coupleMatches.map((m) => m.id);
      if (matchIds.length > 0) {
        await tx.message.deleteMany({ where: { matchId: { in: matchIds } } });
      }

      // 3. Delete matches
      await tx.match.deleteMany({
        where: { OR: [{ couple1Id: coupleId }, { couple2Id: coupleId }, { actionById: coupleId }] },
      });

      // 4. Delete notifications
      await tx.notification.deleteMany({
        where: { OR: [{ recipientId: coupleId }, { senderId: coupleId }] },
      });

      // 5. Delete community relations
      await tx.communityMember.deleteMany({ where: { coupleId } });
      await tx.communityAdmin.deleteMany({ where: { coupleId } });
      await tx.communityJoinRequest.deleteMany({ where: { coupleId } });

      // 6. Delete onboarding answers
      await tx.onboardingAnswer.deleteMany({ where: { coupleId } });

      // 7. Delete reports filed by or against this couple
      await tx.report.deleteMany({
        where: { OR: [{ reporterId: coupleId }, { targetId: coupleId }] },
      });

      // 8. Delete OTP tokens tied to this couple
      await tx.otpToken.deleteMany({ where: { coupleId } });

      // 9. Break circular FK: clear partner refs on couple & coupleId on users
      await tx.couple.update({
        where: { coupleId },
        data: { partner1Id: null, partner2Id: null },
      });
      if (userIds.length > 0) {
        await tx.user.updateMany({
          where: { id: { in: userIds } },
          data: { coupleId: null },
        });
      }

      // 10. Delete the couple record
      await tx.couple.delete({ where: { coupleId } });

      // 11. Delete user records
      if (userIds.length > 0) {
        await tx.user.deleteMany({ where: { id: { in: userIds } } });
      }
    });
  }

  async getCommunities(token?: string) {
    // Bounded + narrow: the old unbounded triple-include loaded every full
    // couple row (hashes, bios, photos) for every member of every community
    // on each dashboard hit — the worst single query in the admin panel.
    const comms = await prisma.community.findMany({
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: {
        members: {
          select: { coupleId: true, couple: { select: { profileName: true, primaryPhoto: true } } },
        },
        admins: {
          select: { coupleId: true, couple: { select: { profileName: true, primaryPhoto: true } } },
        },
        joinRequests: {
          select: { id: true, coupleId: true, couple: { select: { profileName: true, primaryPhoto: true } } },
        },
      },
    });

    return comms.map(c => ({
      _id: c.id,
      id: c.id,
      name: c.name,
      description: c.description,
      city: c.city,
      coverImageUrl: imageRef('community', c.id, c.coverImageUrl, token),
      tags: c.tags,
      category: c.tags?.[0] || c.city || 'General',
      memberCount: c.members.length,
      members: c.members.map(m => ({
        id: m.coupleId,
        name: m.couple.profileName || 'Anonymous',
        photo: imageRef('couple', m.coupleId, m.couple.primaryPhoto, token)
      })),
      hosts: c.admins.map(a => ({
        id: a.coupleId,
        name: a.couple.profileName || 'Anonymous',
        photo: imageRef('couple', a.coupleId, a.couple.primaryPhoto, token)
      })),
      pendingRequests: c.joinRequests.map(r => ({
        id: r.id,
        coupleId: r.coupleId,
        name: r.couple.profileName || 'Anonymous',
        photo: imageRef('couple', r.coupleId, r.couple.primaryPhoto, token),
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
    const list = await prisma.prompt.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      take: 500,
    });
    return list.map(p => ({
      _id: p.id,
      id: p.id,
      title: p.text,
      question: p.text,
      category: p.category,
      sortOrder: p.sortOrder,
      tags: [],
      active: p.isActive,
      createdAt: p.createdAt,
    }));
  }

  async getReports() {
    const list = await prisma.report.findMany({
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: { reporter: { select: { profileName: true } } },
    });

    // Resolve every target in TWO batched queries instead of 1-2 per report
    // (the old N+1 issued up to a thousand lookups per dashboard load).
    const targetIds = [...new Set(list.map((r: any) => r.targetId).filter(Boolean))];
    const [targetCouples, targetCommunities] = await Promise.all([
      prisma.couple.findMany({
        where: { coupleId: { in: targetIds } },
        select: { coupleId: true, profileName: true },
      }),
      prisma.community.findMany({
        where: { id: { in: targetIds } },
        select: { id: true, name: true },
      }),
    ]);
    const coupleNames = new Map(targetCouples.map((c) => [c.coupleId, c.profileName || 'Anonymous Couple']));
    const communityNames = new Map(targetCommunities.map((c) => [c.id, c.name]));

    return list.map((r: any) => ({
      _id: r.id,
      id: r.id,
      reporter: r.reporter?.profileName || 'Unknown',
      target: coupleNames.get(r.targetId) || communityNames.get(r.targetId) || 'Unknown Target',
      reason: r.reason,
      status: r.status,
      createdAt: r.createdAt,
    }));
  }

  async getBlocks() {
    // Find all couples that have blocked at least one entity
    const couples = await prisma.couple.findMany({
      where: { blocked: { isEmpty: false } },
      select: { coupleId: true, profileName: true, blocked: true },
      orderBy: { coupleId: 'asc' },
    });

    // Resolve every blocked id in TWO batched queries (the old nested loop
    // issued 1-2 serial queries per block row). blocked[] may hold coupleId
    // (UUID) OR the internal id, so couples are matched on both.
    const blockedIds = [...new Set(couples.flatMap((c) => c.blocked))];
    const [blockedCouples, blockedCommunities] = await Promise.all([
      prisma.couple.findMany({
        where: { OR: [{ coupleId: { in: blockedIds } }, { id: { in: blockedIds } }] },
        select: { id: true, coupleId: true, profileName: true },
      }),
      prisma.community.findMany({
        where: { id: { in: blockedIds } },
        select: { id: true, name: true },
      }),
    ]);
    const coupleByAnyId = new Map<string, string>();
    blockedCouples.forEach((c) => {
      const name = c.profileName || 'Anonymous Couple';
      coupleByAnyId.set(c.coupleId, name);
      coupleByAnyId.set(c.id, name);
    });
    const communityById = new Map(blockedCommunities.map((c) => [c.id, c.name]));

    return couples.flatMap((c) =>
      c.blocked.map((blockedId) => {
        const coupleName = coupleByAnyId.get(blockedId);
        const communityName = coupleName ? undefined : communityById.get(blockedId);
        return {
          id: `${c.coupleId}:${blockedId}`,
          blockerName: c.profileName || 'Unknown',
          blockerCoupleId: c.coupleId,
          targetName: coupleName || communityName || 'Unknown',
          targetId: blockedId,
          targetType: (communityName ? 'community' : 'user') as 'user' | 'community',
        };
      }),
    );
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
        coverImageUrl: (await materializeImageLoose(
          data.coverImageUrl ?? (data as any).coverImageBase64,
          data.hostCoupleId ?? undefined,
        )) ?? undefined,
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
          data: { communityId, ...i18nData('community.requestAccepted') },
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
    // Place new prompts at the end of their category's list
    const last = await prisma.prompt.findFirst({
      where: { category },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    const nextOrder = (last?.sortOrder ?? -1) + 1;
    return prisma.prompt.create({ data: { text, category, sortOrder: nextOrder } });
  }

  async togglePrompt(id: string) {
    const p = await prisma.prompt.findUnique({ where: { id } });
    if (!p) throw new Error('Prompt not found');
    return prisma.prompt.update({ where: { id }, data: { isActive: !p.isActive } });
  }

  async editPrompt(id: string, text: string) {
    const p = await prisma.prompt.findUnique({ where: { id } });
    if (!p) throw new Error('Prompt not found');
    return prisma.prompt.update({ where: { id }, data: { text } });
  }

  async reorderPrompts(ids: string[]) {
    // ids is the desired order; update sortOrder for each
    await prisma.$transaction(
      ids.map((id, index) =>
        prisma.prompt.update({ where: { id }, data: { sortOrder: index } })
      )
    );
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
