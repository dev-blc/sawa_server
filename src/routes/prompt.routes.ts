import express from 'express';
import { prisma } from '../lib/prisma';

const router = express.Router();

router.get('/active', async (req, res) => {
    try {
        const chatType = req.query.type as string | undefined;
        // Map chatType to category values:
        // 'group'   → category = 'group_prompt'
        // 'private' → category = 'chat_shortcut'
        // no type   → return all active (backwards compat)
        const categoryFilter =
            chatType === 'group' ? 'group_prompt' :
            chatType === 'private' ? 'chat_shortcut' :
            undefined;

        const prompts = await prisma.prompt.findMany({ 
            where: {
                isActive: true,
                ...(categoryFilter ? { category: categoryFilter } : {}),
            },
            select: { id: true, text: true, category: true }
        });
        const formatted = prompts.map(p => ({ ...p, _id: p.id }));
        res.status(200).json({ success: true, data: formatted });
    } catch (err: any) {
        console.error('[PROMPT ACTIVE ERROR]', err);
        res.status(500).json({ success: false, error: 'Failed to load prompts' });
    }
});

export default router;
