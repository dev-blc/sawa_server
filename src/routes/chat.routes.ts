import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  getPrivateMessages,
  getGroupMessages,
  sendPrivateMessage,
  sendGroupMessage,
  getUnreadCounts,
} from '../controllers/chat.controller';

const router = Router();

router.use(authenticate);

// GET /api/v1/chats/unread-counts
router.get('/unread-counts', asyncHandler(getUnreadCounts));

// GET /api/v1/chats/private/:matchId
router.get('/private/:matchId', asyncHandler(getPrivateMessages));

// POST /api/v1/chats/private/:matchId
router.post('/private/:matchId', asyncHandler(sendPrivateMessage));

// GET /api/v1/chats/group/:communityId
router.get('/group/:communityId', asyncHandler(getGroupMessages));

// POST /api/v1/chats/group/:communityId
router.post('/group/:communityId', asyncHandler(sendGroupMessage));

export default router;
