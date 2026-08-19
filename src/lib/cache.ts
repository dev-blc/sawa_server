/**
 * Thin Redis cache wrapper used for hot read paths (couple profile, discovery
 * feed, notification counts). Falls back gracefully to a plain in-process Map
 * when REDIS_URL is not configured, so nothing breaks in local dev without Redis.
 *
 * Design rules:
 *  • All TTLs are short (5-60 s) — we never sacrifice correctness for speed.
 *  • Every write path that mutates a cached value must call invalidate().
 *  • The cache is optional: if get() errors it returns null; set()/invalidate()
 *    swallow errors and log a warning.
 */

import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Single shared Redis client (same credentials as the socket adapter).
// ---------------------------------------------------------------------------
let _redis: Redis | null = null;

function getRedis(): Redis | null {
  if (_redis) return _redis;
  if (!env.REDIS_URL) return null;
  try {
    _redis = new Redis(env.REDIS_URL!, { maxRetriesPerRequest: 1, lazyConnect: true });
    _redis.on('error', (err) => logger.warn('[cache] Redis error:', err.message));
    return _redis;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-process fallback Map (used when Redis is not available).
// ---------------------------------------------------------------------------
const _localCache = new Map<string, { value: string; expiresAt: number }>();

// Hard cap on the fallback map. Without this, a prolonged Redis outage (every
// set() falls through to here) would grow the heap without bound. Map preserves
// insertion order, so the "oldest key" is a cheap FIFO eviction victim.
const LOCAL_CACHE_MAX = 10_000;

function localGet(key: string): string | null {
  const entry = _localCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _localCache.delete(key);
    return null;
  }
  return entry.value;
}
function localSet(key: string, value: string, ttlSeconds: number) {
  // Bound the map: when full and inserting a new key, first sweep expired
  // entries, then FIFO-evict the oldest if still at capacity.
  if (_localCache.size >= LOCAL_CACHE_MAX && !_localCache.has(key)) {
    const now = Date.now();
    for (const [k, v] of _localCache) {
      if (v.expiresAt <= now) _localCache.delete(k);
    }
    if (_localCache.size >= LOCAL_CACHE_MAX) {
      const oldest = _localCache.keys().next().value;
      if (oldest !== undefined) _localCache.delete(oldest);
    }
  }
  _localCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}
function localDel(key: string) {
  _localCache.delete(key);
}
function localDelPattern(pattern: string) {
  // Simple prefix-match for the fallback (not a full glob).
  const prefix = pattern.replace(/\*/g, '');
  for (const k of _localCache.keys()) {
    if (k.startsWith(prefix)) _localCache.delete(k);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function cacheGet(key: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return localGet(key);
  try {
    return await redis.get(key);
  } catch (err: any) {
    logger.warn(`[cache] get(${key}) failed:`, err?.message);
    return localGet(key);
  }
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  const redis = getRedis();
  if (!redis) { localSet(key, value, ttlSeconds); return; }
  try {
    await redis.set(key, value, 'EX', ttlSeconds);
  } catch (err: any) {
    logger.warn(`[cache] set(${key}) failed:`, err?.message);
    localSet(key, value, ttlSeconds);
  }
}

/**
 * Atomic counter with a TTL set on first increment — the primitive behind the
 * Redis-backed rate-limit store (per-IP counters shared across PM2 workers).
 * Returns null when Redis is unavailable so callers can fall back explicitly;
 * the local Map is NOT used here because a non-atomic fallback would just
 * recreate the per-process-counter problem this exists to solve.
 */
export async function cacheIncrExpire(
  key: string,
  ttlSeconds: number,
): Promise<{ count: number; ttlMs: number } | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const result = await redis.multi().incr(key).pttl(key).exec();
    if (!result) return null;
    const count = Number(result[0][1]);
    let ttlMs = Number(result[1][1]);
    if (ttlMs < 0) {
      // First hit in this window (or a key that lost its TTL): start the window.
      ttlMs = ttlSeconds * 1000;
      await redis.pexpire(key, ttlMs);
    }
    return { count, ttlMs };
  } catch (err: any) {
    logger.warn(`[cache] incr(${key}) failed:`, err?.message);
    return null;
  }
}

/**
 * Set a key only if it does not exist (SET NX EX) — returns true when THIS call
 * created the key. Used as a once-per-window flag (e.g. the abuse guard's
 * first-trip-of-the-day alert). Falls back to the local map when Redis is
 * unavailable: the flag then dedupes per process instead of per cluster, which
 * for alerting means "at most one per worker" rather than silence.
 */
export async function cacheSetNX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    if (localGet(key) !== null) return false;
    localSet(key, value, ttlSeconds);
    return true;
  }
  try {
    const res = await redis.set(key, value, 'EX', ttlSeconds, 'NX');
    return res === 'OK';
  } catch (err: any) {
    logger.warn(`[cache] setnx(${key}) failed:`, err?.message);
    if (localGet(key) !== null) return false;
    localSet(key, value, ttlSeconds);
    return true;
  }
}

export async function cacheInvalidate(key: string): Promise<void> {
  const redis = getRedis();
  if (!redis) { localDel(key); return; }
  try { await redis.del(key); } catch { localDel(key); }
}

/**
 * Best-effort Redis liveness probe for the /health endpoint.
 * Returns 'ok' when a PING succeeds, 'down' when Redis is configured but
 * unreachable, and 'disabled' when no REDIS_URL is set (local dev).
 */
export async function cachePing(): Promise<'ok' | 'down' | 'disabled'> {
  const redis = getRedis();
  if (!redis) return 'disabled';
  try {
    await redis.ping();
    return 'ok';
  } catch {
    return 'down';
  }
}

export async function cacheInvalidatePattern(pattern: string): Promise<void> {
  const redis = getRedis();
  if (!redis) { localDelPattern(pattern); return; }
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  } catch { localDelPattern(pattern); }
}

// ---------------------------------------------------------------------------
// Typed helpers for common hot paths.
// ---------------------------------------------------------------------------

export const CACHE_KEYS = {
  coupleProfile: (coupleId: string) => `sawa:couple:profile:${coupleId}`,
  notifUnreadCount: (coupleId: string) => `sawa:notif:unread:${coupleId}`,
};

const TTL = {
  coupleProfile: 60,        // 60 s — mutated only by profile update endpoints
  notifUnreadCount: 10,     // 10 s — incremented by new notifications
};

export async function getCachedCoupleProfile(coupleId: string): Promise<any | null> {
  const raw = await cacheGet(CACHE_KEYS.coupleProfile(coupleId));
  return raw ? JSON.parse(raw) : null;
}

export async function setCachedCoupleProfile(coupleId: string, data: any): Promise<void> {
  await cacheSet(CACHE_KEYS.coupleProfile(coupleId), JSON.stringify(data), TTL.coupleProfile);
}

export async function invalidateCoupleProfile(coupleId: string): Promise<void> {
  await cacheInvalidate(CACHE_KEYS.coupleProfile(coupleId));
}

export async function getCachedNotifUnreadCount(coupleId: string): Promise<number | null> {
  const raw = await cacheGet(CACHE_KEYS.notifUnreadCount(coupleId));
  return raw !== null ? Number(raw) : null;
}

export async function setCachedNotifUnreadCount(coupleId: string, count: number): Promise<void> {
  await cacheSet(CACHE_KEYS.notifUnreadCount(coupleId), String(count), TTL.notifUnreadCount);
}

export async function invalidateNotifUnreadCount(coupleId: string): Promise<void> {
  await cacheInvalidate(CACHE_KEYS.notifUnreadCount(coupleId));
}
