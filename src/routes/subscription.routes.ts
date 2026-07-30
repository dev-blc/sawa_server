import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import {
  getMySubscription,
  startTrialHandler,
  verifyApple,
  appleNotifications,
} from '../controllers/subscription.controller';

const router = Router();

// Authenticated — the app.
router.get('/me', authenticate, getMySubscription);
router.post('/trial', authenticate, startTrialHandler);
router.post('/apple/verify', authenticate, verifyApple);

// Public — Apple calls this (payload is cryptographically signed & verified).
router.post('/apple/notifications', appleNotifications);

export default router;
