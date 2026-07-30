import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { requireEntitlement } from '../middleware/requireEntitlement';
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
  updateCommunity,
  getInviteableCouples,
  processJoinRequest,
  validateCreateCommunity,
  validateJoinCommunity,
} from '../controllers/community.controller';

const router = Router();

router.use(authenticate);

// GET /api/v1/communities
router.get('/', asyncHandler(getAllCommunities));

// GET /api/v1/communities/mine
router.get('/mine', asyncHandler(getMyCommunities));

// POST /api/v1/communities — creating a group requires Prime Plus
router.post(
  '/',
  validateCreateCommunity,
  requireEntitlement({ gate: 'createGroup', minTier: 'PRIME_PLUS' }),
  asyncHandler(createCommunity),
);

// GET /api/v1/communities/:id
router.get('/:id', asyncHandler(getCommunityDetail));

// POST /api/v1/communities/:id/join — counts toward the group-join quota
router.post(
  '/:id/join',
  validateJoinCommunity,
  requireEntitlement({ gate: 'joinGroup' }),
  asyncHandler(joinCommunity),
);

// POST /api/v1/communities/:id/invite
router.post('/:id/invite', asyncHandler(inviteToCommunity));

// POST /api/v1/communities/:id/leave
router.post('/:id/leave', asyncHandler(leaveCommunity));

// PATCH /api/v1/communities/:id  — admin only: edit name, bio, image
router.patch('/:id', asyncHandler(updateCommunity));

// DELETE /api/v1/communities/:id
router.delete('/:id', asyncHandler(deleteCommunity));

// POST /api/v1/communities/:id/requests/:requestId/:decision
router.post('/:id/requests/:requestId/:decision', asyncHandler(processJoinRequest));

// GET /api/v1/communities/:id/inviteable
router.get('/:id/inviteable', asyncHandler(getInviteableCouples));

export default router;
