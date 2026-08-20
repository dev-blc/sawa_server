import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  getNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  clearOne,
  clearAll,
  validateNotificationIdParams,
} from '../controllers/notification.controller';

const router = Router();

router.use(authenticate);

// GET /api/v1/notifications
router.get('/', asyncHandler(getNotifications));

// GET /api/v1/notifications/unread-count
router.get('/unread-count', asyncHandler(getUnreadCount));

// PATCH /api/v1/notifications/read-all  — mark every unread notification as read in one call
router.patch('/read-all', asyncHandler(markAllAsRead));

// PATCH /api/v1/notifications/:id/read
router.patch('/:id/read', validateNotificationIdParams, asyncHandler(markAsRead));

// DELETE /api/v1/notifications — soft-clear every visible notification
router.delete('/', asyncHandler(clearAll));

// DELETE /api/v1/notifications/:id — soft-clear one notification (idempotent)
router.delete('/:id', validateNotificationIdParams, asyncHandler(clearOne));

export default router;
