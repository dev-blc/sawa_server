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

export async function cacheInvalidate(key: string): Promise<void> {
  const redis = getRedis();
  if (!redis) { localDel(key); return; }
  try { await redis.del(key); } catch { localDel(key); }
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
