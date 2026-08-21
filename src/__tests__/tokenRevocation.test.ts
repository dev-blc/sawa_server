import jwt from 'jsonwebtoken';
import { signAccessToken, denylistAccessToken, isAccessTokenDenied } from '../utils/jwt';
import {
  parseDurationSeconds,
  revokeUserAccessTokens,
  isAccessTokenRevoked,
} from '../services/tokenDenylist';

// These exercise the REAL lib/cache: with no REDIS_URL in the test env it uses
// the in-process fallback map — the same code path a single-instance deploy
// runs — so the denylist round-trips end to end without a live Redis. Keys are
// uniquified per test so nothing bleeds across cases.

describe('access-token jti denylist (utils/jwt.ts, H4)', () => {
  it('signAccessToken stamps a unique jti and type=access', () => {
    const a = jwt.decode(signAccessToken({ userId: 'u1' })) as Record<string, unknown>;
    const b = jwt.decode(signAccessToken({ userId: 'u1' })) as Record<string, unknown>;
    expect(a.type).toBe('access');
    expect(typeof a.jti).toBe('string');
    expect((a.jti as string).length).toBeGreaterThan(10);
    expect(a.jti).not.toBe(b.jti); // distinct per token
  });

  it('a denylisted jti reads back as denied; unknown / undefined jtis do not', async () => {
    const jti = `jti-${Date.now()}`;
    expect(await isAccessTokenDenied(jti)).toBe(false);
    await denylistAccessToken(jti, Math.floor(Date.now() / 1000) + 3600);
    expect(await isAccessTokenDenied(jti)).toBe(true);
    expect(await isAccessTokenDenied('never-denied')).toBe(false);
    expect(await isAccessTokenDenied(undefined)).toBe(false);
  });

  it('a jti whose exp is already past is not stored (nothing left to revoke)', async () => {
    const jti = `expired-${Date.now()}`;
    await denylistAccessToken(jti, Math.floor(Date.now() / 1000) - 10);
    expect(await isAccessTokenDenied(jti)).toBe(false);
  });
});

describe('per-user revocation watermark (services/tokenDenylist.ts, H4)', () => {
  it('parseDurationSeconds handles d/h/m/s and falls back on junk', () => {
    expect(parseDurationSeconds('7d', 1)).toBe(7 * 86400);
    expect(parseDurationSeconds('1h', 1)).toBe(3600);
    expect(parseDurationSeconds('30m', 1)).toBe(1800);
    expect(parseDurationSeconds('45s', 1)).toBe(45);
    expect(parseDurationSeconds('not-a-duration', 99)).toBe(99);
  });

  it('revokes tokens issued BEFORE logout, keeps tokens issued AFTER', async () => {
    const userId = `user-${Date.now()}`;
    const beforeIat = Math.floor(Date.now() / 1000) - 10;
    expect(await isAccessTokenRevoked(userId, beforeIat)).toBe(false); // no watermark yet
    await revokeUserAccessTokens(userId);
    expect(await isAccessTokenRevoked(userId, beforeIat)).toBe(true); // older token dead
    const afterIat = Math.floor(Date.now() / 1000) + 5;
    expect(await isAccessTokenRevoked(userId, afterIat)).toBe(false); // fresh login survives
  });

  it('a token with no iat is treated as revoked once a watermark exists', async () => {
    const userId = `user2-${Date.now()}`;
    await revokeUserAccessTokens(userId);
    expect(await isAccessTokenRevoked(userId, undefined)).toBe(true);
  });
});
