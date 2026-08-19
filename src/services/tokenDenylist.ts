/**
 * tokenDenylist — logout containment for long-lived access JWTs (audit H4).
 *
 * WHY: access tokens live `JWT_ACCESS_EXPIRES_IN` (env default 7d) and logout
 * previously only cleared the stored refresh-token hash — a stolen or leaked
 * ACCESS token stayed valid for up to a week after the user logged out.
 *
 * We deliberately do NOT shorten the access-token TTL: the admin panel signs
 * in with the same access tokens and has no refresh flow, so a short TTL
 * would silently log admins out mid-session (recorded in CHANGELOG.md).
 * Instead, logout writes a per-user revocation watermark (epoch seconds) to
 * Redis; the HTTP `authenticate` middleware and the Socket.io handshake
 * reject any access token whose `iat` predates that watermark. Tokens minted
 * by a later login carry a newer `iat` and pass — nothing to clear on login.
 *
 * The key's TTL equals the access-token lifetime (+ a skew margin): once it
 * expires, every pre-logout token has already expired by its own `exp`, so
 * the denylist is self-cleaning and stays one key per recently-logged-out
 * user rather than one per token.
 *
 * Failure mode: the check rides `lib/cache.ts`. With Redis down it degrades
 * to the per-process fallback map (enforced only on the worker that handled
 * the logout) — fail-open for availability, the same trade the rate limiter
 * makes, and bounded by the token's own `exp` in the worst case.
 */

import { env } from '../config/env';
import { logger } from '../utils/logger';
import { cacheGet, cacheSet } from '../lib/cache';

const denyKey = (userId: string): string => `auth:tokendeny:${userId}`;

const ACCESS_TTL_FALLBACK_SECONDS = 7 * 24 * 3600; // mirrors env default '7d'

/**
 * Parse a jsonwebtoken/ms-style duration ('7d', '12h', '30m', '45s', '1w')
 * into seconds. Exported for unit tests.
 *
 * A bare number ('900') is treated as SECONDS. Note the `ms` library that
 * jsonwebtoken uses reads a bare string number as milliseconds, so for that
 * (misconfigured) shape we deliberately OVERestimate the key TTL — the safe
 * direction: the watermark may outlive the tokens, never the reverse.
 */
export const parseDurationSeconds = (value: string, fallbackSeconds: number): number => {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|y)?$/i.exec(value.trim());
  if (!m) return fallbackSeconds;
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  const mult: Record<string, number> = {
    ms: 1 / 1000,
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
    w: 7 * 86400,
    y: 31557600, // 365.25d — matches the `ms` library
  };
  const seconds = Math.round(n * (mult[unit] ?? 1));
  return seconds > 0 ? seconds : fallbackSeconds;
};

const accessTtlSeconds = (): number =>
  parseDurationSeconds(env.JWT_ACCESS_EXPIRES_IN, ACCESS_TTL_FALLBACK_SECONDS);

/**
 * Revoke every access token issued to this user before now. Called on logout.
 */
export async function revokeUserAccessTokens(userId: string): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  // +60s margin so minor clock skew can't leave a still-valid token alive
  // past the watermark key's death.
  await cacheSet(denyKey(userId), String(nowSeconds), accessTtlSeconds() + 60);
}

/**
 * True when this user logged out AFTER the presented token was issued.
 * `iatSeconds` is the verified JWT's `iat` claim.
 *
 * `iat < watermark` (strict): a token minted in the same second as the logout
 * (i.e. an immediate re-login) stays valid — logout-then-login must not 401.
 */
export async function isAccessTokenRevoked(
  userId: string,
  iatSeconds?: number,
): Promise<boolean> {
  try {
    const raw = await cacheGet(denyKey(userId));
    if (raw === null) return false;
    const revokedAt = parseInt(raw, 10);
    if (!Number.isFinite(revokedAt)) return false;
    // jsonwebtoken always stamps `iat`; a token without one cannot prove it
    // postdates the logout, so treat it as revoked.
    if (typeof iatSeconds !== 'number') return true;
    return iatSeconds < revokedAt;
  } catch (err: unknown) {
    // cacheGet already swallows its own errors; this is belt-and-braces so a
    // revocation-check bug can never take authentication down with it.
    logger.warn(`[tokenDenylist] revocation check failed: ${(err as Error)?.message}`);
    return false;
  }
}
