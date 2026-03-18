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
} from '../controllers/match.controller';

const router = Router();

router.use(authenticate);

// GET /api/v1/matches/discovery -> gets discovery feed
router.get('/discovery', asyncHandler(getDiscoveryFeed));

// POST /api/v1/matches/say-hello
router.post('/say-hello', validateMatchAction, asyncHandler(sayHello));

// POST /api/v1/matches/skip
router.post('/skip', validateMatchAction, asyncHandler(skipCouple));

// GET /api/v1/matches
router.get('/', asyncHandler(getMatches));

// GET /api/v1/matches/insights/:coupleId
router.get('/insights/:coupleId', asyncHandler(getInsights));

export default router;
