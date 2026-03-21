import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
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
} from '../controllers/match.controller';

const router = Router();

router.use(authenticate);

// GET /api/v1/matches/discovery -> gets discovery feed
router.get('/discovery', asyncHandler(getDiscoveryFeed));

// POST /api/v1/matches/say-hello
router.post('/say-hello', validateMatchAction, asyncHandler(sayHello));

// POST /api/v1/matches/skip
router.post('/skip', validateMatchAction, asyncHandler(skipCouple));

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

// GET /api/v1/matches/insights/:coupleId
router.get('/insights/:coupleId', asyncHandler(getInsights));

export default router;
