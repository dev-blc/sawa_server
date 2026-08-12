"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startCycleNotifier = exports.CYCLE_TTL = exports.CYCLE_INDEX_KEY = exports.cycleKey = void 0;
exports.cycleDayFor = cycleDayFor;
exports.runCheck = runCheck;
const prisma_1 = require("../lib/prisma");
const cache_1 = require("../lib/cache");
const push_service_1 = require("../services/push.service");
const notif_1 = require("../i18n/notif");
const logger_1 = require("../utils/logger");
const cycleKey = (coupleId) => `us:cycle:${coupleId}`;
exports.cycleKey = cycleKey;
exports.CYCLE_INDEX_KEY = 'us:cycle_index';
exports.CYCLE_TTL = 365 * 24 * 60 * 60;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** Today's date + hour in IST (couples are India-based). */
function istNow() {
    const d = new Date(Date.now() + IST_OFFSET_MS);
    const dateStr = d.toISOString().slice(0, 10);
    return { dateStr, hour: d.getUTCHours() };
}
/** 1-based day within the (predicted) cycle for a YYYY-MM-DD date. */
function cycleDayFor(dateStr, s) {
    const start = Date.UTC(Number(s.lastPeriodStart.slice(0, 4)), Number(s.lastPeriodStart.slice(5, 7)) - 1, Number(s.lastPeriodStart.slice(8, 10)));
    const day = Date.UTC(Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)) - 1, Number(dateStr.slice(8, 10)));
    const diff = Math.round((day - start) / 86400000);
    const len = Math.max(21, s.cycleLength || 28);
    return ((diff % len) + len) % len + 1;
}
/** Milestone that starts on this cycle day, if any. */
function milestoneFor(day, s) {
    const len = Math.max(21, s.cycleLength || 28);
    const ovulation = len - 14;
    if (day === 1)
        return 'period';
    if (day === ovulation - 5)
        return 'fertile';
    if (day === ovulation)
        return 'ovulation';
    // Advance heads-up: ~2 days before the next period (day len-1 → period on day 1).
    if (day === len - 1)
        return 'pre_period';
    if (day === len - 2)
        return 'pms';
    return null;
}
function messagesFor(milestone, girl, boy) {
    switch (milestone) {
        case 'pre_period':
            return {
                title: `🌸 ${girl}'s period is coming soon`,
                body: `Hey ${boy}, ${girl} may get her period in a day or two — be extra gentle and stock up on her favourites 💗`,
            };
        case 'period':
            return {
                title: `🌸 ${girl}'s period may start today`,
                body: `Hey ${boy}, be extra gentle and caring with her today 💗`,
            };
        case 'fertile':
            return {
                title: `💞 ${girl}'s fertile window starts today`,
                body: `Hey ${boy}, a little extra love goes a long way this week`,
            };
        case 'ovulation':
            return {
                title: `💝 ${girl} is in her ovulation period`,
                body: `Hey ${boy}, give her some treats and chocolates to make her feel special!`,
            };
        case 'pms':
            return {
                title: `🫂 ${girl} may have mood swings now`,
                body: `Hey ${boy}, ${girl} is in her PMS phase just before her period — she might feel moody or extra sensitive. Be patient, compliment her, and surprise her with something she loves 💗`,
            };
    }
}
async function runCheck() {
    const { dateStr, hour } = istNow();
    // Quiet hours — only nudge between 08:00 and 21:00 IST.
    if (hour < 8 || hour >= 21)
        return;
    try {
        // Source of truth is Postgres: every couple that has set a cycle.
        const states = await prisma_1.prisma.coupleUsState.findMany({
            where: { cycleLastPeriodStart: { not: null } },
            select: {
                coupleId: true,
                cycleLastPeriodStart: true,
                cyclePeriodLength: true,
                cycleCycleLength: true,
                cycleUpdatedBy: true,
                cycleUpdatedByName: true,
                cycleUpdatedAt: true,
            },
        });
        if (!states.length)
            return;
        for (const st of states) {
            try {
                const coupleId = st.coupleId;
                const settings = {
                    lastPeriodStart: st.cycleLastPeriodStart,
                    periodLength: st.cyclePeriodLength ?? 5,
                    cycleLength: st.cycleCycleLength ?? 28,
                    updatedBy: st.cycleUpdatedBy ?? '',
                    updatedByName: st.cycleUpdatedByName ?? '',
                    updatedAt: st.cycleUpdatedAt?.toISOString() ?? '',
                };
                const day = cycleDayFor(dateStr, settings);
                const milestone = milestoneFor(day, settings);
                if (!milestone)
                    continue;
                // Send each milestone at most once per day per couple.
                const dedupeKey = `us:cycle_notif:${coupleId}:${dateStr}:${milestone}`;
                if (await (0, cache_1.cacheGet)(dedupeKey))
                    continue;
                await (0, cache_1.cacheSet)(dedupeKey, '1', 2 * 24 * 60 * 60);
                // Resolve the two partners — nudges go to the PRIMARY (boy) only.
                const users = await prisma_1.prisma.user.findMany({
                    where: { coupleId },
                    select: { id: true, name: true, role: true },
                });
                const primary = users.find(u => u.role === 'primary');
                const partner = users.find(u => u.role === 'partner');
                if (!primary || !partner)
                    continue;
                const girl = (partner.name || 'Your partner').split(/\s+/)[0];
                const boy = (primary.name || 'there').split(/\s+/)[0];
                const { title, body } = messagesFor(milestone, girl, boy);
                await prisma_1.prisma.notification.create({
                    data: {
                        recipientId: coupleId,
                        senderId: coupleId,
                        type: 'system',
                        title,
                        message: body,
                        data: {
                            subtype: 'us_cycle',
                            senderUserId: partner.id, // she never sees her own cycle nudges
                            navigate: 'UsSpace',
                            milestone,
                            ...(0, notif_1.i18nData)(`cycle.${milestone}`, { girl, boy }),
                        },
                        read: false,
                    },
                });
                await (0, cache_1.invalidateNotifUnreadCount)(coupleId);
                const io = global.io;
                if (io)
                    io.to(`couple:${coupleId}`).emit('notification:new', { type: 'us_cycle' });
                (0, push_service_1.pushToUser)(primary.id, {
                    title,
                    body,
                    data: { type: 'us_cycle', navigate: 'Notifications', milestone, ...(0, notif_1.i18nData)(`cycle.${milestone}`, { girl, boy }) },
                    collapseKey: 'us_cycle',
                }).catch(() => null);
                logger_1.logger.info(`[CycleNotifier] sent ${milestone} nudge for couple ${coupleId} (day ${day})`);
            }
            catch (err) {
                logger_1.logger.warn(`[CycleNotifier] couple ${st.coupleId} failed: ${err.message}`);
            }
        }
    }
    catch (err) {
        logger_1.logger.warn(`[CycleNotifier] run failed: ${err.message}`);
    }
}
// Overlap guard: if a run is slow (large scan / DB latency) the next 30-min tick
// must not start a second concurrent pass (which would double-scan and risk
// duplicate pushes). Ticks that arrive while a run is in flight are skipped.
let _cycleRunning = false;
const guardedRun = async () => {
    if (_cycleRunning) {
        logger_1.logger.warn('[CycleNotifier] previous run still in progress — skipping this tick');
        return;
    }
    _cycleRunning = true;
    try {
        await runCheck();
    }
    finally {
        _cycleRunning = false;
    }
};
/** Start the notifier — immediate check on boot, then every 30 minutes. */
const startCycleNotifier = () => {
    setTimeout(() => guardedRun().catch(() => { }), 15000); // after sockets/db settle
    setInterval(() => guardedRun().catch(() => { }), 30 * 60 * 1000);
    logger_1.logger.info('🌸 Cycle notifier scheduled (every 30 min, 08–21 IST)');
};
exports.startCycleNotifier = startCycleNotifier;
//# sourceMappingURL=cycleNotifier.js.map