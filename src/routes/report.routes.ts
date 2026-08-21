import express from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/authenticate';
import { communityService } from '../services/community.service';

const router = express.Router();

/** GET /reports/stats/:targetId — report + block counts for a couple (lightweight). */
router.get('/stats/:targetId', authenticate, async (req: any, res) => {
  try {
    const { targetId } = req.params;
    const [reportCount, blockCount] = await Promise.all([
      prisma.report.count({ where: { targetId } }),
      prisma.couple.count({ where: { blocked: { has: targetId } } }),
    ]);
    return res.json({ success: true, data: { reportCount, blockCount } });
  } catch (err: any) {
    console.error('[REPORT STATS ERROR]', err);
    return res.status(500).json({ success: false, error: 'Failed to load report stats' });
  }
});

router.post('/', authenticate, async (req: any, res) => {
    try {
        const { targetId, reason, details } = req.body;
        const reporterId = req.user.coupleId;

        if (!targetId || !reason) {
            return res.status(400).json({ success: false, error: 'Missing target or reason' });
        }

        const report = await prisma.report.create({
            data: {
                reporterId: reporterId,
                targetId: targetId,
                reason,
                details: details || '',
                status: 'pending'
            }
        });

        // 1. Add to blocked list in Couple — resolved to the CANONICAL coupleId
        // first: the raw client value could be a Mongo cuid, and the discovery
        // filter matches coupleId only, so an unresolved entry "blocked"
        // nothing. Only pushed if not already present so repeat reports can't
        // grow the array unbounded.
        const targetCouple = await prisma.couple.findFirst({
            where: { OR: [{ id: targetId }, { coupleId: targetId }] },
            select: { coupleId: true },
        });
        const blockValue = targetCouple?.coupleId ?? targetId;
        const reporter = await prisma.couple.findUnique({
            where: { coupleId: reporterId },
            select: { blocked: true },
        });
        if (reporter && !reporter.blocked.includes(blockValue)) {
            await prisma.couple.update({
                where: { coupleId: reporterId },
                data: { blocked: { push: blockValue } },
            });
        }

        // 2. If it's a community, leave it through the REAL pipeline. The raw
        // member-row delete skipped everything leaveCommunity does: a co-host
        // who reported kept their admin row (could still edit/approve/delete a
        // group they'd left), a sole member left a publicly-listed zombie, and
        // the list cache never invalidated.
        const isComm = await prisma.community.findUnique({ where: { id: targetId } });
        if (isComm) {
            const membership = await prisma.communityMember.findFirst({
                where: { communityId: targetId, coupleId: reporterId },
                select: { communityId: true },
            });
            if (membership) {
                await communityService.leaveCommunity(reporterId, targetId).catch((e) => {
                    console.error('[REPORT] leaveCommunity failed', e?.message);
                });
            }
        }

        res.status(201).json({ success: true, data: { ...report, _id: report.id } });
    } catch (err: any) {
        console.error('[REPORT ERROR]', err);
        res.status(500).json({ success: false, error: 'Failed to submit report' });
    }
});

export default router;
