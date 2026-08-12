"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CACHE_KEYS = void 0;
exports.cacheGet = cacheGet;
exports.cacheSet = cacheSet;
exports.cacheInvalidate = cacheInvalidate;
exports.cachePing = cachePing;
exports.cacheInvalidatePattern = cacheInvalidatePattern;
exports.getCachedCoupleProfile = getCachedCoupleProfile;
exports.setCachedCoupleProfile = setCachedCoupleProfile;
exports.invalidateCoupleProfile = invalidateCoupleProfile;
exports.getCachedNotifUnreadCount = getCachedNotifUnreadCount;
exports.setCachedNotifUnreadCount = setCachedNotifUnreadCount;
exports.invalidateNotifUnreadCount = invalidateNotifUnreadCount;
const ioredis_1 = __importDefault(require("ioredis"));
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
// ---------------------------------------------------------------------------
// Single shared Redis client (same credentials as the socket adapter).
// ---------------------------------------------------------------------------
let _redis = null;
function getRedis() {
    if (_redis)
        return _redis;
    if (!env_1.env.REDIS_URL)
        return null;
    try {
        _redis = new ioredis_1.default(env_1.env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
        _redis.on('error', (err) => logger_1.logger.warn('[cache] Redis error:', err.message));
        return _redis;
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// In-process fallback Map (used when Redis is not available).
// ---------------------------------------------------------------------------
const _localCache = new Map();
// Hard cap on the fallback map. Without this, a prolonged Redis outage (every
// set() falls through to here) would grow the heap without bound. Map preserves
// insertion order, so the "oldest key" is a cheap FIFO eviction victim.
const LOCAL_CACHE_MAX = 10000;
function localGet(key) {
    const entry = _localCache.get(key);
    if (!entry)
        return null;
    if (Date.now() > entry.expiresAt) {
        _localCache.delete(key);
        return null;
    }
    return entry.value;
}
function localSet(key, value, ttlSeconds) {
    // Bound the map: when full and inserting a new key, first sweep expired
    // entries, then FIFO-evict the oldest if still at capacity.
    if (_localCache.size >= LOCAL_CACHE_MAX && !_localCache.has(key)) {
        const now = Date.now();
        for (const [k, v] of _localCache) {
            if (v.expiresAt <= now)
                _localCache.delete(k);
        }
        if (_localCache.size >= LOCAL_CACHE_MAX) {
            const oldest = _localCache.keys().next().value;
            if (oldest !== undefined)
                _localCache.delete(oldest);
        }
    }
    _localCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}
function localDel(key) {
    _localCache.delete(key);
}
function localDelPattern(pattern) {
    // Simple prefix-match for the fallback (not a full glob).
    const prefix = pattern.replace(/\*/g, '');
    for (const k of _localCache.keys()) {
        if (k.startsWith(prefix))
            _localCache.delete(k);
    }
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
async function cacheGet(key) {
    const redis = getRedis();
    if (!redis)
        return localGet(key);
    try {
        return await redis.get(key);
    }
    catch (err) {
        logger_1.logger.warn(`[cache] get(${key}) failed:`, err?.message);
        return localGet(key);
    }
}
async function cacheSet(key, value, ttlSeconds) {
    const redis = getRedis();
    if (!redis) {
        localSet(key, value, ttlSeconds);
        return;
    }
    try {
        await redis.set(key, value, 'EX', ttlSeconds);
    }
    catch (err) {
        logger_1.logger.warn(`[cache] set(${key}) failed:`, err?.message);
        localSet(key, value, ttlSeconds);
    }
}
async function cacheInvalidate(key) {
    const redis = getRedis();
    if (!redis) {
        localDel(key);
        return;
    }
    try {
        await redis.del(key);
    }
    catch {
        localDel(key);
    }
}
/**
 * Best-effort Redis liveness probe for the /health endpoint.
 * Returns 'ok' when a PING succeeds, 'down' when Redis is configured but
 * unreachable, and 'disabled' when no REDIS_URL is set (local dev).
 */
async function cachePing() {
    const redis = getRedis();
    if (!redis)
        return 'disabled';
    try {
        await redis.ping();
        return 'ok';
    }
    catch {
        return 'down';
    }
}
async function cacheInvalidatePattern(pattern) {
    const redis = getRedis();
    if (!redis) {
        localDelPattern(pattern);
        return;
    }
    try {
        const keys = await redis.keys(pattern);
        if (keys.length > 0)
            await redis.del(...keys);
    }
    catch {
        localDelPattern(pattern);
    }
}
// ---------------------------------------------------------------------------
// Typed helpers for common hot paths.
// ---------------------------------------------------------------------------
exports.CACHE_KEYS = {
    coupleProfile: (coupleId) => `sawa:couple:profile:${coupleId}`,
    notifUnreadCount: (coupleId) => `sawa:notif:unread:${coupleId}`,
};
const TTL = {
    coupleProfile: 60, // 60 s — mutated only by profile update endpoints
    notifUnreadCount: 10, // 10 s — incremented by new notifications
};
async function getCachedCoupleProfile(coupleId) {
    const raw = await cacheGet(exports.CACHE_KEYS.coupleProfile(coupleId));
    return raw ? JSON.parse(raw) : null;
}
async function setCachedCoupleProfile(coupleId, data) {
    await cacheSet(exports.CACHE_KEYS.coupleProfile(coupleId), JSON.stringify(data), TTL.coupleProfile);
}
async function invalidateCoupleProfile(coupleId) {
    await cacheInvalidate(exports.CACHE_KEYS.coupleProfile(coupleId));
}
async function getCachedNotifUnreadCount(coupleId) {
    const raw = await cacheGet(exports.CACHE_KEYS.notifUnreadCount(coupleId));
    return raw !== null ? Number(raw) : null;
}
async function setCachedNotifUnreadCount(coupleId, count) {
    await cacheSet(exports.CACHE_KEYS.notifUnreadCount(coupleId), String(count), TTL.notifUnreadCount);
}
async function invalidateNotifUnreadCount(coupleId) {
    await cacheInvalidate(exports.CACHE_KEYS.notifUnreadCount(coupleId));
}
//# sourceMappingURL=cache.js.map