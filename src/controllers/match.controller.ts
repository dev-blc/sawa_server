import { Request, Response } from 'express';
import { z } from 'zod';
import { matchService } from '../services/match.service';
import { sendSuccess } from '../utils/response';
import { validate } from '../middleware/validate';

// ─── Validation ─────────────────────────────────────────────────────────────

const MatchActionSchema = z.object({
  targetCoupleId: z.string().min(1, 'Target couple ID is required'),
});

export const validateMatchAction = validate(MatchActionSchema);

// ─── Controllers ────────────────────────────────────────────────────────────

/**
 * GET /api/v1/matches/discovery
 * Fetches the discovery feed of un-interacted couples for the requesting couple.
 */
export const getDiscoveryFeed = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  const { city } = req.query;
  
  const couples = await matchService.getDiscoveryFeed(coupleId!, city as string);
  
  sendSuccess({ res, statusCode: 200, data: { couples } });
};

/**
 * POST /api/v1/matches/say-hello
 * Send a hello/like to a couple.
 */
export const sayHello = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  const { targetCoupleId } = req.body as z.infer<typeof MatchActionSchema>;
  
  const result = await matchService.sayHello(coupleId!, targetCoupleId);
  
  sendSuccess({ res, statusCode: 200, message: 'Hello sent', data: result });
};

/**
 * POST /api/v1/matches/skip
 * Skip/pass on a couple so they don't appear in the feed again.
 */
export const skipCouple = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  const { targetCoupleId } = req.body as z.infer<typeof MatchActionSchema>;
  
  const result = await matchService.skipCouple(coupleId!, targetCoupleId);
  
  sendSuccess({ res, statusCode: 200, message: 'Profile skipped', data: result });
};

export const getMatches = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  const matches = await matchService.getMatches(coupleId!);
  sendSuccess({ res, statusCode: 200, data: { matches } });
};

export const refreshDiscovery = async (req: Request, res: Response): Promise<void> => {
   const { coupleId } = req.user!;
   await matchService.refreshDiscovery(coupleId!);
   sendSuccess({ res, statusCode: 200, message: 'Discovery feed reset successful' });
};

export const getInsights = async (_req: Request, _res: Response): Promise<void> => {
  // Returns insights comparing the logged in couple with a target couple
};
