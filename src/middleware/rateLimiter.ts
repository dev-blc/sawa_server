import rateLimit, { type Options, type Store, type IncrementResponse } from 'express-rate-limit';
import { env } from '../config/env';
import { cacheIncrExpire, cacheInvalidate } from '../lib/cache';

/**
 * Shared-store rate limiting.
 *
 * The default MemoryStore counts per process — under PM2 cluster mode
 * (ecosystem.config.js runs WEB_CONCURRENCY workers when Redis is configured)
 * each worker held its own counter, so the real per-IP limit was N× the
 * configured one. When REDIS_URL is set, counters live in Redis and are
 * shared across workers; without Redis the app runs a single instance
 * (ecosystem.config.js pins instances=1), so MemoryStore is then correct.
 *
 * Failure mode: if Redis errors mid-request the store counts that hit as the
 * first in a fresh window (fail-open per request) — availability over
 * precision for a rate limiter guarding auth UX.
 */
class RedisRateLimitStore implements Store {
  localKeys = false;
  private keyPrefix: string;
  private windowMs = 15 * 60 * 1000;

  constructor(prefix: string) {
    this.keyPrefix = prefix;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const res = await cacheIncrExpire(this.keyPrefix + key, Math.ceil(this.windowMs / 1000));
    if (!res) {
      return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
    }
    return { totalHits: res.count, resetTime: new Date(Date.now() + res.ttlMs) };
  }

  async decrement(_key: string): Promise<void> {
    // Only used by skipSuccessfulRequests/skipFailedRequests — not configured
    // on any limiter here, so a no-op keeps the store simple.
  }

  async resetKey(key: string): Promise<void> {
    await cacheInvalidate(this.keyPrefix + key);
  }
}

const sharedStore = (prefix: string) =>
  env.REDIS_URL ? { store: new RedisRateLimitStore(prefix) } : {};

/**
 * Auth route rate limiter.
 * Default: 10 requests per 15 minutes per IP.
 */
export const authRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests. Please try again later.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  ...sharedStore('rl:auth:'),
});

/**
 * General API rate limiter (more lenient).
 * 200 requests per 15 minutes per IP.
 */
export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests. Please try again later.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  ...sharedStore('rl:api:'),
});
