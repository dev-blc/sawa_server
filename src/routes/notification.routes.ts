import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { asyncHandler } from '../utils/asyncHandler';
import { getNotifications, markAsRead } from '../controllers/notification.controller';

const router = Router();

router.use(authenticate);

// GET /api/v1/notifications
router.get('/', asyncHandler(getNotifications));

// PATCH /api/v1/notifications/:id/read
router.patch('/:id/read', asyncHandler(markAsRead));

export default router;
