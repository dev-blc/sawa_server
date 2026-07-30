"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerUsHandlers = void 0;
const prisma_1 = require("../lib/prisma");
const logger_1 = require("../utils/logger");
const push_service_1 = require("../services/push.service");
const notif_1 = require("../i18n/notif");
const cache_1 = require("../lib/cache");
/** Redis key for a user's last shared feeling. TTL 7 days. */
const feelingKey = (coupleId, userId) => `us:feeling:${coupleId}:${userId}`;
/** An empty Tic-Tac-Toe board, encoded as 9 chars ('_' = empty cell). */
const TTT_EMPTY_BOARD = '_________';
/**
 * Clear the couple's persisted Tic-Tac-Toe session (challenge withdrawn, quit,
 * or game finished). Leaves the win-streak fields untouched.
 */
async function clearGameSession(coupleId, gameId) {
    await prisma_1.prisma.coupleUsState.updateMany({
        where: gameId ? { coupleId, gameSessionId: gameId } : { coupleId },
        data: {
            gameSessionId: null,
            gameSessionStatus: null,
            gameChallengerId: null,
            gameBoard: null,
            gameTurn: null,
            gameSessionAt: null,
        },
    });
}
/**
 * US Space Socket Handlers
 * ─────────────────────────────────────────────────────────────────────────
 * Handles real-time events between the two individual users of a couple:
 *   • us:nudge   — one partner sends a nudge (love, water reminder, etc.)
 *   • us:love    — quick love tap
 *   • us:feeling — partner shares how they feel
 *
 * PRIVACY RULE: These events are strictly private between the two partners.
 *   - The server relays each event to the couple room EXCLUDING the sender's
 *     socket so the sender never receives their own event.
 *   - Push notifications are sent ONLY to the partner (by userId), never to
 *     the sender, so the sender's notification tray stays clean.
 *   - Community/match notifications remain unchanged and go to both partners
 *     as before.
 * ─────────────────────────────────────────────────────────────────────────
 */
/**
 * Persist a couple-internal notification (love / hug / date plan) so it
 * shows up in the partner's in-app Notifications screen.
 *
 * Both partners share the same coupleId so `recipientId = coupleId`.
 * We store `senderUserId` inside `data` so the client can suppress the
 * notification for the person who sent it (sender sees nothing, only
 * the partner sees it).
 */
async function saveUsNotification(params) {
    try {
        const { coupleId, senderUserId, subtype, title, message, extraData } = params;
        await prisma_1.prisma.notification.create({
            data: {
                recipientId: coupleId,
                senderId: coupleId,
                type: 'system',
                title,
                message,
                data: { subtype, senderUserId, navigate: 'UsSpace', ...extraData },
                read: false,
            },
        });
        // Bust cached unread count so the bell badge updates immediately.
        await (0, cache_1.invalidateNotifUnreadCount)(coupleId);
    }
    catch (err) {
        logger_1.logger.warn(`[UsSocket] saveUsNotification failed: ${err.message}`);
    }
}
/** Returns just the first word of a name (e.g. "Kiran Bhangay" → "Kiran"). */
function firstName(name) {
    return (name || '').split(/\s+/)[0] || name;
}
function pronounsFor(role) {
    const female = role === 'partner';
    return female
        ? { subj: 'she', Subj: 'She', obj: 'her', poss: 'her', be: "she's", Be: "She's" }
        : { subj: 'he', Subj: 'He', obj: 'him', poss: 'his', be: "he's", Be: "He's" };
}
/** Look up the partner's User.id AND the sender's profile photo. */
async function findPartnerIdAndPhoto(senderUserId, coupleId) {
    try {
        const couple = await prisma_1.prisma.couple.findUnique({
            where: { coupleId },
            select: {
                partner1Id: true,
                partner2Id: true,
                primaryPhoto: true,
                secondaryPhotos: true,
            },
        });
        if (!couple)
            return { partnerId: null, senderPhoto: null };
        const partnerId = couple.partner1Id === senderUserId ? couple.partner2Id :
            couple.partner2Id === senderUserId ? couple.partner1Id : null;
        // Use the couple's primary photo as the sender's avatar in push notifications.
        const senderPhoto = couple.primaryPhoto ??
            (couple.secondaryPhotos?.[0] ?? null);
        return { partnerId, senderPhoto };
    }
    catch (err) {
        logger_1.logger.warn(`[UsSocket] findPartnerIdAndPhoto failed: ${err.message}`);
        return { partnerId: null, senderPhoto: null };
    }
}
const registerUsHandlers = (io, socket) => {
    const { userId, coupleId, userName, userRole } = socket;
    // Pronouns for the SENDER (the socket user) — used in all "from partner" copy.
    const p = pronounsFor(userRole);
    // Gender token for the SENDER (notifications describe the sender's action):
    // primary = male ('m'), partner = female ('f'). Used to localize gendered copy.
    const g = userRole === 'partner' ? 'f' : 'm';
    // ── us:nudge ──────────────────────────────────────────────────────────
    socket.on('us:nudge', async (payload) => {
        if (!userId || !coupleId)
            return;
        logger_1.logger.info(`[UsSocket] nudge(${payload.kind}) from ${userId} (${userName}) in couple ${coupleId}`);
        const senderName = firstName(userName || 'Your partner');
        // 1. Real-time relay — partner's socket only (exclude sender).
        io.to(`couple:${coupleId}`).except(socket.id).emit('us:nudge', {
            kind: payload.kind,
            message: payload.message,
            at: payload.at,
            from: senderName,
            // Unique id survives the relay so both partners converge on the same entry
            // (enables multiple plans per day + independent delete).
            id: payload.id,
            // Name of whoever originally PLANNED the date — survives the relay so the
            // partner's calendar always shows "Planned by <real name>", not "Partner".
            planBy: payload.planBy,
            date: payload.date,
            rawDate: payload.rawDate,
            activity: payload.activity,
            time: payload.time,
            note: payload.note,
        });
        // 2. Save in-app notification & set push title based on kind.
        const { partnerId, senderPhoto } = await findPartnerIdAndPhoto(userId, coupleId);
        let pushTitle = `${senderName} sent you a nudge 💛`;
        // i18n key/params used for BOTH the in-app row (client re-renders) and push.
        let i18nKey = 'us.nudge.generic';
        let i18nParams = { name: senderName };
        if (payload.kind === 'hug') {
            i18nKey = 'us.nudge.hug';
            i18nParams = { name: senderName };
            await saveUsNotification({
                coupleId,
                senderUserId: userId,
                subtype: 'us_hug',
                title: `${senderName} sent you a hug`,
                message: 'Warm hug heading your way',
                extraData: (0, notif_1.i18nData)(i18nKey, i18nParams),
            });
            pushTitle = `${senderName} sent you a hug 🤗`;
        }
        else if (payload.kind === 'kiss') {
            i18nKey = 'us.nudge.kiss';
            i18nParams = { name: senderName };
            await saveUsNotification({
                coupleId,
                senderUserId: userId,
                subtype: 'us_kiss',
                title: `${senderName} sent you a kiss`,
                message: 'A sweet kiss from your partner',
                extraData: (0, notif_1.i18nData)(i18nKey, i18nParams),
            });
            pushTitle = `${senderName} sent you a kiss 💋`;
        }
        else if (payload.kind === 'date_request') {
            const actLabel = payload.activity ? payload.activity : 'a date';
            const timeLabel = payload.time ? ` at ${payload.time}` : '';
            const dateMsg = payload.date ? `Want to go out on ${payload.date}${timeLabel} ✨` : 'Want to plan something special ✨';
            i18nKey = 'us.date.request';
            i18nParams = { name: senderName, actLabel };
            await saveUsNotification({
                coupleId,
                senderUserId: userId,
                subtype: 'us_date_plan',
                title: `Date request · ${actLabel}`,
                message: payload.note ? `${dateMsg.replace(' ✨', '')} — "${payload.note}"` : dateMsg.replace(' ✨', ''),
                extraData: { id: payload.id, date: payload.date, rawDate: payload.rawDate, activity: payload.activity, time: payload.time, note: payload.note, kind: 'date_request', planBy: payload.planBy || senderName, ...(0, notif_1.i18nData)(i18nKey, i18nParams) },
            });
            pushTitle = `${senderName} wants to plan ${actLabel} 📅`;
        }
        else if (payload.kind === 'date_accept') {
            i18nKey = 'us.date.accept';
            i18nParams = { name: senderName };
            await saveUsNotification({
                coupleId,
                senderUserId: userId,
                subtype: 'us_date_plan',
                title: '🎉 Date confirmed!',
                message: `It's on the calendar 🗓️`,
                extraData: { id: payload.id, date: payload.date, rawDate: payload.rawDate, activity: payload.activity, kind: 'date_accept', ...(0, notif_1.i18nData)(i18nKey, i18nParams) },
            });
            pushTitle = `${senderName} confirmed the date! 🎉`;
        }
        else if (payload.kind === 'date_reject') {
            i18nKey = 'us.date.reject';
            i18nParams = { name: senderName };
            await saveUsNotification({
                coupleId,
                senderUserId: userId,
                subtype: 'us_date_plan',
                title: '😔 Date declined',
                message: 'Maybe next time 🙏',
                extraData: { kind: 'date_reject', ...(0, notif_1.i18nData)(i18nKey, i18nParams) },
            });
            pushTitle = `${senderName} couldn't make it this time`;
        }
        else if (payload.kind === 'date_plan') {
            // Legacy fallback
            i18nKey = 'us.nudge.generic';
            i18nParams = { name: senderName };
            await saveUsNotification({
                coupleId,
                senderUserId: userId,
                subtype: 'us_date_plan',
                title: `${senderName} planned a date`,
                message: payload.message || 'A date has been planned for you two!',
                extraData: { date: payload.date, rawDate: payload.rawDate, activity: payload.activity, ...(0, notif_1.i18nData)(i18nKey, i18nParams) },
            });
        }
        else if (payload.kind === 'thinking') {
            i18nKey = 'us.nudge.thinking';
            i18nParams = { name: senderName, g };
            await saveUsNotification({
                coupleId,
                senderUserId: userId,
                subtype: 'us_thinking',
                title: `${senderName} is thinking of you`,
                message: `You crossed ${p.poss} mind right now`,
                extraData: (0, notif_1.i18nData)(i18nKey, i18nParams),
            });
            pushTitle = `${senderName} is thinking of you`;
        }
        else if (payload.kind === 'missyou') {
            i18nKey = 'us.nudge.missyou';
            i18nParams = { name: senderName, g };
            await saveUsNotification({
                coupleId,
                senderUserId: userId,
                subtype: 'us_missyou',
                title: `${senderName} misses you`,
                message: `${p.Subj} wishes you were here`,
                extraData: (0, notif_1.i18nData)(i18nKey, i18nParams),
            });
            pushTitle = `${senderName} misses you`;
        }
        else if (payload.kind === 'cheerup') {
            i18nKey = 'us.nudge.cheerup';
            i18nParams = { name: senderName };
            await saveUsNotification({
                coupleId,
                senderUserId: userId,
                subtype: 'us_cheerup',
                title: `${senderName} is cheering you up`,
                message: 'A little boost from your partner',
                extraData: (0, notif_1.i18nData)(i18nKey, i18nParams),
            });
            pushTitle = `${senderName} is cheering you up`;
        }
        else if (payload.kind === 'here') {
            i18nKey = 'us.nudge.here';
            i18nParams = { name: senderName, g };
            await saveUsNotification({
                coupleId,
                senderUserId: userId,
                subtype: 'us_here',
                title: `${senderName} is here for you`,
                message: `You have ${p.poss} full support`,
                extraData: (0, notif_1.i18nData)(i18nKey, i18nParams),
            });
            pushTitle = `${senderName} is here for you`;
        }
        else if (payload.kind === 'appreciate') {
            i18nKey = 'us.nudge.appreciate';
            i18nParams = { name: senderName, g };
            await saveUsNotification({
                coupleId,
                senderUserId: userId,
                subtype: 'us_appreciate',
                title: `${senderName} appreciates you`,
                message: `${p.Subj} is grateful to have you`,
                extraData: (0, notif_1.i18nData)(i18nKey, i18nParams),
            });
            pushTitle = `${senderName} appreciates you`;
        }
        // 3. In-app notification badge: tell the partner's Notifications screen to
        //    re-fetch immediately. Without this the date request sits in the DB but
        //    the partner's list never refreshes on its own (no socket push is sent
        //    by saveUsNotification itself).
        io.to(`couple:${coupleId}`).except(socket.id).emit('notification:new', {
            type: 'us_nudge',
            kind: payload.kind,
        });
        // 4. Push notification — only to the partner device.
        if (partnerId) {
            (0, push_service_1.pushToUser)(partnerId, {
                title: pushTitle,
                body: payload.message,
                data: {
                    type: 'us_nudge',
                    kind: payload.kind,
                    navigate: 'Notifications',
                    ...(senderPhoto ? { senderPhoto } : {}), // couple profile photo for largeIcon
                    ...(0, notif_1.i18nData)(i18nKey, i18nParams),
                },
                collapseKey: 'us_nudge',
            }).catch(() => null);
        }
    });
    // ── us:love ───────────────────────────────────────────────────────────
    socket.on('us:love', async (payload) => {
        if (!userId || !coupleId)
            return;
        logger_1.logger.info(`[UsSocket] love from ${userId} (${userName}) in couple ${coupleId}`);
        const senderName = firstName(payload.from || userName || 'Your partner');
        io.to(`couple:${coupleId}`).except(socket.id).emit('us:love', {
            from: senderName,
            at: payload.at,
        });
        // Save in-app notification (partner sees it; sender is filtered client-side).
        await saveUsNotification({
            coupleId,
            senderUserId: userId,
            subtype: 'us_love',
            title: `${senderName} sent you love ❤️`,
            message: 'Thinking of you 💛',
            extraData: (0, notif_1.i18nData)('us.nudge.love', { name: senderName }),
        });
        // Tell the partner's Notifications screen to refresh right away.
        io.to(`couple:${coupleId}`).except(socket.id).emit('notification:new', {
            type: 'us_love',
        });
        const { partnerId: lovePartnerId, senderPhoto: loveSenderPhoto } = await findPartnerIdAndPhoto(userId, coupleId);
        if (lovePartnerId) {
            (0, push_service_1.pushToUser)(lovePartnerId, {
                title: `${senderName} sent you love ❤️`,
                body: 'Tap to see it',
                data: { type: 'us_love', navigate: 'Notifications', ...(loveSenderPhoto ? { senderPhoto: loveSenderPhoto } : {}), ...(0, notif_1.i18nData)('us.nudge.love', { name: senderName }) },
                collapseKey: 'us_love',
            }).catch(() => null);
        }
    });
    // ── us:feeling ────────────────────────────────────────────────────────
    socket.on('us:feeling', async (payload) => {
        if (!userId || !coupleId)
            return;
        logger_1.logger.info(`[UsSocket] feeling from ${userId} (${userName}) in couple ${coupleId}`);
        const senderFirstName = firstName(userName || 'Your partner');
        const feelingPayload = {
            feeling: payload.feeling,
            note: payload.note,
            at: payload.at,
            from: senderFirstName,
        };
        // Persist so the partner can fetch it on any fresh login (7-day TTL)
        (0, cache_1.cacheSet)(feelingKey(coupleId, userId), JSON.stringify(feelingPayload), 7 * 24 * 60 * 60).catch(() => { });
        io.to(`couple:${coupleId}`).except(socket.id).emit('us:feeling', feelingPayload);
        const feelingLabel = payload.feeling || 'something';
        // Persist an in-app notification so the mood change shows up in the
        // partner's Notifications screen (sender is filtered out client-side).
        await saveUsNotification({
            coupleId,
            senderUserId: userId,
            subtype: 'us_mood',
            title: `${senderFirstName} updated ${p.poss} mood`,
            message: payload.note?.trim()
                ? `Feeling ${feelingLabel} — "${payload.note.trim()}"`
                : `${p.Be} feeling ${feelingLabel} right now`,
            extraData: { feeling: payload.feeling, ...(0, notif_1.i18nData)('us.mood', { name: senderFirstName, feeling: feelingLabel, g }) },
        });
        // Tell the partner's Notifications screen to refresh right away.
        io.to(`couple:${coupleId}`).except(socket.id).emit('notification:new', {
            type: 'us_mood',
            feeling: payload.feeling,
        });
        const { partnerId: feelPartnerId, senderPhoto: feelSenderPhoto } = await findPartnerIdAndPhoto(userId, coupleId);
        if (feelPartnerId) {
            (0, push_service_1.pushToUser)(feelPartnerId, {
                title: `${senderFirstName} shared how ${p.subj} feels`,
                body: payload.note?.trim()
                    ? `"${payload.note.trim()}"`
                    : `${p.Be} feeling ${feelingLabel} right now`,
                data: {
                    type: 'us_feeling',
                    feeling: payload.feeling,
                    navigate: 'Notifications',
                    ...(feelSenderPhoto ? { senderPhoto: feelSenderPhoto } : {}),
                    ...(0, notif_1.i18nData)('us.mood', { name: senderFirstName, feeling: feelingLabel, g }),
                },
                collapseKey: 'us_feeling',
            }).catch(() => null);
        }
    });
    // ═══ Tic-Tac-Toe — real-time couple game ═════════════════════════════════
    // The server is a thin, fast relay: moves are forwarded to the partner's
    // socket immediately. It also owns the persistent scoreboard in Redis and
    // the challenge notification (in-app + push) so an offline partner can join
    // from their notification tray.
    // ── us:game:challenge — invite the partner to a match ──────────────────
    socket.on('us:game:challenge', async (payload) => {
        if (!userId || !coupleId || !payload?.gameId)
            return;
        const senderName = firstName(userName || 'Your partner');
        logger_1.logger.info(`[UsSocket] game challenge ${payload.gameId} from ${userId} in couple ${coupleId}`);
        // 0. Persist a shared PENDING session so both partners can (re)join the same
        //    challenge even after leaving the screen — this is what prevents the
        //    "stale challenge" where the requester left and the partner got stuck.
        try {
            await prisma_1.prisma.coupleUsState.upsert({
                where: { coupleId },
                create: {
                    coupleId,
                    gameSessionId: payload.gameId,
                    gameSessionStatus: 'pending',
                    gameChallengerId: userId,
                    gameBoard: TTT_EMPTY_BOARD,
                    gameTurn: 'X',
                    gameSessionAt: new Date(),
                },
                update: {
                    gameSessionId: payload.gameId,
                    gameSessionStatus: 'pending',
                    gameChallengerId: userId,
                    gameBoard: TTT_EMPTY_BOARD,
                    gameTurn: 'X',
                    gameSessionAt: new Date(),
                },
            });
        }
        catch (err) {
            logger_1.logger.warn(`[UsSocket] persist challenge failed: ${err.message}`);
        }
        // 1. Instant relay so an online partner sees the invite immediately.
        io.to(`couple:${coupleId}`).except(socket.id).emit('us:game:challenge', {
            gameId: payload.gameId,
            from: senderName,
            fromUserId: userId,
            at: new Date().toISOString(),
        });
        // 2. In-app notification — tapping it deep-links into the game.
        await saveUsNotification({
            coupleId,
            senderUserId: userId,
            subtype: 'us_game_challenge',
            title: `${senderName} challenged you to Tic-Tac-Toe 🎮`,
            message: 'Tap to accept and play!',
            extraData: { gameId: payload.gameId, ...(0, notif_1.i18nData)('us.game.challenge', { name: senderName }) },
        });
        io.to(`couple:${coupleId}`).except(socket.id).emit('notification:new', { type: 'us_game_challenge' });
        // 3. Push — only to the partner's device.
        const { partnerId, senderPhoto } = await findPartnerIdAndPhoto(userId, coupleId);
        if (partnerId) {
            (0, push_service_1.pushToUser)(partnerId, {
                title: `${senderName} challenged you 🎮`,
                body: 'Tic-Tac-Toe! Tap to accept and play',
                data: {
                    type: 'us_game_challenge',
                    gameId: payload.gameId,
                    navigate: 'Notifications',
                    ...(senderPhoto ? { senderPhoto } : {}),
                    ...(0, notif_1.i18nData)('us.game.challenge', { name: senderName }),
                },
                collapseKey: 'us_game',
            }).catch(() => null);
        }
    });
    // ── us:game:accept — partner accepts; the whole room gets the start signal
    socket.on('us:game:accept', async (payload) => {
        if (!userId || !coupleId || !payload?.gameId)
            return;
        // Flip the shared session to ACTIVE so a rejoining partner resumes the match.
        try {
            await prisma_1.prisma.coupleUsState.updateMany({
                where: { coupleId, gameSessionId: payload.gameId },
                data: { gameSessionStatus: 'active', gameSessionAt: new Date() },
            });
        }
        catch (err) {
            logger_1.logger.warn(`[UsSocket] persist accept failed: ${err.message}`);
        }
        io.to(`couple:${coupleId}`).emit('us:game:start', {
            gameId: payload.gameId,
            accepterUserId: userId,
            accepterName: firstName(userName || ''),
            at: new Date().toISOString(),
        });
    });
    // ── us:game:move — relay a board move to the partner (fast path) ───────
    socket.on('us:game:move', async (payload) => {
        if (!userId || !coupleId || !payload?.gameId)
            return;
        // Relay first (fast path), then persist the board so both can resume.
        io.to(`couple:${coupleId}`).except(socket.id).emit('us:game:move', {
            gameId: payload.gameId,
            cell: payload.cell,
            symbol: payload.symbol,
            byUserId: userId,
        });
        try {
            const st = await prisma_1.prisma.coupleUsState.findUnique({ where: { coupleId } });
            if (st?.gameSessionId === payload.gameId &&
                typeof payload.cell === 'number' &&
                payload.cell >= 0 &&
                payload.cell < 9) {
                const arr = (st.gameBoard || TTT_EMPTY_BOARD).split('');
                arr[payload.cell] = payload.symbol === 'O' ? 'O' : 'X';
                await prisma_1.prisma.coupleUsState.update({
                    where: { coupleId },
                    data: {
                        gameBoard: arr.join(''),
                        gameTurn: payload.symbol === 'X' ? 'O' : 'X',
                        gameSessionAt: new Date(),
                    },
                });
            }
        }
        catch (err) {
            logger_1.logger.warn(`[UsSocket] persist move failed: ${err.message}`);
        }
    });
    // ── us:game:quit — one player leaves mid-game ──────────────────────────
    socket.on('us:game:quit', async (payload) => {
        if (!userId || !coupleId || !payload?.gameId)
            return;
        io.to(`couple:${coupleId}`).except(socket.id).emit('us:game:quit', {
            gameId: payload.gameId,
            byUserId: userId,
            byName: firstName(userName || ''),
        });
        try {
            await clearGameSession(coupleId, payload.gameId);
        }
        catch (err) {
            logger_1.logger.warn(`[UsSocket] clear session on quit failed: ${err.message}`);
        }
    });
    // ── us:game:result — winner's client reports; server scores it once ────
    socket.on('us:game:result', async (payload) => {
        if (!userId || !coupleId || !payload?.gameId)
            return;
        try {
            // The round is over — always clear the shared session (win, loss, or draw)
            // so the button returns to "Challenge" for both partners.
            await clearGameSession(coupleId, payload.gameId).catch(() => null);
            // Idempotency guard: score each gameId exactly once even if both
            // clients happen to report the same result.
            const scoredKey = `us:game_scored:${coupleId}:${payload.gameId}`;
            const already = await (0, cache_1.cacheGet)(scoredKey);
            if (already)
                return;
            await (0, cache_1.cacheSet)(scoredKey, '1', 24 * 60 * 60);
            if (!payload.draw && payload.winnerUserId) {
                const winnerId = payload.winnerUserId;
                // Durable win increment (source of truth: Postgres).
                await prisma_1.prisma.usGameScore.upsert({
                    where: { coupleId_userId: { coupleId, userId: winnerId } },
                    create: { coupleId, userId: winnerId, wins: 1 },
                    update: { wins: { increment: 1 } },
                });
                // Win streak — consecutive wins by the same partner. A win by the
                // other partner resets the streak to 1 for them.
                const state = await prisma_1.prisma.coupleUsState.findUnique({ where: { coupleId } });
                const nextCount = state?.gameStreakUserId === winnerId ? (state.gameStreakCount ?? 0) + 1 : 1;
                await prisma_1.prisma.coupleUsState.upsert({
                    where: { coupleId },
                    create: { coupleId, gameStreakUserId: winnerId, gameStreakCount: nextCount },
                    update: { gameStreakUserId: winnerId, gameStreakCount: nextCount },
                });
                // Read back the full scoreboard and broadcast to BOTH partners.
                const scores = await prisma_1.prisma.usGameScore.findMany({ where: { coupleId } });
                const pts = {};
                for (const s of scores)
                    pts[s.userId] = s.wins;
                const streak = { userId: winnerId, count: nextCount };
                io.to(`couple:${coupleId}`).emit('us:game:points', { points: pts, streak });
            }
        }
        catch (err) {
            logger_1.logger.warn(`[UsSocket] game result failed: ${err.message}`);
        }
    });
};
exports.registerUsHandlers = registerUsHandlers;
//# sourceMappingURL=us.socket.js.map