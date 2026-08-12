"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const prisma_1 = require("../lib/prisma");
const router = express_1.default.Router();
router.get('/active', async (req, res) => {
    try {
        const chatType = req.query.type;
        // Map chatType to category values:
        // 'group'   → category = 'group_prompt'
        // 'private' → category = 'chat_shortcut'
        // no type   → return all active (backwards compat)
        const categoryFilter = chatType === 'group' ? 'group_prompt' :
            chatType === 'private' ? 'chat_shortcut' :
                undefined;
        const prompts = await prisma_1.prisma.prompt.findMany({
            where: {
                isActive: true,
                ...(categoryFilter ? { category: categoryFilter } : {}),
            },
            select: { id: true, text: true, category: true }
        });
        const formatted = prompts.map(p => ({ ...p, _id: p.id }));
        res.status(200).json({ success: true, data: formatted });
    }
    catch (err) {
        console.error('[PROMPT ACTIVE ERROR]', err);
        res.status(500).json({ success: false, error: 'Failed to load prompts' });
    }
});
exports.default = router;
//# sourceMappingURL=prompt.routes.js.map