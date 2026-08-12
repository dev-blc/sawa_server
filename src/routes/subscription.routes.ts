import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  getMySubscription,
  startTrialHandler,
  verifyApple,
  appleNotifications,
  verifyGoogle,
  googleNotifications,
} from '../controllers/subscription.controller';

const router = Router();

// Authenticated — the app. asyncHandler forwards thrown errors to the global
// error handler; without it a throw (e.g. duplicate-receipt P2002, pool timeout,
// store error) would leave the request hanging → client retries → verify storms.
router.get('/me', authenticate, asyncHandler(getMySubscription));
router.post('/trial', authenticate, asyncHandler(startTrialHandler));
router.post('/apple/verify', authenticate, asyncHandler(verifyApple));
router.post('/google/verify', authenticate, asyncHandler(verifyGoogle));

// Public — the stores call these. Authenticity is guaranteed by re-verifying the
// purchase directly with Apple / Google (not by trusting the request body).
router.post('/apple/notifications', asyncHandler(appleNotifications));
router.post('/google/notifications', asyncHandler(googleNotifications));

export default router;
