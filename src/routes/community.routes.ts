import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  getAllCommunities,
  getMyCommunities,
  createCommunity,
  getCommunityDetail,
  joinCommunity,
  leaveCommunity,
  inviteToCommunity,
  deleteCommunity,
  validateCreateCommunity,
  validateJoinCommunity,
} from '../controllers/community.controller';

const router = Router();

router.use(authenticate);

// GET /api/v1/communities
router.get('/', asyncHandler(getAllCommunities));

// GET /api/v1/communities/mine
router.get('/mine', asyncHandler(getMyCommunities));

// POST /api/v1/communities
router.post('/', validateCreateCommunity, asyncHandler(createCommunity));

// GET /api/v1/communities/:id
router.get('/:id', asyncHandler(getCommunityDetail));

// POST /api/v1/communities/:id/join
router.post('/:id/join', validateJoinCommunity, asyncHandler(joinCommunity));

// POST /api/v1/communities/:id/invite
router.post('/:id/invite', asyncHandler(inviteToCommunity));

// POST /api/v1/communities/:id/leave
router.post('/:id/leave', asyncHandler(leaveCommunity));

// DELETE /api/v1/communities/:id
router.delete('/:id', asyncHandler(deleteCommunity));

export default router;
