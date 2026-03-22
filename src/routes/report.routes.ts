import express from 'express';
import { Report } from '../models/Report.model';
import { authenticate } from '../middleware/authenticate';

const router = express.Router();

router.post('/', authenticate, async (req: any, res) => {
    try {
        const { targetId, reason, details } = req.body;
        const reporterId = req.user.coupleId; // Or req.user.id depending on setup

        if (!targetId || !reason) {
            return res.status(400).json({ success: false, message: 'Missing target or reason' });
        }

        const report = await Report.create({
            reporter: reporterId,
            target: targetId,
            reason,
            details: details || '',
            status: 'pending'
        });

        res.status(201).json({ success: true, data: report });
    } catch (err: any) {
        res.status(500).json({ success: false, message: err.message });
    }
});

export default router;
