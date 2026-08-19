import jwt, { SignOptions } from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../config/env';
import { AppError } from './AppError';
import { cacheGet, cacheSet } from '../lib/cache';

export interface JwtPayload {
  userId: string;
  coupleMongoId?: string; // MongoDB _id of the Couple document (High performance)
  coupleId?: string;      // shared couple entity ID (UUID)
  type: 'access' | 'refresh';
  /** Unique per-token id stamped on every ACCESS token (jwtid). The key the
   *  logout denylist revokes by — see denylistAccessToken/isAccessTokenDenied. */
  jti?: string;
  /** Stamped by jsonwebtoken at sign time (epoch seconds) — never set manually.
   *  `exp` bounds how long a revoked jti needs to sit on the denylist. */
  iat?: number;
  exp?: number;
}

/** What callers provide — the registered claims are the library's to stamp. */
type SignablePayload = Omit<JwtPayload, 'type' | 'jti' | 'iat' | 'exp'>;

// Pin the signing/verification algorithm so a forged token that sets
// `"alg":"none"` (or asymmetric-key confusion) can never be accepted.
const JWT_ALG = 'HS256' as const;

export const signAccessToken = (payload: SignablePayload): string => {
  return jwt.sign(
    { ...payload, type: 'access' },
    env.JWT_ACCESS_SECRET,
    // jwtid stamps a unique `jti` claim on every access token so one specific
    // token can be revoked (logout → denylist by jti). Denylist entries live at
    // most JWT_ACCESS_EXPIRES_IN (env default 7d) and only logouts create them,
    // so the set stays tiny.
    { expiresIn: env.JWT_ACCESS_EXPIRES_IN, algorithm: JWT_ALG, jwtid: crypto.randomUUID() } as SignOptions,
  );
};

export const signRefreshToken = (payload: SignablePayload): string => {
  return jwt.sign(
    { ...payload, type: 'refresh' },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES_IN, algorithm: JWT_ALG } as SignOptions,
  );
};

export const verifyAccessToken = (token: string): JwtPayload => {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: [JWT_ALG],
    }) as JwtPayload;
    // Reject a refresh token presented where an access token is expected.
    if (payload.type !== 'access') {
      throw new AppError('Invalid or expired access token', 401, 'INVALID_TOKEN');
    }
    return payload;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('Invalid or expired access token', 401, 'INVALID_TOKEN');
  }
};

export const verifyRefreshToken = (token: string): JwtPayload => {
  try {
    const payload = jwt.verify(token, env.JWT_REFRESH_SECRET, {
      algorithms: [JWT_ALG],
    }) as JwtPayload;
    if (payload.type !== 'refresh') {
      throw new AppError('Invalid or expired refresh token', 401, 'INVALID_REFRESH_TOKEN');
    }
    return payload;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('Invalid or expired refresh token', 401, 'INVALID_REFRESH_TOKEN');
  }
};

// ─── Access-token revocation denylist (H4) ────────────────────────────────────
// A stateless JWT is valid until it expires; logout could only drop the refresh
// token, leaving the access token live for its full lifetime. This denylist lets
// logout kill a specific access token immediately: its `jti` is stored in Redis
// (shared across workers; in-process fallback via cache.ts) with a TTL equal to
// the token's own remaining lifetime, so entries self-expire exactly when the
// token would have died anyway and the set never grows unbounded.
//
// Fail-open by design: cacheGet returns null on a Redis outage, so a revoked
// token is briefly honored during an outage rather than logging out every user.
// The exposure is bounded — logout also clears the refresh-token hash (so a
// leaked access token can't be refreshed) and the per-user watermark in
// services/tokenDenylist.ts backstops this per-token deny.
const denylistKey = (jti: string): string => `jwt:denylist:${jti}`;

// Deny for the full configured access lifetime when `exp` is somehow absent
// (jsonwebtoken always stamps it, so this is a can't-under-protect fallback;
// env default '7d'). Cheap parse: only the d/h/m/s shapes env actually uses.
const ACCESS_LIFETIME_FALLBACK_SECONDS = ((): number => {
  const m = /^(\d+)\s*(s|m|h|d)$/i.exec(env.JWT_ACCESS_EXPIRES_IN.trim());
  if (!m) return 7 * 24 * 3600;
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase() as 's' | 'm' | 'h' | 'd'];
  return parseInt(m[1], 10) * mult || 7 * 24 * 3600;
})();

/** Revoke one access token by its jti until it would have expired anyway. */
export const denylistAccessToken = async (jti?: string, expEpochSeconds?: number): Promise<void> => {
  if (!jti) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const ttlSeconds = expEpochSeconds ? expEpochSeconds - nowSec : ACCESS_LIFETIME_FALLBACK_SECONDS;
  if (ttlSeconds <= 0) return; // already expired — nothing to revoke
  await cacheSet(denylistKey(jti), '1', ttlSeconds);
};

/** True if this access-token jti has been revoked (i.e. its owner logged out). */
export const isAccessTokenDenied = async (jti?: string): Promise<boolean> => {
  if (!jti) return false;
  const hit = await cacheGet(denylistKey(jti));
  return hit !== null;
};
