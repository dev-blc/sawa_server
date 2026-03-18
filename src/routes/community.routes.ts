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

// POST /api/v1/communities/:id/leave
router.post('/:id/leave', asyncHandler(leaveCommunity));

export default router;
