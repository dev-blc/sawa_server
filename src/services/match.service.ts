import { prisma } from '../lib/prisma';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import { emitRealtimeNotification } from '../utils/realtime';
import { i18nData } from '../i18n/notif';
import {
  upsertMatchConnectedNotification,
  upsertMatchPendingNotification,
} from './notification.service';
import { distanceLabelBetween } from '../utils/geo';
import { evaluateMatch, Q3_TITLES } from './matchScore';

const COUPLE_GEO_SELECT = {
  locationCity: true,
  locationLatitude: true,
  locationLongitude: true,
} as const;

/** Onboarding answers slice needed by the match scorer (see matchScore.ts). */
const SCORING_ANSWERS_SELECT = {
  answers: { select: { questionId: true, selectedOptionIds: true } },
} as const;

/** How many couples one discovery response returns (unchanged contract). */
const DISCOVERY_PAGE_SIZE = 10;
/**
 * How many candidates are fetched and scored before the page is cut. The feed
 * is ranked by real match score, so we score a bounded pool and return the
 * best DISCOVERY_PAGE_SIZE — a bare `take: 10` would rank an arbitrary ten.
 */
const DISCOVERY_POOL_SIZE = 50;

/**
 * Canonical orientation for NEW Match rows: lexicographically lower coupleId
 * first. `@@unique([couple1Id, couple2Id])` is order-sensitive, so two
 * simultaneous opposite-direction hellos used to slip past it as (A,B)+(B,A)
 * duplicates. Writing new rows in one canonical orientation turns that race
 * into a P2002 the caller resolves. Reads stay bidirectional everywhere
 * (legacy rows exist in both orientations — no migration, no backfill), and
 * existing rows are never re-oriented (an update into the canonical slot
 * could collide with a legacy duplicate). Row orientation carries no meaning:
 * every consumer resolves direction via `actionById`.
 */
const canonicalMatchPair = (
  coupleIdA: string,
  coupleIdB: string,
): { couple1Id: string; couple2Id: string } =>
  coupleIdA <= coupleIdB
    ? { couple1Id: coupleIdA, couple2Id: coupleIdB }
    : { couple1Id: coupleIdB, couple2Id: coupleIdA };

/** Shape a stored notification row into the realtime emit payload. */
const toRealtimePayload = (n: {
  id: string;
  type: string;
  title: string;
  message: string;
  data: unknown;
}) => ({
  notificationId: n.id,
  type: n.type,
  title: n.title,
  message: n.message,
  data: n.data,
});

export class MatchService {
  /**
   * Fetches the discovery feed of couples
   */
  async getDiscoveryFeed(requestingCoupleId: string, cityFilter?: string, coupleMongoId?: string) {
    const meSelect = {
      id: true, coupleId: true, partner1Id: true, partner2Id: true,
      blocked: true, locationCity: true, locationLatitude: true, locationLongitude: true,
      // Scoring inputs (never returned to the client — see matchScore.ts):
      activities: true, socialVibes: true, matchCriteria: true,
      ...SCORING_ANSWERS_SELECT,
    } as const;
    let me;
    if (coupleMongoId) {
      me = await prisma.couple.findUnique({ where: { id: coupleMongoId }, select: meSelect });
    } else {
      me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId }, select: meSelect });
    }
    
    if (!me) throw new AppError('Couple profile not found', 404);

    const blockedIds = me.blocked || [];
    const SUPPORTED_CITIES = ['Bangalore', 'Chennai', 'New Delhi', 'Delhi', 'Mumbai', 'Gurgaon', 'Noida', 'Hyderabad', 'Goa'];

    // ── Build the "self" exclusion set ───────────────────────────────────────
    // We must exclude ALL couple records that belong to the same users, not just
    // me.coupleId. Legacy bugs (randomUUID fallback) could have created duplicate
    // couple rows for the same partner pair. Any of those rows could be
    // isProfileComplete=true and appear in the feed otherwise.
    const selfCoupleIds = new Set<string>([me.coupleId, requestingCoupleId].filter(Boolean));

    // Find every couple that shares either partner with me.
    const partnerConditions: any[] = [];
    if (me.partner1Id) partnerConditions.push({ partner1Id: me.partner1Id }, { partner2Id: me.partner1Id });
    if (me.partner2Id) partnerConditions.push({ partner1Id: me.partner2Id }, { partner2Id: me.partner2Id });

    if (partnerConditions.length > 0) {
      const siblingCouples = await prisma.couple.findMany({
        where: { OR: partnerConditions },
        select: { coupleId: true },
      });
      siblingCouples.forEach((c: any) => selfCoupleIds.add(c.coupleId));
    }
    const selfIds = Array.from(selfCoupleIds).filter(Boolean);

    // Get interacted IDs in BOTH directions so already-connected couples don't re-appear.
    // Check ALL self coupleIds so even duplicate rows don't re-surface.
    const interactions = await prisma.match.findMany({
      where: { OR: [{ couple1Id: { in: selfIds } }, { couple2Id: { in: selfIds } }] },
      select: { couple1Id: true, couple2Id: true }
    });
    const interactedIds = Array.from(new Set(
      interactions.flatMap((m: any) => [m.couple1Id, m.couple2Id]).filter((id: string) => !selfCoupleIds.has(id))
    ));

    const where: any = {
      coupleId: { notIn: [...selfIds, ...interactedIds, ...blockedIds] },
      isProfileComplete: true,
      isOpenToMeeting: true,
    };

    if (cityFilter && cityFilter !== 'All City' && cityFilter !== 'All Cities' && cityFilter !== 'Unknown') {
       const isSupported = SUPPORTED_CITIES.some(c => cityFilter.toLowerCase().includes(c.toLowerCase()));
       if (isSupported) {
          where.locationCity = { contains: cityFilter, mode: 'insensitive' };
       }
    }

    // Fetch a bounded candidate pool (same filters/exclusions as always), score
    // every candidate against the requesting couple, and return the best page.
    const potentialCouples = await prisma.couple.findMany({
      where,
      take: DISCOVERY_POOL_SIZE,
      select: {
        id: true,
        coupleId: true,
        profileName: true,
        primaryPhoto: true,
        ...COUPLE_GEO_SELECT,
        bio: true,
        matchCriteria: true,
        relationshipStatus: true,
        // Scoring inputs (never returned to the client):
        activities: true,
        socialVibes: true,
        ...SCORING_ANSWERS_SELECT,
      },
    });

    return potentialCouples.map((c: any) => {
      const q3Answer = c.answers?.find((a: any) => a.questionId === 'q3');
      const tags: string[] = q3Answer
        ? (q3Answer.selectedOptionIds as string[])
            // Resolve ID → title; if value is already a title (no key match) keep it as-is
            .map((id: string) => Q3_TITLES[id] || id)
            .filter((v: string) => Boolean(v) && v.trim().length > 0)
        : [];

      // Deterministic score + insights from real overlaps (matchScore.ts).
      // insights is [] when nothing genuine is shared — never invented copy.
      const { matchScore, insights } = evaluateMatch(me, c);

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
        matchScore,
        insights,
      };
    })
      // Best matches first; coupleId tiebreak keeps the order stable.
      .sort((a, b) => b.matchScore - a.matchScore || a.coupleId.localeCompare(b.coupleId))
      .slice(0, DISCOVERY_PAGE_SIZE);
  }

  /**
   * Say hello (like) to a couple
   */
  async sayHello(requestingCoupleId: string, targetCoupleIdStr: string, coupleMongoId?: string) {
    const sayHelloSelect = {
      id: true, coupleId: true, profileName: true, primaryPhoto: true,
      locationCity: true, bio: true, activities: true, socialVibes: true, matchCriteria: true,
      ...SCORING_ANSWERS_SELECT,
    } as const;
    let me;
    if (coupleMongoId) {
      me = await prisma.couple.findUnique({ where: { id: coupleMongoId }, select: sayHelloSelect });
    } else {
      me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId }, select: sayHelloSelect });
    }

    if (!me) throw new AppError('Profile not found', 404);

    let targetCouple = await prisma.couple.findFirst({
      where: { OR: [{ id: targetCoupleIdStr }, { coupleId: targetCoupleIdStr }] },
      select: sayHelloSelect,
    });

    if (!targetCouple) {
       logger.info(`[MatchService] Say Hello for unknown couple ${targetCoupleIdStr} - success (no DB)`);
       return { isMatch: false };
    }

    // Deterministic compatibility for this pair — persisted on the Match row.
    const { matchScore, insights } = evaluateMatch(me, targetCouple);

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
        // Reset skipped to pending. The row's orientation is left untouched:
        // getIncomingRequests resolves direction via actionById (not column
        // order), and re-orienting could collide with a legacy duplicate row
        // in the opposite orientation under @@unique([couple1Id, couple2Id]).
        const updatedMatch = await prisma.match.update({
          where: { id: existingMatch.id },
          data: {
            status: 'pending',
            actionById: me.coupleId,
            matchScore,
            insights,
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

      // I already sent a pending hello; nothing to do — return reason so UI can show feedback
      if (existingMatch.actionById === me.coupleId) {
        return { isMatch: false, reason: 'outgoing_pending' };
      }

      if (existingMatch.status === 'pending' && existingMatch.actionById !== me.coupleId) {
          // Mutual like. Accept + both "You've Connected!" notification rows
          // commit atomically: a crash mid-way could otherwise leave the
          // couples connected with the stale "Say Hello Back" notifications
          // still standing (or notified without the accept persisted).
          // The pending→connected notification swap lives inside
          // upsertMatchConnectedNotification and rolls back with the rest.
          const [myNotif, theirNotif] = await prisma.$transaction(async (tx) => {
            await tx.match.update({
              where: { id: existingMatch.id },
              data: { status: 'accepted', actionById: me.coupleId }
            });

            const mine = await upsertMatchConnectedNotification({
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
              emitRealtime: false, // emitted after commit below
            }, tx);
            const theirs = await upsertMatchConnectedNotification({
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
              emitRealtime: false, // emitted after commit below
            }, tx);
            return [mine, theirs];
          });

          // Sockets/push fire only after the transaction committed — a
          // notification for a rolled-back accept must never reach a phone.
          emitRealtimeNotification(me.coupleId, toRealtimePayload(myNotif));
          emitRealtimeNotification(targetCouple.coupleId, toRealtimePayload(theirNotif));

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

    let newMatch;
    try {
      newMatch = await prisma.match.create({
        data: {
          // Canonical orientation (lower coupleId first) so two simultaneous
          // opposite-direction hellos collide on @@unique([couple1Id, couple2Id])
          // instead of creating a duplicate (A,B)+(B,A) pair. Direction is
          // carried by actionById, never by column order.
          ...canonicalMatchPair(me.coupleId, targetCouple.coupleId),
          status: 'pending',
          actionById: me.coupleId,
          matchScore,
          insights,
        }
      });
    } catch (err: any) {
      // Concurrent duplicate hello: the @@unique([couple1Id, couple2Id])
      // constraint fired because another request won the check-then-create
      // race. The row exists — resolve it instead of surfacing a 500.
      if (err?.code === 'P2002') {
        // Re-query BOTH orientations: the winner may be a canonical row from
        // this code or a legacy row written the other way around.
        const existing = await prisma.match.findFirst({
          where: {
            OR: [
              { couple1Id: me.coupleId, couple2Id: targetCouple.coupleId },
              { couple1Id: targetCouple.coupleId, couple2Id: me.coupleId },
            ],
          },
          orderBy: { createdAt: 'asc' },
        });
        if (existing) {
          if (existing.status === 'accepted') {
            return { isMatch: true, matchId: existing.id };
          }
          if (existing.status === 'pending' && existing.actionById !== me.coupleId) {
            // Both couples said hello at the same moment and the other side's
            // create won. Their row is an incoming pending for us — this is a
            // mutual like, so accept it exactly like the non-race path would.
            return this.acceptPendingMatchRecord(existing, me);
          }
          return { isMatch: false };
        }
      }
      throw err;
    }

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
      try {
        await prisma.match.create({
          data: {
            // Canonical orientation — see canonicalMatchPair. Keeps two
            // simultaneous mutual skips from creating an (A,B)+(B,A) pair.
            ...canonicalMatchPair(me.coupleId, target.coupleId),
            status: 'skipped',
            actionById: me.coupleId
          }
        });
      } catch (err: any) {
        // Concurrent interaction won the check-then-create race — the pair row
        // already exists, which is exactly the end state a skip wants.
        if (err?.code !== 'P2002') throw err;
      }
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

    const COUPLE_CARD_SELECT = {
      id: true, coupleId: true, profileName: true, primaryPhoto: true, locationCity: true,
      locationLatitude: true, locationLongitude: true,
    } as const;
    // Incoming requests: pending matches where the OTHER person initiated (actionById ≠ meId)
    const pending = await prisma.match.findMany({ 
      where: {
        status: 'pending',
        actionById: { not: meId },
        OR: [{ couple1Id: meId }, { couple2Id: meId }],
      },
      select: {
        id: true, couple1Id: true, couple2Id: true, createdAt: true,
        couple1: { select: COUPLE_CARD_SELECT },
        couple2: { select: COUPLE_CARD_SELECT },
      },
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

    // Profile reads carry no write risk — fetch both in parallel up front.
    const [targetCouple, meFull] = await Promise.all([
      prisma.couple.findUnique({ where: { coupleId: initiatorCoupleId } }),
      prisma.couple.findUnique({ where: { coupleId: me.coupleId } }),
    ]);

    // Accept + both "You've Connected!" rows commit atomically (same rationale
    // as the sayHello mutual-like path: no connected-but-unnotified half state).
    // When a profile is missing the accept still persists, matching the old
    // behavior — only the notifications are skipped.
    const notifRows = await prisma.$transaction(async (tx) => {
      await tx.match.update({
        where: { id: match.id },
        data: { status: 'accepted', actionById: me.coupleId },
      });

      if (!targetCouple || !meFull) return null;

      const mine = await upsertMatchConnectedNotification({
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
        emitRealtime: false, // emitted after commit below
      }, tx);
      const theirs = await upsertMatchConnectedNotification({
        recipientId: targetCouple.coupleId,
        senderId: me.coupleId,
        matchId: match.id,
        coupleId: me.coupleId,
        profileName: meFull.profileName || 'Couple',
        primaryPhoto: meFull.primaryPhoto,
        location: meFull.locationCity,
        bio: meFull.bio,
        tags: meFull.activities,
        vibes: meFull.socialVibes,
        matchCriteria: meFull.matchCriteria,
        emitRealtime: false, // emitted after commit below
      }, tx);
      return { mine, theirs };
    });

    if (notifRows && targetCouple) {
      // Post-commit only: sockets/push must never announce a rolled-back accept.
      emitRealtimeNotification(me.coupleId, toRealtimePayload(notifRows.mine));
      emitRealtimeNotification(targetCouple.coupleId, toRealtimePayload(notifRows.theirs));

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

    // Resolve the target couple once — used in fallback logic below.
    const targetCouple = await prisma.couple.findFirst({
      where: { OR: [{ id: targetCoupleIdStr }, { coupleId: targetCoupleIdStr }] },
      select: { coupleId: true },
    });

    // Helper: find any live incoming pending from targetCouple → me
    const findLiveIncomingPending = async () => {
      if (!targetCouple) return null;
      return prisma.match.findFirst({
        where: {
          status: 'pending',
          actionById: { not: me.coupleId },
          OR: [
            { couple1Id: me.coupleId, couple2Id: targetCouple.coupleId },
            { couple1Id: targetCouple.coupleId, couple2Id: me.coupleId },
          ],
        },
      });
    };

    // Prefer exact matchId from notification — avoids picking the wrong pending row.
    if (matchId) {
      const match = await prisma.match.findUnique({ where: { id: matchId } });

      if (!match) {
        // matchId is stale (e.g. was deleted by an old refreshDiscovery bug on the sender's side).
        // Before falling back to sayHello(), check if there's still a live incoming pending
        // from that couple — if so, accept it directly so the user doesn't accidentally
        // create a new outgoing hello instead.
        const livePending = await findLiveIncomingPending();
        if (livePending) {
          return this.acceptPendingMatchRecord(livePending, me);
        }
        return this.sayHello(requestingCoupleId, targetCoupleIdStr, coupleMongoId);
      }

      const iAmInvolved =
        match.couple1Id === me.coupleId || match.couple2Id === me.coupleId;
      if (!iAmInvolved) {
        // matchId belongs to a different couple pair — same stale-id fallback
        const livePending = await findLiveIncomingPending();
        if (livePending) {
          return this.acceptPendingMatchRecord(livePending, me);
        }
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

    // No matchId provided — use sayHello which handles incoming pending gracefully
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
          data: { ...i18nData('match.rejected') },
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

    // Only delete SKIPPED records so un-met couples re-appear in the feed.
    // NEVER delete pending matches (outgoing OR incoming) — doing so would silently
    // destroy connection requests that the other person may be about to accept.
    //
    // Skips from TODAY are retained: they still count toward the per-day
    // connection quota, so refreshing can't be used to reset today's usage.
    // Couples skipped on earlier days still re-surface as intended.
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    await prisma.match.deleteMany({
      where: {
        OR: [{ couple1Id: me.coupleId }, { couple2Id: me.coupleId }],
        status: 'skipped',
        createdAt: { lt: startOfDay },
      }
    });

    return { success: true };
  }

  async blockCouple(requestingCoupleId: string, targetCoupleIdStr: string) {
    const me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId }, select: { coupleId: true, blocked: true } });
    if (!me) throw new AppError('Profile not found', 404);

    const target = await prisma.couple.findFirst({
      where: { OR: [{ id: targetCoupleIdStr }, { coupleId: targetCoupleIdStr }] },
      select: { coupleId: true }
    });
    if (!target) throw new AppError('Target profile not found', 404);

    // 1. Add to blocked list + create report record (so admin can see the block).
    // Guard against repeat calls: without this, blocking the same couple twice
    // would push a duplicate into `blocked[]` (unbounded growth) and spawn a new
    // "Blocked user" report row each time.
    const alreadyBlocked = Array.isArray(me.blocked) && me.blocked.includes(target.coupleId);
    if (!alreadyBlocked) {
      await Promise.all([
        prisma.couple.update({
          where: { coupleId: me.coupleId },
          data: { blocked: { push: target.coupleId } }
        }),
        prisma.report.create({
          data: {
            reporterId: me.coupleId,
            targetId: target.coupleId,
            reason: 'Blocked user',
            details: 'User blocked from app',
            status: 'pending',
          }
        }),
      ]);
    }

    // 2. Destroy matches permanently — and their messages, in one transaction,
    // so no message is left orphaned with matchId set-null (which corrupts
    // unread-count queries and is never cleaned up otherwise).
    const blockWhere = {
      OR: [
        { couple1Id: me.coupleId, couple2Id: target.coupleId },
        { couple2Id: me.coupleId, couple1Id: target.coupleId },
      ],
    };
    const blockedMatches = await prisma.match.findMany({ where: blockWhere, select: { id: true } });
    const blockedMatchIds = blockedMatches.map((m) => m.id);
    await prisma.$transaction([
      prisma.message.deleteMany({ where: { matchId: { in: blockedMatchIds } } }),
      prisma.match.deleteMany({ where: blockWhere }),
    ]);

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

  /**
   * Unfriend a couple — removes the accepted match so both sides can reconnect
   * via say-hello again. Does NOT block or add to blocked list.
   */
  async unfriendCouple(requestingCoupleId: string, targetCoupleIdStr: string) {
    const me = await prisma.couple.findUnique({ where: { coupleId: requestingCoupleId }, select: { coupleId: true } });
    if (!me) throw new AppError('Profile not found', 404);

    const target = await prisma.couple.findFirst({
      where: { OR: [{ id: targetCoupleIdStr }, { coupleId: targetCoupleIdStr }] },
      select: { coupleId: true }
    });
    if (!target) throw new AppError('Target profile not found', 404);

    // Delete the match record (and its messages) so the connection is fully
    // reset with no orphaned messages left behind (matchId set-null).
    const unfriendWhere = {
      OR: [
        { couple1Id: me.coupleId, couple2Id: target.coupleId },
        { couple2Id: me.coupleId, couple1Id: target.coupleId },
      ],
    };
    const unfriendMatches = await prisma.match.findMany({ where: unfriendWhere, select: { id: true } });
    const unfriendMatchIds = unfriendMatches.map((m) => m.id);
    await prisma.$transaction([
      prisma.message.deleteMany({ where: { matchId: { in: unfriendMatchIds } } }),
      prisma.match.deleteMany({ where: unfriendWhere }),
    ]);

    // Notify both sides so UI updates immediately
    const io = (global as any).io;
    if (io) {
      io.to(`couple:${me.coupleId}`).emit('match:accepted', {
        targetCoupleId: target.coupleId,
        action: 'unfriended',
      });
      io.to(`couple:${target.coupleId}`).emit('match:accepted', {
        targetCoupleId: me.coupleId,
        action: 'unfriended',
      });
    }

    return { success: true };
  }
}

export const matchService = new MatchService();
