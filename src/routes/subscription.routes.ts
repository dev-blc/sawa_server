import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import {
  getMySubscription,
  startTrialHandler,
  verifyApple,
  appleNotifications,
  verifyGoogle,
  googleNotifications,
} from '../controllers/subscription.controller';

const router = Router();

// Authenticated — the app.
router.get('/me', authenticate, getMySubscription);
router.post('/trial', authenticate, startTrialHandler);
router.post('/apple/verify', authenticate, verifyApple);
router.post('/google/verify', authenticate, verifyGoogle);

// Public — the stores call these. Authenticity is guaranteed by re-verifying the
// purchase directly with Apple / Google (not by trusting the request body).
router.post('/apple/notifications', appleNotifications);
router.post('/google/notifications', googleNotifications);

export default router;
