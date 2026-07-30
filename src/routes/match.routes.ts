import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { requireEntitlement } from '../middleware/requireEntitlement';
import { asyncHandler } from '../utils/asyncHandler';
import {
  getDiscoveryFeed,
  sayHello,
  skipCouple,
  getMatches,
  getInsights,
  validateMatchAction,
  refreshDiscovery,
  getIncomingRequests,
  acceptMatch,
  rejectMatch,
  blockCouple,
  unfriendCouple,
} from '../controllers/match.controller';

const router = Router();

router.use(authenticate);

// GET /api/v1/matches/discovery -> gets discovery feed
router.get('/discovery', asyncHandler(getDiscoveryFeed));

// POST /api/v1/matches/say-hello — counts toward the discovery quota
router.post(
  '/say-hello',
  validateMatchAction,
  requireEntitlement({ gate: 'connection' }),
  asyncHandler(sayHello),
);

// POST /api/v1/matches/skip — a skip ALSO counts toward the quota
router.post(
  '/skip',
  validateMatchAction,
  requireEntitlement({ gate: 'connection' }),
  asyncHandler(skipCouple),
);

// POST /api/v1/matches/refresh-discovery
router.post('/refresh-discovery', asyncHandler(refreshDiscovery));

// GET /api/v1/matches -> gets accepted connections
router.get('/', asyncHandler(getMatches));

// GET /api/v1/matches/incoming -> gets pending requests
router.get('/incoming', asyncHandler(getIncomingRequests));

// POST /api/v1/matches/accept -> accept a pending request
router.post('/accept', validateMatchAction, asyncHandler(acceptMatch));

// POST /api/v1/matches/reject -> reject a pending request
router.post('/reject', validateMatchAction, asyncHandler(rejectMatch));

// POST /api/v1/matches/block -> block a couple
router.post('/block', validateMatchAction, asyncHandler(blockCouple));

// POST /api/v1/matches/unfriend -> remove connection (can say-hello again to reconnect)
router.post('/unfriend', validateMatchAction, asyncHandler(unfriendCouple));

// GET /api/v1/matches/insights/:coupleId
router.get('/insights/:coupleId', asyncHandler(getInsights));

export default router;
