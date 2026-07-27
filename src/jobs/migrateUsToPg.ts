import { prisma } from '../lib/prisma';
import { cacheGet, cacheSet } from '../lib/cache';
import { logger } from '../utils/logger';

/**
 * One-time backfill: Us-space data used to live only in Redis (fridge notes,
 * planned dates, tic-tac-toe scores/streak, cycle settings). It now lives in
 * Postgres. This copies any pre-existing Redis values into Postgres so nothing
 * is lost on the switch. Runs once (guarded by a Redis flag) on boot.
 *
 * Safe to keep in the codebase: it never overwrites Postgres rows that already
 * exist, and it no-ops after the first successful run.
 */
const MIGRATION_FLAG = 'us:pg_migrated:v1';

export async function migrateUsRedisToPostgres(): Promise<void> {
  try {
    if (await cacheGet(MIGRATION_FLAG)) return;

    const couples = await prisma.couple.findMany({ select: { coupleId: true } });
    let touched = 0;

    for (const { coupleId } of couples) {
      // ── Fridge notes ──────────────────────────────────────────────
      try {
        const raw = await cacheGet(`us:fridge_notes:${coupleId}`);
        const notes = raw ? JSON.parse(raw) : [];
        if (Array.isArray(notes) && notes.length) {
          const existing = await prisma.fridgeNote.count({ where: { coupleId } });
          if (existing === 0) {
            for (const n of notes) {
              await prisma.fridgeNote.create({
                data: {
                  id: n.id,
                  coupleId,
                  text: String(n.text ?? ''),
                  color: n.color || 'yellow',
                  byName: n.by || 'Partner',
                  byUserId: n.byUserId || '',
                  ackBy: n.ackBy || null,
                  ackAt: n.ackAt ? new Date(n.ackAt) : null,
                  createdAt: n.at ? new Date(n.at) : new Date(),
                },
              }).catch(() => null);
            }
            touched++;
          }
        }
      } catch { /* ignore per-couple */ }

      // ── Planned dates ─────────────────────────────────────────────
      try {
        const raw = await cacheGet(`us:planned_dates:${coupleId}`);
        const plans = raw ? JSON.parse(raw) : [];
        if (Array.isArray(plans) && plans.length) {
          const existing = await prisma.plannedDate.count({ where: { coupleId } });
          if (existing === 0) {
            for (const p of plans) {
              const entryId = p.id || `${p.rawDate}__${p.activity}__${p.time ?? ''}`;
              await prisma.plannedDate.create({
                data: {
                  id: entryId,
                  coupleId,
                  activity: String(p.activity ?? ''),
                  dateLabel: p.date ?? p.rawDate ?? null,
                  rawDate: String(p.rawDate ?? ''),
                  time: p.time || null,
                  note: p.note || null,
                  fromName: p.from || 'Your partner',
                },
              }).catch(() => null);
            }
            touched++;
          }
        }
      } catch { /* ignore per-couple */ }

      // ── Game points ───────────────────────────────────────────────
      try {
        const raw = await cacheGet(`us:game_points:${coupleId}`);
        const pts = raw ? JSON.parse(raw) : {};
        for (const [userId, wins] of Object.entries(pts)) {
          const existing = await prisma.usGameScore.findUnique({
            where: { coupleId_userId: { coupleId, userId } },
          });
          if (!existing) {
            await prisma.usGameScore.create({
              data: { coupleId, userId, wins: Number(wins) || 0 },
            }).catch(() => null);
            touched++;
          }
        }
      } catch { /* ignore per-couple */ }

      // ── Cycle + game streak → CoupleUsState ───────────────────────
      try {
        const [rawCycle, rawStreak] = await Promise.all([
          cacheGet(`us:cycle:${coupleId}`),
          cacheGet(`us:game_streak:${coupleId}`),
        ]);
        if (rawCycle || rawStreak) {
          const existing = await prisma.coupleUsState.findUnique({ where: { coupleId } });
          if (!existing) {
            const cycle = rawCycle ? JSON.parse(rawCycle) : null;
            const streak = rawStreak ? JSON.parse(rawStreak) : null;
            await prisma.coupleUsState.create({
              data: {
                coupleId,
                cycleLastPeriodStart: cycle?.lastPeriodStart ?? null,
                cyclePeriodLength: cycle?.periodLength ?? null,
                cycleCycleLength: cycle?.cycleLength ?? null,
                cycleUpdatedBy: cycle?.updatedBy ?? null,
                cycleUpdatedByName: cycle?.updatedByName ?? null,
                cycleUpdatedAt: cycle?.updatedAt ? new Date(cycle.updatedAt) : null,
                gameStreakUserId: streak?.userId ?? null,
                gameStreakCount: streak?.count ?? 0,
              },
            }).catch(() => null);
            touched++;
          }
        }
      } catch { /* ignore per-couple */ }
    }

    await cacheSet(MIGRATION_FLAG, '1', 10 * 365 * 24 * 60 * 60);
    logger.info(`[UsMigrate] Redis→Postgres backfill complete (${touched} rows/couples touched)`);
  } catch (err: any) {
    logger.warn(`[UsMigrate] backfill failed: ${err.message}`);
  }
}
