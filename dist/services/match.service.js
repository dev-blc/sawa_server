"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchService = exports.MatchService = void 0;
const prisma_1 = require("../lib/prisma");
const AppError_1 = require("../utils/AppError");
const logger_1 = require("../utils/logger");
const realtime_1 = require("../utils/realtime");
const notif_1 = require("../i18n/notif");
const notification_service_1 = require("./notification.service");
const geo_1 = require("../utils/geo");
const COUPLE_GEO_SELECT = {
    locationCity: true,
    locationLatitude: true,
    locationLongitude: true,
};
class MatchService {
    /**
     * Fetches the discovery feed of couples
     */
    async getDiscoveryFeed(requestingCoupleId, cityFilter, coupleMongoId) {
        const meSelect = {
            id: true, coupleId: true, partner1Id: true, partner2Id: true,
            blocked: true, locationCity: true, locationLatitude: true, locationLongitude: true,
        };
        let me;
        if (coupleMongoId) {
            me = await prisma_1.prisma.couple.findUnique({ where: { id: coupleMongoId }, select: meSelect });
        }
        else {
            me = await prisma_1.prisma.couple.findUnique({ where: { coupleId: requestingCoupleId }, select: meSelect });
        }
        if (!me)
            throw new AppError_1.AppError('Couple profile not found', 404);
        const blockedIds = me.blocked || [];
        const SUPPORTED_CITIES = ['Bangalore', 'Chennai', 'New Delhi', 'Delhi', 'Mumbai', 'Gurgaon', 'Noida', 'Hyderabad', 'Goa'];
        // ── Build the "self" exclusion set ───────────────────────────────────────
        // We must exclude ALL couple records that belong to the same users, not just
        // me.coupleId. Legacy bugs (randomUUID fallback) could have created duplicate
        // couple rows for the same partner pair. Any of those rows could be
        // isProfileComplete=true and appear in the feed otherwise.
        const selfCoupleIds = new Set([me.coupleId, requestingCoupleId].filter(Boolean));
        // Find every couple that shares either partner with me.
        const partnerConditions = [];
        if (me.partner1Id)
            partnerConditions.push({ partner1Id: me.partner1Id }, { partner2Id: me.partner1Id });
        if (me.partner2Id)
            partnerConditions.push({ partner1Id: me.partner2Id }, { partner2Id: me.partner2Id });
        if (partnerConditions.length > 0) {
            const siblingCouples = await prisma_1.prisma.couple.findMany({
                where: { OR: partnerConditions },
                select: { coupleId: true },
            });
            siblingCouples.forEach((c) => selfCoupleIds.add(c.coupleId));
        }
        const selfIds = Array.from(selfCoupleIds).filter(Boolean);
        // Get interacted IDs in BOTH directions so already-connected couples don't re-appear.
        // Check ALL self coupleIds so even duplicate rows don't re-surface.
        const interactions = await prisma_1.prisma.match.findMany({
            where: { OR: [{ couple1Id: { in: selfIds } }, { couple2Id: { in: selfIds } }] },
            select: { couple1Id: true, couple2Id: true }
        });
        const interactedIds = Array.from(new Set(interactions.flatMap((m) => [m.couple1Id, m.couple2Id]).filter((id) => !selfCoupleIds.has(id))));
        const where = {
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
        const Q3_TITLES = {
            'q3-dinners-home': 'Dinners at home',
            'q3-dinner': 'Dinner at home',
            'q3-restaurants': 'Exploring restaurants',
            'q3-outdoor': 'Outdoor activities',
            'q3-cultural': 'Cultural events',
            'q3-drinks': 'Casual drinks',
            'q3-trips': 'Weekend trips',
        };
        const potentialCouples = await prisma_1.prisma.couple.findMany({
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
        return potentialCouples.map((c) => {
            const q3Answer = c.answers?.[0];
            const tags = q3Answer
                ? q3Answer.selectedOptionIds
                    // Resolve ID → title; if value is already a title (no key match) keep it as-is
                    .map((id) => Q3_TITLES[id] || id)
                    .filter((v) => Boolean(v) && v.trim().length > 0)
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
                distance: (0, geo_1.distanceLabelBetween)(me, c),
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
    async sayHello(requestingCoupleId, targetCoupleIdStr, coupleMongoId) {
        const sayHelloSelect = {
            id: true, coupleId: true, profileName: true, primaryPhoto: true,
            locationCity: true, bio: true, activities: true, socialVibes: true, matchCriteria: true,
        };
        let me;
        if (coupleMongoId) {
            me = await prisma_1.prisma.couple.findUnique({ where: { id: coupleMongoId }, select: sayHelloSelect });
        }
        else {
            me = await prisma_1.prisma.couple.findUnique({ where: { coupleId: requestingCoupleId }, select: sayHelloSelect });
        }
        if (!me)
            throw new AppError_1.AppError('Profile not found', 404);
        let targetCouple = await prisma_1.prisma.couple.findFirst({
            where: { OR: [{ id: targetCoupleIdStr }, { coupleId: targetCoupleIdStr }] },
            select: {
                id: true, coupleId: true, profileName: true, primaryPhoto: true,
                locationCity: true, bio: true, activities: true, socialVibes: true, matchCriteria: true,
            },
        });
        if (!targetCouple) {
            logger_1.logger.info(`[MatchService] Say Hello for unknown couple ${targetCoupleIdStr} - success (no DB)`);
            return { isMatch: false };
        }
        // Fetch ALL rows between these two couples and pick in priority order:
        // accepted > incoming-pending > my-pending > skipped
        const allExisting = await prisma_1.prisma.match.findMany({
            where: {
                OR: [
                    { couple1Id: me.coupleId, couple2Id: targetCouple.coupleId },
                    { couple1Id: targetCouple.coupleId, couple2Id: me.coupleId }
                ]
            },
            orderBy: { createdAt: 'asc' }
        });
        const accepted = allExisting.find(m => m.status === 'accepted');
        const incomingPending = allExisting.find(m => m.status === 'pending' && m.actionById !== me.coupleId);
        const myPending = allExisting.find(m => m.status === 'pending' && m.actionById === me.coupleId);
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
                const updatedMatch = await prisma_1.prisma.match.update({
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
                        await (0, notification_service_1.upsertMatchPendingNotification)({
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
                    }
                    catch (err) {
                        logger_1.logger.error('[MatchService] Failed to notify skipped couple of new hello:', err);
                    }
                })();
                return { isMatch: false };
            }
            // I already sent a pending hello; nothing to do — return reason so UI can show feedback
            if (existingMatch.actionById === me.coupleId) {
                return { isMatch: false, reason: 'outgoing_pending' };
            }
            if (existingMatch.status === 'pending' && existingMatch.actionById !== me.coupleId) {
                // Mutual like
                await prisma_1.prisma.match.update({
                    where: { id: existingMatch.id },
                    data: { status: 'accepted', actionById: me.coupleId }
                });
                // Delete the original "New Connection Request" pending notifications for this match
                // so they no longer show "Say Hello Back" after accepting.
                // The new "You've Connected!" notifications created below replace them.
                await (0, notification_service_1.upsertMatchConnectedNotification)({
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
                await (0, notification_service_1.upsertMatchConnectedNotification)({
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
                const io = global.io;
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
        const newMatch = await prisma_1.prisma.match.create({
            data: {
                couple1Id: me.coupleId,
                couple2Id: targetCouple.coupleId,
                status: 'pending',
                actionById: me.coupleId,
            }
        });
        (async () => {
            try {
                await (0, notification_service_1.upsertMatchPendingNotification)({
                    recipientId: targetCouple.coupleId,
                    senderId: me.coupleId,
                    matchId: newMatch.id,
                    profileName: me.profileName || 'Couple',
                    primaryPhoto: me.primaryPhoto,
                    location: me.locationCity,
                    bio: me.bio,
                    tags: me.activities,
                    vibes: me.socialVibes,
                    matchCriteria: me.matchCriteria,
                });
            }
            catch (err) {
                logger_1.logger.error(`[MatchService] Background notification failed:`, err);
            }
        })();
        return { isMatch: false };
    }
    async skipCouple(requestingCoupleId, targetCoupleIdStr) {
        const me = await prisma_1.prisma.couple.findUnique({
            where: { coupleId: requestingCoupleId },
            select: { id: true, coupleId: true }
        });
        if (!me) {
            logger_1.logger.error(`[MatchService.skipCouple] Requesting couple not found: ${requestingCoupleId}`);
            throw new AppError_1.AppError('Profile not found', 404);
        }
        const target = await prisma_1.prisma.couple.findFirst({
            where: { OR: [{ id: targetCoupleIdStr }, { coupleId: targetCoupleIdStr }] },
            select: { id: true, coupleId: true }
        });
        if (!target) {
            logger_1.logger.warn(`[MatchService.skipCouple] Target couple not found: ${targetCoupleIdStr}`);
            return { skipped: true };
        }
        // Only create a skip record if there is no existing interaction (accepted stays accepted)
        const existing = await prisma_1.prisma.match.findFirst({
            where: {
                OR: [
                    { couple1Id: me.coupleId, couple2Id: target.coupleId },
                    { couple1Id: target.coupleId, couple2Id: me.coupleId },
                ],
            },
        });
        if (!existing) {
            await prisma_1.prisma.match.create({
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
    async getIncomingRequests(requestingCoupleId, coupleMongoId) {
        let meId;
        let meGeo;
        if (coupleMongoId) {
            const meProfile = await prisma_1.prisma.couple.findUnique({
                where: { id: coupleMongoId },
                select: { coupleId: true, ...COUPLE_GEO_SELECT },
            });
            if (!meProfile)
                throw new AppError_1.AppError('Profile not found', 404);
            meId = meProfile.coupleId;
            meGeo = meProfile;
        }
        else {
            const me = await prisma_1.prisma.couple.findUnique({
                where: { coupleId: requestingCoupleId },
                select: { id: true, coupleId: true, ...COUPLE_GEO_SELECT },
            });
            if (!me)
                throw new AppError_1.AppError('Profile not found', 404);
            meId = me.coupleId;
            meGeo = me;
        }
        const COUPLE_CARD_SELECT = {
            id: true, coupleId: true, profileName: true, primaryPhoto: true, locationCity: true,
            locationLatitude: true, locationLongitude: true,
        };
        // Incoming requests: pending matches where the OTHER person initiated (actionById ≠ meId)
        const pending = await prisma_1.prisma.match.findMany({
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
        return pending.map((m) => {
            const otherCouple = m.couple1Id === meId ? m.couple2 : m.couple1;
            if (!otherCouple)
                return null;
            return {
                _id: m.id,
                id: m.id,
                coupleId: otherCouple.coupleId,
                profileName: otherCouple.profileName || 'Someone',
                primaryPhoto: otherCouple.primaryPhoto,
                location: otherCouple.locationCity || 'Unknown',
                distance: (0, geo_1.distanceLabelBetween)(meGeo, otherCouple),
                status: 'pending',
                createdAt: m.createdAt
            };
        }).filter(Boolean);
    }
    async getMatches(requestingCoupleId, coupleMongoId) {
        let meId;
        let meGeo;
        if (coupleMongoId) {
            const meProfile = await prisma_1.prisma.couple.findUnique({
                where: { id: coupleMongoId },
                select: { coupleId: true, ...COUPLE_GEO_SELECT },
            });
            if (!meProfile)
                throw new AppError_1.AppError('Profile not found', 404);
            meId = meProfile.coupleId;
            meGeo = meProfile;
        }
        else {
            const me = await prisma_1.prisma.couple.findUnique({
                where: { coupleId: requestingCoupleId },
                select: { id: true, coupleId: true, ...COUPLE_GEO_SELECT },
            });
            if (!me)
                throw new AppError_1.AppError('Profile not found', 404);
            meId = me.coupleId;
            meGeo = me;
        }
        const matches = await prisma_1.prisma.match.findMany({
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
        return matches.map((m) => {
            const otherCouple = m.couple1Id === meId ? m.couple2 : m.couple1;
            if (!otherCouple)
                return null;
            return {
                _id: m.id,
                id: m.id,
                coupleId: otherCouple.coupleId,
                profileName: otherCouple.profileName || 'Unknown Couple',
                primaryPhoto: otherCouple.primaryPhoto,
                location: otherCouple.locationCity || 'Unknown',
                distance: (0, geo_1.distanceLabelBetween)(meGeo, otherCouple),
                status: m.status,
                createdAt: m.createdAt
            };
        }).filter(Boolean);
    }
    /** Accept an incoming pending match by id (used by notifications + accept endpoint). */
    async acceptPendingMatchRecord(match, me) {
        const initiatorCoupleId = match.actionById;
        const otherCoupleId = match.couple1Id === me.coupleId ? match.couple2Id : match.couple1Id;
        // Batch: update the match row + fetch both couple profiles in parallel.
        const [, targetCouple, meFull] = await Promise.all([
            prisma_1.prisma.match.update({
                where: { id: match.id },
                data: { status: 'accepted', actionById: me.coupleId },
            }),
            prisma_1.prisma.couple.findUnique({ where: { coupleId: initiatorCoupleId } }),
            prisma_1.prisma.couple.findUnique({ where: { coupleId: me.coupleId } }),
        ]);
        if (targetCouple && meFull) {
            // Fire both connected notifications in parallel.
            await Promise.all([
                (0, notification_service_1.upsertMatchConnectedNotification)({
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
                }),
                (0, notification_service_1.upsertMatchConnectedNotification)({
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
                }),
            ]);
            const io = global.io;
            if (io) {
                io.to(`couple:${me.coupleId}`).emit('match:accepted', { matchId: match.id });
                io.to(`couple:${targetCouple.coupleId}`).emit('match:accepted', { matchId: match.id });
            }
        }
        return { isMatch: true, matchId: match.id, otherCoupleId };
    }
    async acceptMatch(requestingCoupleId, targetCoupleIdStr, coupleMongoId, matchId) {
        const me = coupleMongoId
            ? await prisma_1.prisma.couple.findUnique({ where: { id: coupleMongoId }, select: { coupleId: true } })
            : await prisma_1.prisma.couple.findUnique({ where: { coupleId: requestingCoupleId }, select: { coupleId: true } });
        if (!me)
            throw new AppError_1.AppError('Profile not found', 404);
        // Resolve the target couple once — used in fallback logic below.
        const targetCouple = await prisma_1.prisma.couple.findFirst({
            where: { OR: [{ id: targetCoupleIdStr }, { coupleId: targetCoupleIdStr }] },
            select: { coupleId: true },
        });
        // Helper: find any live incoming pending from targetCouple → me
        const findLiveIncomingPending = async () => {
            if (!targetCouple)
                return null;
            return prisma_1.prisma.match.findFirst({
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
            const match = await prisma_1.prisma.match.findUnique({ where: { id: matchId } });
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
            const iAmInvolved = match.couple1Id === me.coupleId || match.couple2Id === me.coupleId;
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
    async rejectMatch(requestingCoupleId, targetCoupleIdStr) {
        const me = await prisma_1.prisma.couple.findUnique({ where: { coupleId: requestingCoupleId }, select: { id: true, coupleId: true } });
        if (!me)
            throw new AppError_1.AppError('Profile not found', 404);
        const target = await prisma_1.prisma.couple.findFirst({
            where: { OR: [{ id: targetCoupleIdStr }, { coupleId: targetCoupleIdStr }] },
            select: { id: true, coupleId: true }
        });
        if (!target)
            throw new AppError_1.AppError('Target profile not found', 404);
        await prisma_1.prisma.match.deleteMany({
            where: {
                OR: [{ couple1Id: me.coupleId, couple2Id: target.coupleId }, { couple1Id: target.coupleId, couple2Id: me.coupleId }],
                status: 'pending'
            }
        });
        const notification = await prisma_1.prisma.notification.create({
            data: {
                recipientId: target.coupleId,
                senderId: me.coupleId,
                type: 'system',
                title: "Connection Update",
                message: "A couple decided not to connect at this time.",
                data: { ...(0, notif_1.i18nData)('match.rejected') },
            }
        });
        (0, realtime_1.emitRealtimeNotification)(target.coupleId, {
            notificationId: notification.id,
            type: notification.type,
            title: notification.title,
            message: notification.message,
            data: notification.data,
        });
        return { success: true };
    }
    async refreshDiscovery(requestingCoupleId) {
        const me = await prisma_1.prisma.couple.findUnique({ where: { coupleId: requestingCoupleId }, select: { id: true, coupleId: true } });
        if (!me)
            throw new AppError_1.AppError('Profile not found', 404);
        // Only delete SKIPPED records so un-met couples re-appear in the feed.
        // NEVER delete pending matches (outgoing OR incoming) — doing so would silently
        // destroy connection requests that the other person may be about to accept.
        await prisma_1.prisma.match.deleteMany({
            where: {
                OR: [{ couple1Id: me.coupleId }, { couple2Id: me.coupleId }],
                status: 'skipped',
            }
        });
        return { success: true };
    }
    async blockCouple(requestingCoupleId, targetCoupleIdStr) {
        const me = await prisma_1.prisma.couple.findUnique({ where: { coupleId: requestingCoupleId }, select: { coupleId: true } });
        if (!me)
            throw new AppError_1.AppError('Profile not found', 404);
        const target = await prisma_1.prisma.couple.findFirst({
            where: { OR: [{ id: targetCoupleIdStr }, { coupleId: targetCoupleIdStr }] },
            select: { coupleId: true }
        });
        if (!target)
            throw new AppError_1.AppError('Target profile not found', 404);
        // 1. Add to blocked list + create report record (so admin can see the block)
        await Promise.all([
            prisma_1.prisma.couple.update({
                where: { coupleId: me.coupleId },
                data: { blocked: { push: target.coupleId } }
            }),
            prisma_1.prisma.report.create({
                data: {
                    reporterId: me.coupleId,
                    targetId: target.coupleId,
                    reason: 'Blocked user',
                    details: 'User blocked from app',
                    status: 'pending',
                }
            }),
        ]);
        // 2. Destroy matches permanently
        await prisma_1.prisma.match.deleteMany({
            where: {
                OR: [{ couple1Id: me.coupleId, couple2Id: target.coupleId }, { couple2Id: me.coupleId, couple1Id: target.coupleId }]
            }
        });
        // 3. Emit event to trigger UI refresh for blocker
        const io = global.io;
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
    async unfriendCouple(requestingCoupleId, targetCoupleIdStr) {
        const me = await prisma_1.prisma.couple.findUnique({ where: { coupleId: requestingCoupleId }, select: { coupleId: true } });
        if (!me)
            throw new AppError_1.AppError('Profile not found', 404);
        const target = await prisma_1.prisma.couple.findFirst({
            where: { OR: [{ id: targetCoupleIdStr }, { coupleId: targetCoupleIdStr }] },
            select: { coupleId: true }
        });
        if (!target)
            throw new AppError_1.AppError('Target profile not found', 404);
        // Delete the match record so the connection is fully reset
        await prisma_1.prisma.match.deleteMany({
            where: {
                OR: [
                    { couple1Id: me.coupleId, couple2Id: target.coupleId },
                    { couple2Id: me.coupleId, couple1Id: target.coupleId },
                ]
            }
        });
        // Notify both sides so UI updates immediately
        const io = global.io;
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
exports.MatchService = MatchService;
exports.matchService = new MatchService();
//# sourceMappingURL=match.service.js.map