/**
 * Us Space routes — the couple's private shared space.
 *
 * Thin HTTP layer only (RULES §4): each handler validates request context,
 * calls `us.service`, and shapes the response. All DB/business logic + socket
 * emits live in `src/services/us.service.ts`. Response shapes and the `[UsRoutes]`
 * error copy are preserved byte-for-byte from the previous in-route
 * implementation (they are a contract with the mobile app, RULES §1) — which is
 * why the explicit per-handler try/catch stays instead of moving to asyncHandler
 * + the global error handler (that would change the 500 bodies the app sees).
 * Two list reads (`GET /planned-dates`, `GET /fridge-notes`) gained optional,
 * additive `?cursor=&limit=` cursor pagination; the `data` array stays where it
 * is and `nextCursor` is added as a sibling field (see CHANGELOG for the mobile
 * follow-up).
 */
import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/authenticate';
import { adminAuth } from '../middleware/adminAuth';
import { idempotency } from '../middleware/idempotency';
import { logger } from '../utils/logger';
import { sendSuccess } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils/AppError';
import { clampLimit } from '../utils/cursor';
import {
  saveMyFeeling,
  getPartnerFeeling,
  clearMyFeeling,
  adminClearFeeling,
  getMoodHistory,
  sendAskFeeling,
  savePlannedDate,
  getPlannedDates,
  deletePlannedDate,
  getFridgeNotes,
  createFridgeNote,
  ackFridgeNote,
  deleteFridgeNote,
  getCycle,
  saveCycle,
  getGamePoints,
  getActiveGame,
  MAX_FRIDGE_NOTES,
  PLANNED_DATES_DEFAULT_LIMIT,
} from '../services/us.service';

const router = Router();

/**
 * POST /api/v1/us/my-feeling
 * Saves the authenticated user's current mood to Redis so their partner can
 * fetch it after a fresh login (even if the socket was not connected).
 */
router.post('/my-feeling', authenticate, idempotency, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  const myUserId = req.user?.userId;
  if (!coupleId || !myUserId) {
    res.status(400).json({ success: false, error: 'Missing couple context' });
    return;
  }

  const { feeling, note, at } = req.body as { feeling?: string; note?: string; at?: string };
  if (!feeling) {
    res.status(400).json({ success: false, error: 'feeling is required' });
    return;
  }

  try {
    await saveMyFeeling({ coupleId, myUserId, feeling, note, at });
    res.json({ success: true });
  } catch (err: any) {
    logger.warn(`[UsRoutes] my-feeling POST error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to save feeling' });
  }
});

/**
 * GET /api/v1/us/partner-feeling
 * Returns the last mood the partner shared (stored in Redis), or null.
 */
router.get('/partner-feeling', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  const myUserId = req.user?.userId;
  if (!coupleId || !myUserId) {
    res.json({ success: true, data: null });
    return;
  }

  try {
    const feeling = await getPartnerFeeling(coupleId, myUserId);
    res.json({ success: true, data: feeling });
  } catch (err: any) {
    logger.warn(`[UsRoutes] partner-feeling GET error: ${err.message}`);
    res.json({ success: true, data: null });
  }
});

/**
 * GET /api/v1/us/mood-history
 * The couple's mood events from the last 30 days (both partners), newest first.
 */
router.get(
  '/mood-history',
  authenticate,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const coupleId = req.user?.coupleId;
    if (!coupleId) {
      sendSuccess({ res, data: [] });
      return;
    }
    const events = await getMoodHistory(coupleId);
    sendSuccess({ res, data: events });
  }),
);

/**
 * POST /api/v1/us/planned-dates
 * Add or update a planned date entry for the couple.
 * Body: { activity, date, rawDate, from?, time?, note? }
 */
router.post('/planned-dates', authenticate, idempotency, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  const myUserId = req.user?.userId;
  if (!coupleId) { res.status(400).json({ success: false, error: 'Missing couple context' }); return; }

  const { id, activity, date, rawDate, from, time, note } = req.body as Record<string, string>;
  if (!activity || !rawDate) { res.status(400).json({ success: false, error: 'activity and rawDate are required' }); return; }

  try {
    await savePlannedDate({ coupleId, myUserId, id, activity, date, rawDate, from, time, note });
    res.json({ success: true });
  } catch (err: any) {
    if (err instanceof AppError) { res.status(err.statusCode).json({ success: false, error: err.message }); return; }
    logger.warn(`[UsRoutes] planned-dates POST error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to save planned date' });
  }
});

/**
 * GET /api/v1/us/planned-dates?cursor=&limit=
 * The couple's planned dates (earliest rawDate first). Cursor-paginated + bounded
 * (default 100). Backward compatible: `data` stays the array; `nextCursor` is an
 * additive sibling (null when there is no further page).
 */
router.get('/planned-dates', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  if (!coupleId) { res.json({ success: true, data: [] }); return; }

  try {
    const limit = clampLimit(req.query.limit, PLANNED_DATES_DEFAULT_LIMIT);
    const { items, nextCursor } = await getPlannedDates({ coupleId, cursor: req.query.cursor, limit });
    res.json({ success: true, data: items, nextCursor });
  } catch (err: any) {
    logger.warn(`[UsRoutes] planned-dates GET error: ${err.message}`);
    res.json({ success: true, data: [] });
  }
});

/**
 * DELETE /api/v1/us/planned-dates/:id
 * Remove a single planned date by its unique id. Falls back to matching rawDate
 * so older clients (that delete by YYYY-MM-DD) keep working.
 */
router.delete('/planned-dates/:id', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  const { id } = req.params;
  if (!coupleId || !id) { res.status(400).json({ success: false }); return; }

  try {
    await deletePlannedDate(coupleId, id);
    res.json({ success: true });
  } catch (err: any) {
    logger.warn(`[UsRoutes] planned-dates DELETE error: ${err.message}`);
    res.status(500).json({ success: false });
  }
});

/**
 * DELETE /api/v1/us/my-feeling
 * Clears the authenticated user's feeling from Redis (for testing/reset).
 */
router.delete('/my-feeling', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  const myUserId = req.user?.userId;
  if (!coupleId || !myUserId) { res.status(400).json({ success: false, error: 'Missing couple context' }); return; }
  try {
    await clearMyFeeling(coupleId, myUserId);
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to clear feeling' });
  }
});

/**
 * POST /api/v1/us/ask-feeling
 * Sends a gentle "how are you feeling?" nudge to the partner — push + in-app
 * notification. Throttled to once per 30 minutes per sender.
 */
router.post('/ask-feeling', authenticate, idempotency, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  const myUserId = req.user?.userId;
  if (!coupleId || !myUserId) {
    res.status(400).json({ success: false, error: 'Missing couple context' });
    return;
  }

  try {
    await sendAskFeeling({ coupleId, myUserId });
    res.json({ success: true });
  } catch (err: any) {
    if (err instanceof AppError) { res.status(err.statusCode).json({ success: false, error: err.message }); return; }
    logger.warn(`[UsRoutes] ask-feeling POST error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to send' });
  }
});

/**
 * GET /api/v1/us/fridge-notes?cursor=&limit=
 * All sticky notes for the couple (newest first). The collection is hard-capped
 * at MAX_FRIDGE_NOTES on write, so the default page matches previous behaviour;
 * `cursor`/`limit` are additive. `data` stays the array; `nextCursor` sibling.
 */
router.get('/fridge-notes', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  if (!coupleId) { res.json({ success: true, data: [] }); return; }
  try {
    const limit = clampLimit(req.query.limit, MAX_FRIDGE_NOTES);
    const { items, nextCursor } = await getFridgeNotes({ coupleId, cursor: req.query.cursor, limit });
    res.json({ success: true, data: items, nextCursor });
  } catch (err: any) {
    logger.warn(`[UsRoutes] fridge-notes GET error: ${err.message}`);
    res.json({ success: true, data: [] });
  }
});

/**
 * POST /api/v1/us/fridge-notes
 * Create a sticky note. Body: { text, color }
 * Notifies the partner (push + in-app + socket).
 */
router.post('/fridge-notes', authenticate, idempotency, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  const myUserId = req.user?.userId;
  if (!coupleId || !myUserId) { res.status(400).json({ success: false, error: 'Missing couple context' }); return; }

  const { text, color } = req.body as { text?: string; color?: string };
  const trimmed = (text ?? '').trim();
  if (!trimmed) { res.status(400).json({ success: false, error: 'text is required' }); return; }
  if (trimmed.length > 200) { res.status(400).json({ success: false, error: 'Note too long (max 200 chars)' }); return; }

  try {
    const note = await createFridgeNote({ coupleId, myUserId, text: trimmed, color });
    res.json({ success: true, data: note });
  } catch (err: any) {
    logger.warn(`[UsRoutes] fridge-notes POST error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to save note' });
  }
});

/**
 * PATCH /api/v1/us/fridge-notes/:id/ack
 * Partner acknowledges a note (seen/done). Notifies the author.
 */
router.patch('/fridge-notes/:id/ack', authenticate, idempotency, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  const myUserId = req.user?.userId;
  const { id } = req.params;
  if (!coupleId || !myUserId || !id) { res.status(400).json({ success: false }); return; }

  try {
    const note = await ackFridgeNote({ coupleId, myUserId, id });
    res.json({ success: true, data: note });
  } catch (err: any) {
    if (err instanceof AppError) { res.status(err.statusCode).json({ success: false, error: err.message }); return; }
    logger.warn(`[UsRoutes] fridge-notes ACK error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to acknowledge' });
  }
});

/**
 * DELETE /api/v1/us/fridge-notes/:id
 * Remove a sticky note (either partner can erase).
 */
router.delete('/fridge-notes/:id', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  const { id } = req.params;
  if (!coupleId || !id) { res.status(400).json({ success: false }); return; }

  try {
    await deleteFridgeNote(coupleId, id);
    res.json({ success: true });
  } catch (err: any) {
    logger.warn(`[UsRoutes] fridge-notes DELETE error: ${err.message}`);
    res.status(500).json({ success: false });
  }
});

/**
 * GET /api/v1/us/cycle
 * Returns the couple's cycle settings, or null when not set up yet.
 */
router.get('/cycle', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  if (!coupleId) { res.json({ success: true, data: null }); return; }
  try {
    const data = await getCycle(coupleId);
    res.json({ success: true, data });
  } catch (err: any) {
    logger.warn(`[UsRoutes] cycle GET error: ${err.message}`);
    res.json({ success: true, data: null });
  }
});

/**
 * POST /api/v1/us/cycle
 * Saves cycle settings. Only the partner-role account may set them.
 * Notifies the primary partner that the cycle calendar was shared.
 */
router.post('/cycle', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  const myUserId = req.user?.userId;
  if (!coupleId || !myUserId) { res.status(400).json({ success: false, error: 'Missing couple context' }); return; }

  const { lastPeriodStart, periodLength, cycleLength } = req.body as {
    lastPeriodStart?: string; periodLength?: number; cycleLength?: number;
  };
  if (!lastPeriodStart || !/^\d{4}-\d{2}-\d{2}$/.test(lastPeriodStart)) {
    res.status(400).json({ success: false, error: 'lastPeriodStart (YYYY-MM-DD) is required' });
    return;
  }

  try {
    const settings = await saveCycle({ coupleId, myUserId, lastPeriodStart, periodLength, cycleLength });
    res.json({ success: true, data: settings });
  } catch (err: any) {
    if (err instanceof AppError) { res.status(err.statusCode).json({ success: false, error: err.message }); return; }
    logger.warn(`[UsRoutes] cycle POST error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to save cycle' });
  }
});

/**
 * GET /api/v1/us/game/points
 * Tic-Tac-Toe scoreboard for the couple:
 *   { points: { [userId]: wins }, streak: { userId, count } | null }
 */
router.get('/game/points', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  if (!coupleId) { res.json({ success: true, data: { points: {}, streak: null } }); return; }
  try {
    const data = await getGamePoints(coupleId);
    res.json({ success: true, data });
  } catch (err: any) {
    logger.warn(`[UsRoutes] game points GET error: ${err.message}`);
    res.json({ success: true, data: { points: {}, streak: null } });
  }
});

/**
 * GET /api/v1/us/game/active
 * The couple's current shared game session so a partner who left the screen (or
 * received a challenge push) can (re)join. Auto-expires sessions idle >3h.
 */
router.get('/game/active', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  if (!coupleId) { res.json({ success: true, data: { session: null } }); return; }
  try {
    const data = await getActiveGame(coupleId);
    res.json({ success: true, data });
  } catch (err: any) {
    logger.warn(`[UsRoutes] game active GET error: ${err.message}`);
    res.json({ success: true, data: { session: null } });
  }
});

/**
 * POST /api/v1/us/admin-clear-feeling
 * Admin-only: clears any user's feeling by coupleId + userId.
 * Protected by the admin JWT (adminAuth).
 */
router.post('/admin-clear-feeling', adminAuth, async (req: Request, res: Response): Promise<void> => {
  const { coupleId, userId } = req.body as { coupleId?: string; userId?: string };
  if (!coupleId || !userId) { res.status(400).json({ success: false, error: 'coupleId and userId required' }); return; }
  try {
    const deleted = await adminClearFeeling(coupleId, userId);
    res.json({ success: true, deleted });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to clear feeling' });
  }
});

export default router;
