"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../middleware/authenticate");
const adminAuth_1 = require("../middleware/adminAuth");
const cache_1 = require("../lib/cache");
const prisma_1 = require("../lib/prisma");
const logger_1 = require("../utils/logger");
const push_service_1 = require("../services/push.service");
const notif_1 = require("../i18n/notif");
const router = (0, express_1.Router)();
/** Resolve partner's userId and sender's first name for couple-internal pushes. */
async function getPartnerAndSender(myUserId, coupleId) {
    const couple = await prisma_1.prisma.couple.findUnique({
        where: { coupleId },
        select: { partner1Id: true, partner2Id: true, profileName: true },
    });
    const user = await prisma_1.prisma.user.findUnique({
        where: { id: myUserId },
        select: { name: true, role: true },
    });
    let senderName = user?.name?.trim().split(/\s+/)[0] || '';
    if (!senderName && couple?.profileName) {
        const parts = couple.profileName.split(/\s*&\s*/);
        senderName = (user?.role === 'partner' ? parts[1] : parts[0])?.trim().split(/\s+/)[0] || '';
    }
    if (!senderName)
        senderName = 'Your partner';
    const partnerId = couple
        ? couple.partner1Id === myUserId ? couple.partner2Id
            : couple.partner2Id === myUserId ? couple.partner1Id
                : null
        : null;
    return { partnerId, senderName };
}
const FEELING_TTL = 7 * 24 * 60 * 60; // 7 days
/**
 * POST /api/v1/us/my-feeling
 *
 * Saves the authenticated user's current mood to Redis so their partner
 * can fetch it after a fresh login (even if the socket was not connected).
 */
router.post('/my-feeling', authenticate_1.authenticate, async (req, res) => {
    const coupleId = req.user?.coupleId;
    const myUserId = req.user?.userId;
    if (!coupleId || !myUserId) {
        res.status(400).json({ success: false, error: 'Missing couple context' });
        return;
    }
    const { feeling, note, at } = req.body;
    if (!feeling) {
        res.status(400).json({ success: false, error: 'feeling is required' });
        return;
    }
    try {
        // Resolve sender's display name from the couple profile
        const couple = await prisma_1.prisma.couple.findUnique({
            where: { coupleId },
            select: { profileName: true, partner1Id: true, partner2Id: true },
        });
        const user = await prisma_1.prisma.user.findUnique({
            where: { id: myUserId },
            select: { name: true, role: true },
        });
        // Derive first name: prefer user.name, else first half of "Name & Partner"
        let senderName = user?.name?.trim() || '';
        if (!senderName && couple?.profileName) {
            const parts = couple.profileName.split(/\s*&\s*/);
            senderName = (user?.role === 'partner' ? parts[1] : parts[0])?.trim() || '';
        }
        if (!senderName)
            senderName = 'Your partner';
        const payload = {
            feeling,
            note: note ?? '',
            at: at ?? new Date().toISOString(),
            from: senderName,
        };
        await (0, cache_1.cacheSet)(`us:feeling:${coupleId}:${myUserId}`, JSON.stringify(payload), FEELING_TTL);
        res.json({ success: true });
    }
    catch (err) {
        logger_1.logger.warn(`[UsRoutes] my-feeling POST error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Failed to save feeling' });
    }
});
/**
 * GET /api/v1/us/partner-feeling
 *
 * Returns the last mood the partner shared (stored in Redis).
 * Falls back to null if nothing has been shared yet.
 */
router.get('/partner-feeling', authenticate_1.authenticate, async (req, res) => {
    const coupleId = req.user?.coupleId;
    const myUserId = req.user?.userId;
    if (!coupleId || !myUserId) {
        res.json({ success: true, data: null });
        return;
    }
    try {
        const couple = await prisma_1.prisma.couple.findUnique({
            where: { coupleId },
            select: { partner1Id: true, partner2Id: true },
        });
        if (!couple) {
            res.json({ success: true, data: null });
            return;
        }
        const partnerId = couple.partner1Id === myUserId ? couple.partner2Id : couple.partner1Id;
        if (!partnerId) {
            res.json({ success: true, data: null });
            return;
        }
        const raw = await (0, cache_1.cacheGet)(`us:feeling:${coupleId}:${partnerId}`);
        if (!raw) {
            res.json({ success: true, data: null });
            return;
        }
        const feeling = JSON.parse(raw);
        res.json({ success: true, data: feeling });
    }
    catch (err) {
        logger_1.logger.warn(`[UsRoutes] partner-feeling GET error: ${err.message}`);
        res.json({ success: true, data: null });
    }
});
/** Map a Postgres PlannedDate row to the client shape the app expects. */
const serializePlan = (p) => ({
    id: p.id,
    activity: p.activity,
    date: p.dateLabel ?? p.rawDate,
    rawDate: p.rawDate,
    from: p.fromName ?? 'Your partner',
    ...(p.time ? { time: p.time } : {}),
    ...(p.note ? { note: p.note } : {}),
});
/**
 * POST /api/v1/us/planned-dates
 * Add or update a planned date entry for the couple.
 * Body: { activity, date, rawDate, from?, time?, note? }
 */
router.post('/planned-dates', authenticate_1.authenticate, async (req, res) => {
    const coupleId = req.user?.coupleId;
    const myUserId = req.user?.userId;
    if (!coupleId) {
        res.status(400).json({ success: false, error: 'Missing couple context' });
        return;
    }
    const { id, activity, date, rawDate, from, time, note } = req.body;
    if (!activity || !rawDate) {
        res.status(400).json({ success: false, error: 'activity and rawDate are required' });
        return;
    }
    try {
        // Stable id lets multiple plans live on the same day; upsert by id.
        const entryId = id || `${rawDate}__${activity}__${time ?? ''}`;
        // Ownership guard: the client can supply `id`, and upsert's `update` branch
        // would otherwise let a caller overwrite (and reassign `coupleId` on) another
        // couple's planned date. Reject any id already owned by a different couple.
        const existing = await prisma_1.prisma.plannedDate.findUnique({
            where: { id: entryId },
            select: { coupleId: true },
        });
        if (existing && existing.coupleId !== coupleId) {
            res.status(403).json({ success: false, error: 'Not allowed' });
            return;
        }
        const data = {
            coupleId,
            activity,
            dateLabel: date ?? rawDate,
            rawDate,
            fromName: from || 'Your partner',
            time: time || null,
            note: note || null,
            byUserId: myUserId || null,
        };
        await prisma_1.prisma.plannedDate.upsert({
            where: { id: entryId },
            create: { id: entryId, ...data },
            update: data,
        });
        res.json({ success: true });
    }
    catch (err) {
        logger_1.logger.warn(`[UsRoutes] planned-dates POST error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Failed to save planned date' });
    }
});
/**
 * GET /api/v1/us/planned-dates
 * Returns all planned dates for the couple.
 */
router.get('/planned-dates', authenticate_1.authenticate, async (req, res) => {
    const coupleId = req.user?.coupleId;
    if (!coupleId) {
        res.json({ success: true, data: [] });
        return;
    }
    try {
        const rows = await prisma_1.prisma.plannedDate.findMany({
            where: { coupleId },
            orderBy: { rawDate: 'asc' },
        });
        res.json({ success: true, data: rows.map(serializePlan) });
    }
    catch (err) {
        logger_1.logger.warn(`[UsRoutes] planned-dates GET error: ${err.message}`);
        res.json({ success: true, data: [] });
    }
});
/**
 * DELETE /api/v1/us/planned-dates/:id
 * Remove a single planned date by its unique id. Falls back to matching rawDate
 * so older clients (that delete by YYYY-MM-DD) keep working.
 */
router.delete('/planned-dates/:id', authenticate_1.authenticate, async (req, res) => {
    const coupleId = req.user?.coupleId;
    const { id } = req.params;
    if (!coupleId || !id) {
        res.status(400).json({ success: false });
        return;
    }
    try {
        await prisma_1.prisma.plannedDate.deleteMany({
            where: { coupleId, OR: [{ id }, { rawDate: id }] },
        });
        res.json({ success: true });
    }
    catch (err) {
        logger_1.logger.warn(`[UsRoutes] planned-dates DELETE error: ${err.message}`);
        res.status(500).json({ success: false });
    }
});
/**
 * DELETE /api/v1/us/my-feeling
 * Clears the authenticated user's feeling from Redis (for testing/reset).
 */
router.delete('/my-feeling', authenticate_1.authenticate, async (req, res) => {
    const coupleId = req.user?.coupleId;
    const myUserId = req.user?.userId;
    if (!coupleId || !myUserId) {
        res.status(400).json({ success: false, error: 'Missing couple context' });
        return;
    }
    try {
        await (0, cache_1.cacheInvalidate)(`us:feeling:${coupleId}:${myUserId}`);
        res.json({ success: true });
    }
    catch {
        res.status(500).json({ success: false, error: 'Failed to clear feeling' });
    }
});
// ─── Ask How They're Feeling ─────────────────────────────────────────────────
const ASK_FEELING_COOLDOWN = 30 * 60; // 30 min between asks (anti-spam)
/**
 * POST /api/v1/us/ask-feeling
 * Sends a gentle "how are you feeling?" nudge to the partner — push +
 * in-app notification. Throttled to once per 30 minutes per sender.
 */
router.post('/ask-feeling', authenticate_1.authenticate, async (req, res) => {
    const coupleId = req.user?.coupleId;
    const myUserId = req.user?.userId;
    if (!coupleId || !myUserId) {
        res.status(400).json({ success: false, error: 'Missing couple context' });
        return;
    }
    try {
        const throttleKey = `us:ask_feeling:${coupleId}:${myUserId}`;
        const already = await (0, cache_1.cacheGet)(throttleKey);
        if (already) {
            res.status(429).json({ success: false, error: 'cooldown' });
            return;
        }
        const { partnerId, senderName } = await getPartnerAndSender(myUserId, coupleId);
        await (0, cache_1.cacheSet)(throttleKey, '1', ASK_FEELING_COOLDOWN);
        // In-app notification for the partner's bell
        await prisma_1.prisma.notification.create({
            data: {
                recipientId: coupleId,
                senderId: coupleId,
                type: 'system',
                title: `${senderName} is asking how you feel`,
                message: `Share your mood with ${senderName} 💭`,
                data: { subtype: 'us_ask_feeling', senderUserId: myUserId, navigate: 'UsSpace', ...(0, notif_1.i18nData)('us.askFeeling', { name: senderName }) },
                read: false,
            },
        });
        await (0, cache_1.invalidateNotifUnreadCount)(coupleId);
        // Real-time: refresh partner's notification bell + show toast if on Us page
        const io = global.io;
        if (io) {
            io.to(`couple:${coupleId}`).emit('notification:new', { type: 'us_ask_feeling' });
            io.to(`couple:${coupleId}`).emit('us:ask-feeling', { from: senderName, senderUserId: myUserId });
        }
        // Push notification to partner's device
        if (partnerId) {
            (0, push_service_1.pushToUser)(partnerId, {
                title: `${senderName} is asking how you feel 💭`,
                body: `Let ${senderName} know how your day is going`,
                data: { type: 'us_ask_feeling', navigate: 'UsSpace', ...(0, notif_1.i18nData)('us.askFeeling', { name: senderName }) },
                collapseKey: 'us_ask_feeling',
            }).catch(() => null);
        }
        res.json({ success: true });
    }
    catch (err) {
        logger_1.logger.warn(`[UsRoutes] ask-feeling POST error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Failed to send' });
    }
});
// ─── Fridge Notes (sticky notes between partners) ────────────────────────────
const MAX_FRIDGE_NOTES = 30;
/** Map a Postgres FridgeNote row to the client DTO the app already expects. */
const serializeNote = (n) => ({
    id: n.id,
    text: n.text,
    color: n.color,
    by: n.byName,
    byUserId: n.byUserId,
    at: n.createdAt.toISOString(),
    ...(n.ackBy ? { ackBy: n.ackBy } : {}),
    ...(n.ackAt ? { ackAt: n.ackAt.toISOString() } : {}),
});
/**
 * GET /api/v1/us/fridge-notes
 * All sticky notes for the couple (newest first).
 */
router.get('/fridge-notes', authenticate_1.authenticate, async (req, res) => {
    const coupleId = req.user?.coupleId;
    if (!coupleId) {
        res.json({ success: true, data: [] });
        return;
    }
    try {
        const notes = await prisma_1.prisma.fridgeNote.findMany({
            where: { coupleId },
            orderBy: { createdAt: 'desc' },
            take: MAX_FRIDGE_NOTES,
        });
        res.json({ success: true, data: notes.map(serializeNote) });
    }
    catch (err) {
        logger_1.logger.warn(`[UsRoutes] fridge-notes GET error: ${err.message}`);
        res.json({ success: true, data: [] });
    }
});
/**
 * POST /api/v1/us/fridge-notes
 * Create a sticky note. Body: { text, color }
 * Notifies the partner (push + in-app + socket).
 */
router.post('/fridge-notes', authenticate_1.authenticate, async (req, res) => {
    const coupleId = req.user?.coupleId;
    const myUserId = req.user?.userId;
    if (!coupleId || !myUserId) {
        res.status(400).json({ success: false, error: 'Missing couple context' });
        return;
    }
    const { text, color } = req.body;
    const trimmed = (text ?? '').trim();
    if (!trimmed) {
        res.status(400).json({ success: false, error: 'text is required' });
        return;
    }
    if (trimmed.length > 200) {
        res.status(400).json({ success: false, error: 'Note too long (max 200 chars)' });
        return;
    }
    try {
        const { partnerId, senderName } = await getPartnerAndSender(myUserId, coupleId);
        const row = await prisma_1.prisma.fridgeNote.create({
            data: {
                coupleId,
                text: trimmed,
                color: color || 'yellow',
                byName: senderName,
                byUserId: myUserId,
            },
        });
        const note = serializeNote(row);
        // Trim to the newest MAX_FRIDGE_NOTES — delete the overflow tail.
        const overflow = await prisma_1.prisma.fridgeNote.findMany({
            where: { coupleId },
            orderBy: { createdAt: 'desc' },
            skip: MAX_FRIDGE_NOTES,
            select: { id: true },
        });
        if (overflow.length) {
            await prisma_1.prisma.fridgeNote.deleteMany({ where: { id: { in: overflow.map(o => o.id) } } });
        }
        // In-app notification
        await prisma_1.prisma.notification.create({
            data: {
                recipientId: coupleId,
                senderId: coupleId,
                type: 'system',
                title: `${senderName} left a note on the fridge`,
                message: trimmed.length > 60 ? `"${trimmed.slice(0, 57)}…"` : `"${trimmed}"`,
                data: { subtype: 'us_fridge_note', senderUserId: myUserId, navigate: 'UsSpace', noteId: note.id, ...(0, notif_1.i18nData)('us.fridgeNote', { name: senderName, note: trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed }) },
                read: false,
            },
        });
        await (0, cache_1.invalidateNotifUnreadCount)(coupleId);
        const io = global.io;
        if (io) {
            io.to(`couple:${coupleId}`).emit('us:fridge-note', { action: 'created', note });
            io.to(`couple:${coupleId}`).emit('notification:new', { type: 'us_fridge_note' });
        }
        if (partnerId) {
            (0, push_service_1.pushToUser)(partnerId, {
                title: `${senderName} left a note on the fridge 📌`,
                body: trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed,
                data: { type: 'us_fridge_note', navigate: 'UsSpace', ...(0, notif_1.i18nData)('us.fridgeNote', { name: senderName, note: trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed }) },
                collapseKey: 'us_fridge_note',
            }).catch(() => null);
        }
        res.json({ success: true, data: note });
    }
    catch (err) {
        logger_1.logger.warn(`[UsRoutes] fridge-notes POST error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Failed to save note' });
    }
});
/**
 * PATCH /api/v1/us/fridge-notes/:id/ack
 * Partner acknowledges a note (seen/done). Notifies the author.
 */
router.patch('/fridge-notes/:id/ack', authenticate_1.authenticate, async (req, res) => {
    const coupleId = req.user?.coupleId;
    const myUserId = req.user?.userId;
    const { id } = req.params;
    if (!coupleId || !myUserId || !id) {
        res.status(400).json({ success: false });
        return;
    }
    try {
        const existing = await prisma_1.prisma.fridgeNote.findFirst({ where: { id, coupleId } });
        if (!existing) {
            res.status(404).json({ success: false, error: 'Note not found' });
            return;
        }
        if (existing.byUserId === myUserId) {
            res.status(400).json({ success: false, error: 'Cannot acknowledge your own note' });
            return;
        }
        if (existing.ackAt) {
            res.json({ success: true, data: serializeNote(existing) });
            return;
        }
        const { senderName } = await getPartnerAndSender(myUserId, coupleId);
        const updatedRow = await prisma_1.prisma.fridgeNote.update({
            where: { id },
            data: { ackBy: senderName, ackAt: new Date() },
        });
        const note = serializeNote(updatedRow);
        // Notify the note's AUTHOR that it was acknowledged
        const authorId = updatedRow.byUserId;
        await prisma_1.prisma.notification.create({
            data: {
                recipientId: coupleId,
                senderId: coupleId,
                type: 'system',
                title: `${senderName} acknowledged your note ✓`,
                message: note.text.length > 60 ? `"${note.text.slice(0, 57)}…"` : `"${note.text}"`,
                data: { subtype: 'us_fridge_ack', senderUserId: myUserId, navigate: 'UsSpace', noteId: id, ...(0, notif_1.i18nData)('us.fridgeAck', { name: senderName, note: note.text.length > 80 ? `${note.text.slice(0, 77)}…` : note.text }) },
                read: false,
            },
        });
        await (0, cache_1.invalidateNotifUnreadCount)(coupleId);
        const io = global.io;
        if (io) {
            io.to(`couple:${coupleId}`).emit('us:fridge-note', { action: 'acked', note });
            io.to(`couple:${coupleId}`).emit('notification:new', { type: 'us_fridge_ack' });
        }
        (0, push_service_1.pushToUser)(authorId, {
            title: `${senderName} acknowledged your note ✓`,
            body: note.text.length > 80 ? `${note.text.slice(0, 77)}…` : note.text,
            data: { type: 'us_fridge_ack', navigate: 'UsSpace', ...(0, notif_1.i18nData)('us.fridgeAck', { name: senderName, note: note.text.length > 80 ? `${note.text.slice(0, 77)}…` : note.text }) },
            collapseKey: 'us_fridge_ack',
        }).catch(() => null);
        res.json({ success: true, data: note });
    }
    catch (err) {
        logger_1.logger.warn(`[UsRoutes] fridge-notes ACK error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Failed to acknowledge' });
    }
});
/**
 * DELETE /api/v1/us/fridge-notes/:id
 * Remove a sticky note (either partner can erase).
 */
router.delete('/fridge-notes/:id', authenticate_1.authenticate, async (req, res) => {
    const coupleId = req.user?.coupleId;
    const { id } = req.params;
    if (!coupleId || !id) {
        res.status(400).json({ success: false });
        return;
    }
    try {
        await prisma_1.prisma.fridgeNote.deleteMany({ where: { id, coupleId } });
        const io = global.io;
        if (io) {
            io.to(`couple:${coupleId}`).emit('us:fridge-note', { action: 'deleted', noteId: id });
        }
        res.json({ success: true });
    }
    catch (err) {
        logger_1.logger.warn(`[UsRoutes] fridge-notes DELETE error: ${err.message}`);
        res.status(500).json({ success: false });
    }
});
// ═══ Menstrual cycle (Flo-style) ════════════════════════════════════════════
// The partner-role account (the girlfriend) sets: last period start date,
// period length and cycle length. Both partners can view; predictions are
// computed client-side with the same math the notifier job uses.
/**
 * GET /api/v1/us/cycle
 * Returns the couple's cycle settings, or null when not set up yet.
 */
router.get('/cycle', authenticate_1.authenticate, async (req, res) => {
    const coupleId = req.user?.coupleId;
    if (!coupleId) {
        res.json({ success: true, data: null });
        return;
    }
    try {
        const state = await prisma_1.prisma.coupleUsState.findUnique({ where: { coupleId } });
        const data = state?.cycleLastPeriodStart
            ? {
                lastPeriodStart: state.cycleLastPeriodStart,
                periodLength: state.cyclePeriodLength ?? 5,
                cycleLength: state.cycleCycleLength ?? 28,
                updatedBy: state.cycleUpdatedBy ?? undefined,
                updatedByName: state.cycleUpdatedByName ?? undefined,
                updatedAt: state.cycleUpdatedAt?.toISOString(),
            }
            : null;
        res.json({ success: true, data });
    }
    catch (err) {
        logger_1.logger.warn(`[UsRoutes] cycle GET error: ${err.message}`);
        res.json({ success: true, data: null });
    }
});
/**
 * POST /api/v1/us/cycle
 * Saves cycle settings. Only the partner-role account may set them.
 * Notifies the primary partner that the cycle calendar was shared.
 */
router.post('/cycle', authenticate_1.authenticate, async (req, res) => {
    const coupleId = req.user?.coupleId;
    const myUserId = req.user?.userId;
    if (!coupleId || !myUserId) {
        res.status(400).json({ success: false, error: 'Missing couple context' });
        return;
    }
    const { lastPeriodStart, periodLength, cycleLength } = req.body;
    if (!lastPeriodStart || !/^\d{4}-\d{2}-\d{2}$/.test(lastPeriodStart)) {
        res.status(400).json({ success: false, error: 'lastPeriodStart (YYYY-MM-DD) is required' });
        return;
    }
    const pLen = Math.min(10, Math.max(2, Number(periodLength) || 5));
    const cLen = Math.min(45, Math.max(21, Number(cycleLength) || 28));
    try {
        const me = await prisma_1.prisma.user.findUnique({ where: { id: myUserId }, select: { name: true, role: true } });
        if (me?.role !== 'partner') {
            res.status(403).json({ success: false, error: 'Only your partner can set the cycle' });
            return;
        }
        const { partnerId, senderName } = await getPartnerAndSender(myUserId, coupleId);
        const now = new Date();
        const settings = {
            lastPeriodStart,
            periodLength: pLen,
            cycleLength: cLen,
            updatedBy: myUserId,
            updatedByName: senderName,
            updatedAt: now.toISOString(),
        };
        const cycleFields = {
            cycleLastPeriodStart: lastPeriodStart,
            cyclePeriodLength: pLen,
            cycleCycleLength: cLen,
            cycleUpdatedBy: myUserId,
            cycleUpdatedByName: senderName,
            cycleUpdatedAt: now,
        };
        await prisma_1.prisma.coupleUsState.upsert({
            where: { coupleId },
            create: { coupleId, ...cycleFields },
            update: cycleFields,
        });
        // Tell the primary partner the calendar is ready.
        await prisma_1.prisma.notification.create({
            data: {
                recipientId: coupleId,
                senderId: coupleId,
                type: 'system',
                title: `🌸 ${senderName} shared her cycle calendar`,
                message: 'Tap the calendar on your Us page to see it',
                data: { subtype: 'us_cycle', senderUserId: myUserId, navigate: 'UsSpace', ...(0, notif_1.i18nData)('us.cycleShared', { name: senderName }) },
                read: false,
            },
        });
        await (0, cache_1.invalidateNotifUnreadCount)(coupleId);
        const io = global.io;
        if (io) {
            io.to(`couple:${coupleId}`).emit('us:cycle:updated', settings);
            io.to(`couple:${coupleId}`).emit('notification:new', { type: 'us_cycle' });
        }
        if (partnerId) {
            (0, push_service_1.pushToUser)(partnerId, {
                title: `🌸 ${senderName} shared her cycle calendar`,
                body: 'Tap to see it and be there for her',
                data: { type: 'us_cycle', navigate: 'Notifications', ...(0, notif_1.i18nData)('us.cycleShared', { name: senderName }) },
                collapseKey: 'us_cycle',
            }).catch(() => null);
        }
        res.json({ success: true, data: settings });
    }
    catch (err) {
        logger_1.logger.warn(`[UsRoutes] cycle POST error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Failed to save cycle' });
    }
});
/**
 * GET /api/v1/us/game/points
 * Tic-Tac-Toe scoreboard for the couple:
 *   { points: { [userId]: wins }, streak: { userId, count } | null }
 */
router.get('/game/points', authenticate_1.authenticate, async (req, res) => {
    const coupleId = req.user?.coupleId;
    if (!coupleId) {
        res.json({ success: true, data: { points: {}, streak: null } });
        return;
    }
    try {
        const [scores, state] = await Promise.all([
            prisma_1.prisma.usGameScore.findMany({ where: { coupleId } }),
            prisma_1.prisma.coupleUsState.findUnique({ where: { coupleId } }),
        ]);
        const points = {};
        for (const s of scores)
            points[s.userId] = s.wins;
        const streak = state?.gameStreakUserId
            ? { userId: state.gameStreakUserId, count: state.gameStreakCount }
            : null;
        res.json({ success: true, data: { points, streak } });
    }
    catch (err) {
        logger_1.logger.warn(`[UsRoutes] game points GET error: ${err.message}`);
        res.json({ success: true, data: { points: {}, streak: null } });
    }
});
/**
 * GET /api/v1/us/game/active
 * The couple's current shared Tic-Tac-Toe session so a partner who left the
 * screen (or received a challenge push) can (re)join the same match:
 *   { session: null | { gameId, status: 'pending'|'active', challengerId,
 *                       board: (('X'|'O'|null)[]), turn: 'X'|'O' } }
 * Auto-expires sessions with no activity for >3h so a forgotten challenge can
 * never block new games forever.
 */
router.get('/game/active', authenticate_1.authenticate, async (req, res) => {
    const coupleId = req.user?.coupleId;
    if (!coupleId) {
        res.json({ success: true, data: { session: null } });
        return;
    }
    try {
        const st = await prisma_1.prisma.coupleUsState.findUnique({ where: { coupleId } });
        if (!st?.gameSessionId || !st.gameSessionStatus) {
            res.json({ success: true, data: { session: null } });
            return;
        }
        const ageMs = st.gameSessionAt ? Date.now() - new Date(st.gameSessionAt).getTime() : Number.MAX_SAFE_INTEGER;
        if (ageMs > 3 * 60 * 60 * 1000) {
            await prisma_1.prisma.coupleUsState.update({
                where: { coupleId },
                data: {
                    gameSessionId: null, gameSessionStatus: null, gameChallengerId: null,
                    gameBoard: null, gameTurn: null, gameSessionAt: null,
                },
            });
            res.json({ success: true, data: { session: null } });
            return;
        }
        // Game type is encoded in the gameId prefix. Dots & Boxes and Memory Match
        // store a serialized state string (contains '|'); Tic-Tac-Toe stores a
        // 9-char board.
        const gameType = st.gameSessionId.startsWith('dab_')
            ? 'dab'
            : st.gameSessionId.startsWith('mem_')
                ? 'mem'
                : 'ttt';
        const board = gameType === 'ttt'
            ? (st.gameBoard || '_________')
                .split('')
                .map((c) => (c === 'X' ? 'X' : c === 'O' ? 'O' : null))
            : null;
        res.json({
            success: true,
            data: {
                session: {
                    gameId: st.gameSessionId,
                    gameType,
                    status: st.gameSessionStatus,
                    challengerId: st.gameChallengerId,
                    board,
                    state: gameType === 'ttt' ? null : (st.gameBoard || null),
                    turn: st.gameTurn || 'X',
                },
            },
        });
    }
    catch (err) {
        logger_1.logger.warn(`[UsRoutes] game active GET error: ${err.message}`);
        res.json({ success: true, data: { session: null } });
    }
});
/**
 * POST /api/v1/us/admin-clear-feeling
 * Admin-only: clears any user's feeling by coupleId + userId.
 * Protected by the admin JWT (adminAuth) — the previous hardcoded query-string
 * secret was removed as it was a trivial, unauthenticated backdoor.
 */
router.post('/admin-clear-feeling', adminAuth_1.adminAuth, async (req, res) => {
    const { coupleId, userId } = req.body;
    if (!coupleId || !userId) {
        res.status(400).json({ success: false, error: 'coupleId and userId required' });
        return;
    }
    try {
        await (0, cache_1.cacheInvalidate)(`us:feeling:${coupleId}:${userId}`);
        res.json({ success: true, deleted: `us:feeling:${coupleId}:${userId}` });
    }
    catch {
        res.status(500).json({ success: false, error: 'Failed to clear feeling' });
    }
});
exports.default = router;
//# sourceMappingURL=us.routes.js.map