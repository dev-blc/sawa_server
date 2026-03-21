import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  setupProfile,
  uploadPhotos,
  submitAnswers,
  getMyCouple,
  createCouple,
  updateMyCouple,
  invitePartner,
  validateSetupProfile,
  validateUploadPhotos,
  validateSubmitAnswers,
  validateCompleteOnboarding,
  validateUpdateMyCouple,
  completeOnboarding,
  getCoupleById,
  subscribe,
  deleteMyAccount,
  getBlockList,
  blockCouple,
  unblockCouple,
} from '../controllers/couple.controller';

const router = Router();

router.use(authenticate);

// GET /api/v1/couples/me
router.get('/me', asyncHandler(getMyCouple));

// GET /api/v1/couples/:id
router.get('/:id', asyncHandler(getCoupleById));

// POST /api/v1/couples/onboarding/profile
router.post('/onboarding/profile', validateSetupProfile, asyncHandler(setupProfile));

// POST /api/v1/couples/onboarding/photos
router.post('/onboarding/photos', validateUploadPhotos, asyncHandler(uploadPhotos));

// POST /api/v1/couples/onboarding/answers
router.post('/onboarding/answers', validateSubmitAnswers, asyncHandler(submitAnswers));

// POST /api/v1/couples/onboarding/complete
router.post('/onboarding/complete', validateCompleteOnboarding, asyncHandler(completeOnboarding));

// POST /api/v1/couples (legacy)
router.post('/', asyncHandler(createCouple));

// PATCH /api/v1/couples/me
router.patch('/me', validateUpdateMyCouple, asyncHandler(updateMyCouple));

// PUT /api/v1/couples/me (alias for PATCH)
router.put('/me', validateUpdateMyCouple, asyncHandler(updateMyCouple));

// POST /api/v1/couples/me/invite
router.post('/me/invite', asyncHandler(invitePartner));

// POST /api/v1/couples/subscribe
router.post('/subscribe', asyncHandler(subscribe));

// DELETE /api/v1/couples/me
router.delete('/me', asyncHandler(deleteMyAccount));

// Block management
router.get('/blocks', asyncHandler(getBlockList));
router.post('/blocks', asyncHandler(blockCouple));
router.delete('/blocks', asyncHandler(unblockCouple));

export default router;
