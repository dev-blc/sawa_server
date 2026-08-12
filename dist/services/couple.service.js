"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.coupleService = exports.CoupleService = void 0;
const prisma_1 = require("../lib/prisma");
const AppError_1 = require("../utils/AppError");
const logger_1 = require("../utils/logger");
const realtime_1 = require("../utils/realtime");
const notif_1 = require("../i18n/notif");
const storage_1 = require("../lib/storage");
class CoupleService {
    /**
     * Upsert the couple document and update both users' details
     */
    async setupProfile(primaryUserId, coupleId, data) {
        // 0. Preliminary validation: Ensure both emails are not the same
        if (data.yourEmail && data.partnerEmail && data.yourEmail.toLowerCase() === data.partnerEmail.toLowerCase()) {
            logger_1.logger.warn(`[CoupleService.setupProfile] Partners attempted to use same email: ${data.yourEmail}`);
        }
        let partner = null;
        // 1. Update primary user's details (Non-blocking on email conflict)
        try {
            await prisma_1.prisma.user.update({
                where: { id: primaryUserId },
                data: {
                    name: data.yourName,
                    dob: data.yourDob || undefined,
                    email: data.yourEmail || undefined,
                    role: 'primary'
                }
            });
        }
        catch (err) {
            if (err.code === 'P2002' && err.meta?.target?.includes('email')) {
                logger_1.logger.warn(`[CoupleService.setupProfile] Primary email already exists, skipping email update.`);
                // Update just the name/dob
                await prisma_1.prisma.user.update({
                    where: { id: primaryUserId },
                    data: { name: data.yourName, dob: data.yourDob || undefined, role: 'primary' }
                });
            }
            else {
                throw err;
            }
        }
        // 2. Find and update the partner user (Non-blocking on email conflict)
        partner = await prisma_1.prisma.user.findFirst({
            where: { coupleId, role: 'partner' }
        });
        if (partner) {
            try {
                await prisma_1.prisma.user.update({
                    where: { id: partner.id },
                    data: {
                        name: data.partnerName,
                        dob: data.partnerDob || undefined,
                        email: data.partnerEmail || undefined,
                    }
                });
            }
            catch (err) {
                if (err.code === 'P2002' && err.meta?.target?.includes('email')) {
                    logger_1.logger.warn(`[CoupleService.setupProfile] Partner email already exists, skipping email update.`);
                    await prisma_1.prisma.user.update({
                        where: { id: partner.id },
                        data: { name: data.partnerName, dob: data.partnerDob || undefined }
                    });
                }
                else {
                    throw err;
                }
            }
        }
        else if (data.partnerName) {
            try {
                partner = await prisma_1.prisma.user.create({
                    data: {
                        name: data.partnerName,
                        dob: data.partnerDob || undefined,
                        email: data.partnerEmail || undefined,
                        role: 'partner',
                        coupleId: coupleId
                    }
                });
            }
            catch (err) {
                if (err.code === 'P2002' && err.meta?.target?.includes('email')) {
                    logger_1.logger.warn(`[CoupleService.setupProfile] Partner email already exists during create, skipping email.`);
                    partner = await prisma_1.prisma.user.create({
                        data: {
                            name: data.partnerName,
                            dob: data.partnerDob || undefined,
                            role: 'partner',
                            coupleId: coupleId
                        }
                    });
                }
                else {
                    throw err;
                }
            }
        }
        // 3. Ensure role-based assignment for partner1/partner2 IDs
        // We should always keep the 'primary' user as partner1 and 'partner' user as partner2
        const users = await prisma_1.prisma.user.findMany({ where: { coupleId } });
        const primaryUser = users.find(u => u.role === 'primary');
        const partnerUser = users.find(u => u.role === 'partner');
        const partner1Id = primaryUser?.id || primaryUserId;
        const partner2Id = partnerUser?.id || partner?.id || null;
        // 4. Upsert the Couple document
        const existingCouple = await prisma_1.prisma.couple.findUnique({ where: { coupleId } });
        if (!existingCouple) {
            await prisma_1.prisma.couple.create({
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
        }
        else {
            await prisma_1.prisma.couple.update({
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
    }
    /**
     * Upload photos
     */
    async uploadPhotos(coupleId, data) {
        const updateData = {};
        if (data.primaryPhotoBase64 && data.primaryPhotoBase64.length > 10) {
            const dataUri = data.primaryPhotoBase64.startsWith('data:')
                ? data.primaryPhotoBase64
                : 'data:image/jpeg;base64,' + data.primaryPhotoBase64;
            // Store an S3 URL (falls back to base64 if storage is unavailable).
            updateData.primaryPhoto = await (0, storage_1.materializeImage)(dataUri, coupleId);
        }
        const existingToKeep = data.keepSecondaryPhotoUrls || [];
        const newPhotos = await (0, storage_1.materializeImages)((data.secondaryPhotosBase64 || [])
            .filter(b64 => b64 && b64.length > 10)
            .map(b64 => (b64.startsWith('data:') ? b64 : 'data:image/jpeg;base64,' + b64)), coupleId);
        if (data.keepSecondaryPhotoUrls !== undefined || data.secondaryPhotosBase64 !== undefined) {
            updateData.secondaryPhotos = [...existingToKeep, ...newPhotos].slice(0, 3);
        }
        await prisma_1.prisma.couple.update({
            where: { coupleId },
            data: updateData
        });
    }
    /**
     * Submit questionnaire answers and mark onboarding COMPLETE
     */
    async submitAnswers(coupleId, answers) {
        // Prisma treats arrays of JSON objects as Json[] in PostgreSQL if defined so, 
        // but in schema.prisma I defined them as specific models if they were important.
        // However, I used Json for answers if I remember correctly.
        // Let's check schema.prisma
        const wasIncomplete = await prisma_1.prisma.couple.findUnique({
            where: { coupleId },
            select: { isProfileComplete: true, locationCity: true, profileName: true },
        });
        await prisma_1.prisma.couple.update({
            where: { coupleId },
            data: {
                answers: {
                    deleteMany: {},
                    create: answers.map((a) => ({
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
            this.notifyNearbyCouples(coupleId, wasIncomplete.locationCity, wasIncomplete.profileName || 'A new couple').catch((err) => {
                logger_1.logger.warn(`[CoupleService] notifyNearbyCouples failed: ${err.message}`);
            });
        }
        // ─── AI BIO GENERATION (BACKGROUND) ─────────────────────────────────────
        (async () => {
            try {
                const questionMap = {
                    q1: 'Life Stage', q2: 'Couple Personality', q3: 'Favorite Activities',
                    q4: 'Meeting Frequency', q5: 'What makes a good match', q6: 'Things to avoid',
                };
                const optionLabelMap = {
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
                const qaData = answers.map((a) => ({
                    question: questionMap[a.questionId] || 'About us',
                    answers: a.selectedOptionIds.map((id) => optionLabelMap[id] || id),
                }));
                const { generateCoupleBio } = require('../utils/ai');
                const aiResponse = await generateCoupleBio(qaData);
                if (aiResponse) {
                    const updateObj = {};
                    if (aiResponse.bio)
                        updateObj.bio = aiResponse.bio;
                    if (aiResponse.matchCriteria && aiResponse.matchCriteria.length > 0) {
                        // Store the whole paragraph as the first element of the array for simplicity,
                        // or join it if we want it to remain an array of short strings.
                        // Since the AI now returns a single paragraph, we store it as is.
                        updateObj.matchCriteria = aiResponse.matchCriteria;
                    }
                    await prisma_1.prisma.couple.update({ where: { coupleId }, data: updateObj });
                }
            }
            catch (aiErr) {
                logger_1.logger.error(`[CoupleService] AI background generation failed:`, aiErr);
            }
        })();
    }
    async updateProfile(coupleId, data, requestingUserId) {
        const coupleDoc = await prisma_1.prisma.couple.findUnique({ where: { coupleId } });
        if (!coupleDoc)
            throw new AppError_1.AppError('Couple not found', 404);
        const updateData = {};
        if (data.bio !== undefined)
            updateData.bio = data.bio;
        if (data.relationshipStatus !== undefined)
            updateData.relationshipStatus = data.relationshipStatus;
        if (data.isOpenToMeeting !== undefined)
            updateData.isOpenToMeeting = data.isOpenToMeeting;
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
        if (data.primaryPhotoBase64 && data.primaryPhotoBase64.length > 10) {
            const dataUri = data.primaryPhotoBase64.startsWith('data:')
                ? data.primaryPhotoBase64
                : 'data:image/jpeg;base64,' + data.primaryPhotoBase64;
            updateData.primaryPhoto = await (0, storage_1.materializeImage)(dataUri, coupleId);
        }
        if (data.secondaryPhotosBase64 !== undefined || data.keepSecondaryPhotoUrls !== undefined) {
            const existingToKeep = data.keepSecondaryPhotoUrls || [];
            const newPhotos = await (0, storage_1.materializeImages)((data.secondaryPhotosBase64 || [])
                .filter(b64 => b64 && b64.length > 10)
                .map(b64 => b64.startsWith('data:') ? b64 : 'data:image/jpeg;base64,' + b64), coupleId);
            updateData.secondaryPhotos = [...existingToKeep, ...newPhotos].slice(0, 3);
        }
        // 2. Map preferences if provided
        if (Array.isArray(data.activities)) {
            updateData.activities = data.activities;
        }
        if (data.preferences) {
            if (data.preferences.meetingFrequency)
                updateData.meetingFrequency = data.preferences.meetingFrequency;
            if (data.preferences.socialVibes)
                updateData.socialVibes = data.preferences.socialVibes;
            if (data.preferences.activities)
                updateData.activities = data.preferences.activities;
            if (data.preferences.avoidances)
                updateData.avoidances = data.preferences.avoidances;
            if (data.preferences.matchCriteria) {
                updateData.matchCriteria = Array.isArray(data.preferences.matchCriteria)
                    ? data.preferences.matchCriteria
                    : [data.preferences.matchCriteria];
            }
        }
        // Explicit check for matchCriteria at top level (if app sends it that way)
        if (data.matchCriteria) {
            updateData.matchCriteria = Array.isArray(data.matchCriteria)
                ? data.matchCriteria
                : [data.matchCriteria];
        }
        const isPartner1Me = requestingUserId && coupleDoc.partner1Id === requestingUserId;
        const myId = isPartner1Me ? coupleDoc.partner1Id : coupleDoc.partner2Id;
        const partnerId = isPartner1Me ? coupleDoc.partner2Id : coupleDoc.partner1Id;
        // 3. Dynamic Profile Name update
        if (data.yourName || data.partnerName) {
            const u1 = await prisma_1.prisma.user.findUnique({ where: { id: coupleDoc.partner1Id || '' } });
            const u2 = await prisma_1.prisma.user.findUnique({ where: { id: coupleDoc.partner2Id || '' } });
            let p1Name = isPartner1Me ? (data.yourName || u1?.name) : (data.partnerName || u1?.name);
            let p2Name = isPartner1Me ? (data.partnerName || u2?.name) : (data.yourName || u2?.name);
            updateData.profileName = `${p1Name || 'User 1'} & ${p2Name || 'User 2'}`;
        }
        await prisma_1.prisma.couple.update({ where: { coupleId }, data: updateData });
        // 4. Update individual Users
        if (myId && (data.yourName || data.yourDob || data.yourEmail)) {
            try {
                await prisma_1.prisma.user.update({
                    where: { id: myId },
                    data: {
                        name: data.yourName || undefined,
                        dob: data.yourDob || undefined,
                        email: data.yourEmail || undefined,
                    }
                });
            }
            catch (err) {
                if (err.code === 'P2002' && err.meta?.target?.includes('email')) {
                    logger_1.logger.warn(`[CoupleService.updateProfile] Email conflict for myId ${myId}, skipping email update.`);
                    await prisma_1.prisma.user.update({
                        where: { id: myId },
                        data: { name: data.yourName || undefined, dob: data.yourDob || undefined }
                    });
                }
            }
        }
        if (partnerId && (data.partnerName || data.partnerDob || data.partnerEmail)) {
            try {
                await prisma_1.prisma.user.update({
                    where: { id: partnerId },
                    data: {
                        name: data.partnerName || undefined,
                        dob: data.partnerDob || undefined,
                        email: data.partnerEmail || undefined,
                    }
                });
            }
            catch (err) {
                if (err.code === 'P2002' && err.meta?.target?.includes('email')) {
                    logger_1.logger.warn(`[CoupleService.updateProfile] Email conflict for partnerId ${partnerId}, skipping email update.`);
                    await prisma_1.prisma.user.update({
                        where: { id: partnerId },
                        data: { name: data.partnerName || undefined, dob: data.partnerDob || undefined }
                    });
                }
            }
        }
        const updated = await prisma_1.prisma.couple.findUnique({ where: { coupleId }, include: { partner1: true, partner2: true } });
        return this._formatCouple(updated);
    }
    // Fields on the User model that must NEVER be serialized to a client.
    // (Password hash, refresh-token hash and the raw push token are secrets.)
    _sanitizePartner(partner) {
        if (!partner)
            return partner;
        const { password, refreshTokenHash, pushToken, ...safe } = partner;
        safe._id = partner.id;
        return safe;
    }
    _formatCouple(couple) {
        if (!couple)
            return null;
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
        if (formatted.partner1)
            formatted.partner1 = this._sanitizePartner(formatted.partner1);
        if (formatted.partner2)
            formatted.partner2 = this._sanitizePartner(formatted.partner2);
        return formatted;
    }
    async getCouple(coupleId) {
        const couple = await prisma_1.prisma.couple.findUnique({
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
        if (!couple)
            return null;
        const communities = couple.communityMembers.map((m) => ({
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
    async getCoupleSummary(coupleId) {
        const couple = await prisma_1.prisma.couple.findUnique({
            where: { coupleId },
            include: {
                // Public profile card — never expose partner email addresses here.
                partner1: { select: { id: true, name: true, dob: true } },
                partner2: { select: { id: true, name: true, dob: true } },
            }
        });
        if (!couple)
            return null;
        // Strip couple-level fields that must never leak to another couple viewing a
        // public profile card:
        //  • blocked / bannedAt / banReason — moderation internals.
        //  • locationLatitude / locationLongitude — EXACT home coordinates. Discovery
        //    only ever exposes a coarse `distance` label; leaking raw lat/lng here is
        //    a stalking/safety risk, so it must never appear on a profile card.
        const publicCouple = { ...couple };
        delete publicCouple.blocked;
        delete publicCouple.bannedAt;
        delete publicCouple.banReason;
        delete publicCouple.locationLatitude;
        delete publicCouple.locationLongitude;
        return this._formatCouple({ ...publicCouple, communities: [] });
    }
    async subscribe(coupleId) {
        return prisma_1.prisma.couple.update({
            where: { coupleId },
            data: { isSubscribed: true }
        });
    }
    async blockCouple(meId, targetId) {
        // meId and targetId may be Mongo id or coupleId UUID — resolve both
        const me = await prisma_1.prisma.couple.findUnique({ where: { id: meId }, select: { id: true, coupleId: true, blocked: true } });
        if (!me)
            return null;
        // Find target by either Mongo id or coupleId
        const target = await prisma_1.prisma.couple.findFirst({
            where: { OR: [{ id: targetId }, { coupleId: targetId }] },
            select: { id: true, coupleId: true },
        });
        const resolvedTargetId = target?.coupleId || targetId;
        const blocked = me.blocked || [];
        if (!blocked.includes(resolvedTargetId)) {
            await Promise.all([
                prisma_1.prisma.couple.update({
                    where: { id: meId },
                    data: { blocked: { set: [...blocked, resolvedTargetId] } },
                }),
                // Always create a report so the admin can see blocks from all sources
                me.coupleId
                    ? prisma_1.prisma.report.create({
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
    async unblockCouple(meId, targetId) {
        const me = await prisma_1.prisma.couple.findUnique({ where: { id: meId } });
        if (!me)
            return null;
        // Resolve all IDs for the target so we can remove whichever format is stored
        const target = await prisma_1.prisma.couple.findFirst({
            where: { OR: [{ id: targetId }, { coupleId: targetId }] },
            select: { id: true, coupleId: true },
        });
        const idsToRemove = new Set([targetId, target?.id, target?.coupleId].filter(Boolean));
        const blocked = (me.blocked || []).filter((id) => !idsToRemove.has(id));
        return prisma_1.prisma.couple.update({
            where: { id: meId },
            data: { blocked: { set: blocked } },
        });
    }
    async getBlockedCouples(meId) {
        const me = await prisma_1.prisma.couple.findUnique({ where: { id: meId } });
        if (!me?.blocked.length)
            return [];
        // blocked[] may contain either Mongo id OR coupleId (UUID) depending on which
        // block path was used — match both so all blocks are always shown
        return prisma_1.prisma.couple.findMany({
            where: {
                OR: [
                    { id: { in: me.blocked } },
                    { coupleId: { in: me.blocked } },
                ],
            },
            select: { id: true, profileName: true, primaryPhoto: true, locationCity: true, coupleId: true }
        });
    }
    async getBlockedCommunities(meId) {
        const me = await prisma_1.prisma.couple.findUnique({ where: { id: meId } });
        if (!me?.blocked.length)
            return [];
        // Resolve which blocked IDs belong to communities
        const communities = await prisma_1.prisma.community.findMany({
            where: { id: { in: me.blocked } },
            select: { id: true, name: true, coverImageUrl: true },
        });
        return communities.map((c) => ({ id: c.id, name: c.name, image: c.coverImageUrl }));
    }
    async unblockCommunity(meId, communityId) {
        const me = await prisma_1.prisma.couple.findUnique({ where: { id: meId } });
        const blocked = (me?.blocked || []).filter((id) => id !== communityId);
        return prisma_1.prisma.couple.update({
            where: { id: meId },
            data: { blocked: { set: blocked } },
        });
    }
    /**
     * Fan out a "new couple in your area" notification to all profile-complete,
     * non-banned couples in the same city. This delivers as both an in-app
     * notification (Socket.IO + Notification row) and an OS push (FCM).
     *
     * "Nearby" is currently city-level since we don't store GPS coordinates;
     * upgrade to lat/lng + radius when geolocation is added to the schema.
     */
    async notifyNearbyCouples(newCoupleId, city, newCoupleName) {
        const nearby = await prisma_1.prisma.couple.findMany({
            where: {
                coupleId: { not: newCoupleId },
                locationCity: city,
                isProfileComplete: true,
                bannedAt: null,
            },
            select: { coupleId: true },
            take: 200,
        });
        if (nearby.length === 0)
            return;
        const title = 'A new couple joined nearby';
        const message = `${newCoupleName} just joined SAWA in ${city}. Say hi!`;
        const notifData = { coupleId: newCoupleId, city, ...(0, notif_1.i18nData)('nearby.joined', { name: newCoupleName, city }) };
        // Persist + emit each notification.
        await Promise.all(nearby.map(async (c) => {
            const notif = await prisma_1.prisma.notification.create({
                data: {
                    recipientId: c.coupleId,
                    senderId: newCoupleId,
                    type: 'nearby',
                    title,
                    message,
                    data: notifData,
                },
            });
            (0, realtime_1.emitRealtimeNotification)(c.coupleId, {
                notificationId: notif.id,
                type: 'nearby',
                title,
                message,
                data: notifData,
            });
        }));
        logger_1.logger.info(`[CoupleService] Notified ${nearby.length} nearby couple(s) in ${city} about ${newCoupleId}`);
    }
    async deleteMyCouple(coupleId) {
        const couple = await prisma_1.prisma.couple.findUnique({ where: { coupleId } });
        if (!couple)
            return { success: true };
        // Private chats hold messages from BOTH couples keyed by matchId. Deleting
        // only `senderId = coupleId` would leave the partner's messages orphaned
        // (matchId set-null) once the matches are removed — so gather this couple's
        // match ids and delete every message under them.
        const myMatches = await prisma_1.prisma.match.findMany({
            where: { OR: [{ couple1Id: coupleId }, { couple2Id: coupleId }, { actionById: coupleId }] },
            select: { id: true },
        });
        const matchIds = myMatches.map((m) => m.id);
        // Run the whole deletion in ONE transaction so a mid-way failure can never
        // leave a half-deleted account (privacy/GDPR: no dangling personal data).
        // Order deletes children-before-parents to satisfy foreign keys. Includes
        // the couple-scoped tables that have no FK to Couple and were previously
        // never cleaned up (Us Space cycle/game data + subscription).
        await prisma_1.prisma.$transaction([
            prisma_1.prisma.onboardingAnswer.deleteMany({ where: { coupleId } }),
            prisma_1.prisma.message.deleteMany({ where: { matchId: { in: matchIds } } }),
            prisma_1.prisma.message.deleteMany({ where: { senderId: coupleId } }),
            prisma_1.prisma.notification.deleteMany({
                where: { OR: [{ recipientId: coupleId }, { senderId: coupleId }] },
            }),
            prisma_1.prisma.match.deleteMany({
                where: { OR: [{ couple1Id: coupleId }, { couple2Id: coupleId }, { actionById: coupleId }] },
            }),
            prisma_1.prisma.communityMember.deleteMany({ where: { coupleId } }),
            prisma_1.prisma.communityAdmin.deleteMany({ where: { coupleId } }),
            prisma_1.prisma.communityJoinRequest.deleteMany({ where: { coupleId } }),
            prisma_1.prisma.report.deleteMany({
                where: { OR: [{ reporterId: coupleId }, { targetId: coupleId }] },
            }),
            prisma_1.prisma.fridgeNote.deleteMany({ where: { coupleId } }),
            prisma_1.prisma.plannedDate.deleteMany({ where: { coupleId } }),
            prisma_1.prisma.usGameScore.deleteMany({ where: { coupleId } }),
            prisma_1.prisma.coupleUsState.deleteMany({ where: { coupleId } }),
            prisma_1.prisma.subscription.deleteMany({ where: { coupleId } }),
            prisma_1.prisma.user.deleteMany({ where: { coupleId } }),
            prisma_1.prisma.couple.delete({ where: { coupleId } }),
        ]);
        return { success: true };
    }
}
exports.CoupleService = CoupleService;
exports.coupleService = new CoupleService();
//# sourceMappingURL=couple.service.js.map