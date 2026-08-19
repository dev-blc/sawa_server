import { Request, Response, NextFunction } from 'express';
import { cacheGet, cacheSet, cacheSetNX } from '../lib/cache';
import { logger } from '../utils/logger';

// Idempotency for the couple's core writes. The mobile offline queue tags each
// queued mutation with an `Idempotency-Key` header and replays it on reconnect;
// this middleware makes that replay safe — a create can't double-apply because
// the first success is stored (per identity + key) and replayed verbatim.
//
// Requests without the header pass straight through (normal online writes are
// unaffected). The layer fails OPEN: any error here calls next(), never blocks
// a write. TTL matches the client's max offline-queue lifetime.
const IDEM_TTL_SECONDS = 24 * 60 * 60; // 24h
const HEADER = 'idempotency-key';
const LOCK_TTL_SECONDS = 60;

export function idempotency(req: Request, res: Response, next: NextFunction): void {
  const key = req.header(HEADER);
  if (!key || key.length > 200) {
    next();
    return;
  }
  const user = (req as { user?: { coupleId?: string; userId?: string } }).user;
  const scope = user?.coupleId || user?.userId || 'anon';
  const cacheKey = `idem:${scope}:${key}`;

  void (async () => {
    // Replay: a stored success for this key → return it verbatim.
    const stored = await cacheGet(cacheKey);
    if (stored) {
      try {
        const { status, body } = JSON.parse(stored) as { status: number; body: unknown };
        res.status(status).json(body);
        return;
      } catch {
        // Corrupt entry — fall through and re-process.
      }
    }

    // Claim the key so two concurrent identical requests don't both execute.
    const claimed = await cacheSetNX(`${cacheKey}:lock`, '1', LOCK_TTL_SECONDS);
    if (!claimed) {
      res.status(409).json({
        success: false,
        error: 'A matching request is already being processed.',
        code: 'IDEMPOTENT_IN_PROGRESS',
      });
      return;
    }

    // Capture the response so a successful write can be replayed later.
    const sendJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        void cacheSet(cacheKey, JSON.stringify({ status: res.statusCode, body }), IDEM_TTL_SECONDS).catch(
          (e) => logger.warn('[idempotency] store failed', { error: (e as Error).message }),
        );
      }
      return sendJson(body);
    };
    next();
  })().catch((e) => {
    logger.warn('[idempotency] middleware error', { error: (e as Error).message });
    next(); // fail-open
  });
}
