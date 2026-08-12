"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const prisma_1 = require("../lib/prisma");
const authenticate_1 = require("../middleware/authenticate");
const router = express_1.default.Router();
/** GET /reports/stats/:targetId — report + block counts for a couple (lightweight). */
router.get('/stats/:targetId', authenticate_1.authenticate, async (req, res) => {
    try {
        const { targetId } = req.params;
        const [reportCount, blockCount] = await Promise.all([
            prisma_1.prisma.report.count({ where: { targetId } }),
            prisma_1.prisma.couple.count({ where: { blocked: { has: targetId } } }),
        ]);
        return res.json({ success: true, data: { reportCount, blockCount } });
    }
    catch (err) {
        console.error('[REPORT STATS ERROR]', err);
        return res.status(500).json({ success: false, error: 'Failed to load report stats' });
    }
});
router.post('/', authenticate_1.authenticate, async (req, res) => {
    try {
        const { targetId, reason, details } = req.body;
        const reporterId = req.user.coupleId;
        if (!targetId || !reason) {
            return res.status(400).json({ success: false, error: 'Missing target or reason' });
        }
        const report = await prisma_1.prisma.report.create({
            data: {
                reporterId: reporterId,
                targetId: targetId,
                reason,
                details: details || '',
                status: 'pending'
            }
        });
        // 1. Add to blocked list in Couple — only if not already present, so the
        // array can't grow unbounded with duplicate entries on repeat reports.
        const reporter = await prisma_1.prisma.couple.findUnique({
            where: { coupleId: reporterId },
            select: { blocked: true },
        });
        if (reporter && !reporter.blocked.includes(targetId)) {
            await prisma_1.prisma.couple.update({
                where: { coupleId: reporterId },
                data: { blocked: { push: targetId } },
            });
        }
        // 2. If it's a community, leave it automatically
        const isComm = await prisma_1.prisma.community.findUnique({ where: { id: targetId } });
        if (isComm) {
            await prisma_1.prisma.communityMember.deleteMany({
                where: {
                    communityId: targetId,
                    coupleId: reporterId
                }
            });
        }
        res.status(201).json({ success: true, data: { ...report, _id: report.id } });
    }
    catch (err) {
        console.error('[REPORT ERROR]', err);
        res.status(500).json({ success: false, error: 'Failed to submit report' });
    }
});
exports.default = router;
//# sourceMappingURL=report.routes.js.map