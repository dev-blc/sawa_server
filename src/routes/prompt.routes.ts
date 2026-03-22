import express from 'express';
import { Prompt } from '../models/Prompt.model';

const router = express.Router();

router.get('/active', async (req, res) => {
    try {
        const prompts = await Prompt.find({ isActive: true }).select('text category');
        res.status(200).json({ success: true, data: prompts });
    } catch (err: any) {
        res.status(500).json({ success: false, message: err.message });
    }
});

export default router;
