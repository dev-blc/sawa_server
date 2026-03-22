import express from 'express';
import { prisma } from '../lib/prisma';

const router = express.Router();

router.get('/active', async (req, res) => {
    try {
        const prompts = await prisma.prompt.findMany({ 
            where: { isActive: true },
            select: { text: true, category: true }
        });
        res.status(200).json({ success: true, data: prompts });
    } catch (err: any) {
        res.status(500).json({ success: false, message: err.message });
    }
});

export default router;
