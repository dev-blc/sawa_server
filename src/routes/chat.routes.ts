import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  getPrivateMessages,
  getGroupMessages,
  sendPrivateMessage,
  sendGroupMessage,
  getUnreadCounts,
  getGroupUnreadCounts,
  editMessage,
  deleteMessage,
  markChatRead,
} from '../controllers/chat.controller';

const router = Router();

router.use(authenticate);

// GET /api/v1/chats/unread-counts  (private chats)
router.get('/unread-counts', asyncHandler(getUnreadCounts));

// GET /api/v1/chats/group-unread-counts  (group / community chats)
router.get('/group-unread-counts', asyncHandler(getGroupUnreadCounts));

// GET /api/v1/chats/private/:matchId
router.get('/private/:matchId', asyncHandler(getPrivateMessages));

// POST /api/v1/chats/private/:matchId
router.post('/private/:matchId', asyncHandler(sendPrivateMessage));

// GET /api/v1/chats/group/:communityId
router.get('/group/:communityId', asyncHandler(getGroupMessages));

// POST /api/v1/chats/group/:communityId
router.post('/group/:communityId', asyncHandler(sendGroupMessage));

// PATCH /api/v1/chats/messages/:messageId  (edit a message)
router.patch('/messages/:messageId', asyncHandler(editMessage));

// DELETE /api/v1/chats/messages/:messageId?forEveryone=true|false
router.delete('/messages/:messageId', asyncHandler(deleteMessage));

// POST /api/v1/chats/:chatId/read  — mark all messages in a chat as read
router.post('/:chatId/read', asyncHandler(markChatRead));

export default router;
