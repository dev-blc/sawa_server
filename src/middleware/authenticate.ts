import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, isAccessTokenDenied } from '../utils/jwt';
import { isAccessTokenRevoked } from '../services/tokenDenylist';
import { AppError } from '../utils/AppError';
import { prisma } from '../lib/prisma';

// `Request.user` / `Request.accessToken` augmentations live in
// src/types/express.d.ts (single source — adminAuth.ts still carries a legacy
// duplicate of `user` that must stay byte-identical, see the note there).

/**
 * In-memory cache to throttle expensive ban/activity DB work.
 *  - lastActiveAt is rewritten at most once every ACTIVITY_THROTTLE_MS per user
 *    (60s) so we don't hammer the DB on chatty endpoints.
 *  - Ban status is cached per coupleId for BAN_CACHE_MS (15s) so a single
 *    socket-spamming client doesn't re-query every request, but a freshly
 *    banned couple loses access within seconds.
 */
const ACTIVITY_THROTTLE_MS = 60_000;
const BAN_CACHE_MS = 15_000;
const lastActivityWriteAt = new Map<string, number>();
const banStatusCache = new Map<string, { bannedAt: Date | null; checkedAt: number }>();

/**
 * Both maps insert one entry per distinct user/couple and previously never
 * evicted — a slow, unbounded leak on a long-lived process. Before any insert
 * that would cross the cap, expired entries are swept; if every entry is still
 * live (cap-many active users in one throttle window), the oldest-inserted go
 * first. Map iteration order is insertion order, which makes that cheap.
 */
const MAX_CACHE_ENTRIES = 50_000;
const boundedSet = <V>(
  map: Map<string, V>,
  key: string,
  value: V,
  isExpired: (v: V) => boolean,
): void => {
  if (map.size >= MAX_CACHE_ENTRIES && !map.has(key)) {
    for (const [k, v] of map) {
      if (isExpired(v)) map.delete(k);
    }
    if (map.size >= MAX_CACHE_ENTRIES) {
      const overflow = map.size - MAX_CACHE_ENTRIES + 1;
      let dropped = 0;
      for (const k of map.keys()) {
        if (dropped++ >= overflow) break;
        map.delete(k);
      }
    }
  }
  map.set(key, value);
};

/**
 * Middleware: Validates JWT Bearer token, blocks banned couples, and
 * touches the user's lastActiveAt for the admin "Inactive" status logic.
 */
export const authenticate = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new AppError('Authorization header missing', 401, 'UNAUTHORIZED'));
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      return next(new AppError('Token missing', 401, 'UNAUTHORIZED'));
    }

    const payload = verifyAccessToken(token);

    // Revocation checks (H4), both Redis-backed and evaluated in parallel:
    //  - jti denylist: THIS specific token was revoked at logout.
    //  - per-user watermark (services/tokenDenylist.ts): every access token
    //    ISSUED BEFORE the user's last logout is dead — including older copies
    //    from before a refresh rotation whose jti was never presented, i.e.
    //    exactly the stolen-token case H4 is about.
    // Rejected even though the signature is valid and `exp` is in the future.
    // 401 → the mobile interceptor attempts a refresh; for a logged-out user
    // the refresh-token hash is already cleared, so it fails and logs out cleanly.
    const [jtiDenied, issuedBeforeLogout] = await Promise.all([
      isAccessTokenDenied(payload.jti),
      isAccessTokenRevoked(payload.userId, payload.iat),
    ]);
    if (jtiDenied || issuedBeforeLogout) {
      return next(new AppError('Session ended. Please sign in again.', 401, 'TOKEN_REVOKED'));
    }

    req.user = {
      userId: payload.userId,
      coupleId: payload.coupleId,
      coupleMongoId: payload.coupleMongoId,
    };
    // Verified token metadata, carried separately from `user` (three files
    // merge the `user` declaration — extending it breaks TS2717). The logout
    // handler uses jti/exp to denylist exactly the token presented to it.
    req.accessToken = { jti: payload.jti, exp: payload.exp };

    // ─── Ban + existence check (cached) ───────────────────────────────────
    if (payload.coupleId) {
      const cached = banStatusCache.get(payload.coupleId);
      const now = Date.now();
      let bannedAt: Date | null;
      let coupleFound: boolean;

      if (cached && now - cached.checkedAt < BAN_CACHE_MS) {
        bannedAt = cached.bannedAt;
        // coupleFound is stored alongside bannedAt; old cache entries without
        // this flag are treated as "found" to avoid spurious logouts on redeploy.
        coupleFound = (cached as any).coupleFound !== false;
      } else {
        const couple = await prisma.couple.findUnique({
          where: { coupleId: payload.coupleId },
          select: { bannedAt: true },
        });
        coupleFound = couple !== null;
        bannedAt = couple?.bannedAt ?? null;
        boundedSet(
          banStatusCache,
          payload.coupleId,
          {
            bannedAt,
            checkedAt: now,
            ...(({ coupleFound }) => ({ coupleFound }))({ coupleFound }),
          } as any,
          (v) => now - v.checkedAt >= BAN_CACHE_MS,
        );
      }

      // Couple was deleted — revoke the session so the mobile app logs out
      if (!coupleFound) {
        banStatusCache.delete(payload.coupleId);
        return next(new AppError('Account no longer exists.', 401, 'ACCOUNT_DELETED'));
      }

      if (bannedAt) {
        return next(
          new AppError(
            'This account has been suspended. Please contact support.',
            403,
            'ACCOUNT_BANNED',
          ),
        );
      }
    }

    // ─── Activity tracking (throttled write) ───────────────────────────────
    const lastWrite = lastActivityWriteAt.get(payload.userId) ?? 0;
    if (Date.now() - lastWrite > ACTIVITY_THROTTLE_MS) {
      const nowMs = Date.now();
      boundedSet(lastActivityWriteAt, payload.userId, nowMs, (t) => nowMs - t > ACTIVITY_THROTTLE_MS);
      // Fire-and-forget — don't block the request on this.
      prisma.user
        .update({
          where: { id: payload.userId },
          data: { lastActiveAt: new Date() },
        })
        .catch((err) => {
          console.warn(`[Auth] Failed to update lastActiveAt for ${payload.userId}: ${err.message}`);
        });
    }

    next();
  } catch (err: any) {
    console.error(`[Auth Error] Failed to authenticate: ${err.message}`);
    if (err instanceof AppError) {
      return next(err);
    }
    next(new AppError(err.message || 'Authentication failed', 401, 'UNAUTHORIZED'));
  }
};

/**
 * Invalidate the cached ban status for a couple.
 * Call this after admin ban/unban so the next API call sees the change immediately.
 */
export const invalidateBanCache = (coupleId: string): void => {
  banStatusCache.delete(coupleId);
};
