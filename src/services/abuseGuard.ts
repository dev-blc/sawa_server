/**
 * abuseGuard — layered anti-abuse checks for every outbound SMS.
 *
 * WHY: `/auth/send-otp` (TWO SMS per call), `/auth/login-send-otp`,
 * `/auth/resend-otp` and `/auth/invite-partner` are unauthenticated endpoints
 * that spend real Twilio money. Until now their only protection was the
 * per-IP burst limiter (10 requests / 15 min), which an IP-rotating attacker
 * walks straight past — the exact shape of a previous real SMS-pumping
 * incident. Every SMS send now passes ALL of these layers before Twilio is
 * called; each layer has its own Redis key + TTL (UTC-day buckets):
 *
 *   1. corridor — destination must match `SMS_ALLOWED_PREFIXES` (stateless;
 *      the app is India-market, and classic SMS pumping targets foreign
 *      premium-rate ranges)
 *   2. phone    — `SMS_PHONE_DAILY_CAP` per destination number per day
 *                 (the legit ceiling for retry pain)
 *   3. prefix   — `SMS_PREFIX_DAILY_CAP` per 8-digit E.164 prefix (a
 *                 10k-number block) per day; catches sequential-range pumping
 *                 that stays under the per-phone cap
 *   4. ip       — `SMS_IP_DAILY_CAP` per caller IP per day, on top of the
 *                 existing 15-minute burst limiter
 *   5. global   — `SMS_DAILY_GLOBAL_CAP` across ALL guarded SMS. This counter
 *                 is incremented LAST, only after every other check has
 *                 passed and just before the actual send, so probes refused
 *                 by earlier layers can never exhaust the platform budget.
 *
 * Refusal responses are uniform across the counting layers (one message, one
 * code) so an attacker is never told WHICH cap they hit; the specifics go to
 * the logs. The global kill-switch answers 503 (service state, not caller
 * fault); the corridor refusal answers 400 (honest UX for a real user's typo).
 *
 * Failure mode: counters ride `cacheIncrExpire` (shared Redis). When Redis is
 * unavailable the guard falls back to per-process counters — without Redis
 * the app deliberately runs single-instance (see rateLimiter.ts), so those
 * are still exact; during a mid-flight Redis outage each PM2 worker enforces
 * its own copy of the caps (bounded at workers × cap — versus unbounded spend
 * if we failed open, or a full login outage if we failed closed). The
 * corridor allowlist is stateless and therefore always enforced.
 *
 * The first time any layer trips per UTC day (Redis NX flag) a structured
 * `logger.error` fires and, when `ALERT_WEBHOOK_URL` is set, a fire-and-forget
 * webhook POST — never awaited, never able to block or fail the request path.
 * Phone numbers are always masked in logs and alert payloads (RULES.md §3).
 */

import { env } from '../config/env';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import { cacheGet, cacheIncrExpire, cacheSetNX } from '../lib/cache';

export type SmsKind = 'otp' | 'invite';
type GuardLayer = 'corridor' | 'phone' | 'prefix' | 'ip' | 'global';

// ─── Redis keys (one per layer, day-bucketed) ────────────────────────────────

const KEY = {
  phone: (e164: string, day: string) => `abuse:sms:phone:${e164}:${day}`,
  prefix: (p8: string, day: string) => `abuse:sms:prefix:${p8}:${day}`,
  ip: (ip: string, day: string) => `abuse:sms:ip:${ip}:${day}`,
  global: (day: string) => `abuse:sms:global:${day}`,
  alerted: (layer: GuardLayer, day: string) => `abuse:sms:alerted:${layer}:${day}`,
};

// ─── Pure helpers (exported for unit tests) ──────────────────────────────────

/** UTC day stamp, e.g. '20260820' — the bucket every counter lives in. */
export const utcDayStamp = (now: Date = new Date()): string =>
  now.toISOString().slice(0, 10).replace(/-/g, '');

/** Seconds until the UTC day rolls over (min 60s so a key never gets TTL 0). */
export const secondsToUtcDayEnd = (now: Date = new Date()): number => {
  const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(60, Math.ceil((nextMidnight - now.getTime()) / 1000));
};

/** First 8 digits of an E.164 number — identifies a 10,000-number block. */
export const smsPrefix8 = (e164: string): string => e164.replace(/\D/g, '').slice(0, 8);

/** Parse the SMS_ALLOWED_PREFIXES CSV into normalized '+NN…' prefixes. */
export const parseCorridorPrefixes = (csv: string): string[] =>
  csv
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p.startsWith('+') ? p : `+${p}`));

/** True when the destination falls inside one of the allowed corridors. */
export const corridorAllowed = (e164: string, prefixes: string[]): boolean =>
  prefixes.some((p) => e164.startsWith(p));

/**
 * Mask a phone for logs/alerts (RULES.md §3: phone numbers never appear in
 * logs): country code + 2 digits kept, middle starred, last 2 kept.
 * '+919876543210' → '+9198******10'.
 */
export const maskPhone = (phone: string): string => {
  const d = phone.replace(/\D/g, '');
  const plus = phone.trim().startsWith('+') ? '+' : '';
  if (d.length <= 6) return `${plus}${'*'.repeat(d.length)}`;
  return `${plus}${d.slice(0, 4)}${'*'.repeat(d.length - 6)}${d.slice(-2)}`;
};

// Parsed once — env is static for the process lifetime. An explicitly-empty
// allowlist would refuse EVERY send, which is never what an operator meant
// (the kill-switch for that is SMS_DAILY_GLOBAL_CAP=0), so fall back to +91.
const ACTIVE_PREFIXES: string[] = (() => {
  const parsed = parseCorridorPrefixes(env.SMS_ALLOWED_PREFIXES);
  if (parsed.length === 0) {
    logger.warn('[abuseGuard] SMS_ALLOWED_PREFIXES parsed empty — falling back to +91');
    return ['+91'];
  }
  return parsed;
})();

// ─── Refusals ────────────────────────────────────────────────────────────────
// One uniform message/code for all counting layers — the client (and an
// attacker) never learns which cap tripped; the layer goes to the logs only.

const corridorRefusal = (): AppError =>
  new AppError("This phone number's region isn't supported yet.", 400, 'SMS_REGION_UNSUPPORTED');
const capRefusal = (): AppError =>
  new AppError('Too many messages requested. Please try again later.', 429, 'SMS_LIMIT_REACHED');
const globalRefusal = (): AppError =>
  new AppError('Messaging is temporarily unavailable. Please try again soon.', 503, 'SMS_TEMPORARILY_UNAVAILABLE');

// ─── Per-process fallback counters (Redis outage only) ──────────────────────
// Same bounded-FIFO discipline as lib/cache.ts's local map. Keys are already
// day-bucketed, so entries self-obsolete even before their sweep.

const localCounters = new Map<string, { count: number; expiresAt: number }>();
const LOCAL_COUNTER_MAX = 20_000;

const localIncr = (key: string, ttlSeconds: number): number => {
  const now = Date.now();
  const entry = localCounters.get(key);
  if (entry && entry.expiresAt > now) {
    entry.count += 1;
    return entry.count;
  }
  if (localCounters.size >= LOCAL_COUNTER_MAX && !localCounters.has(key)) {
    for (const [k, v] of localCounters) {
      if (v.expiresAt <= now) localCounters.delete(k);
    }
    if (localCounters.size >= LOCAL_COUNTER_MAX) {
      const oldest = localCounters.keys().next().value;
      if (oldest !== undefined) localCounters.delete(oldest);
    }
  }
  localCounters.set(key, { count: 1, expiresAt: now + ttlSeconds * 1000 });
  return 1;
};

const localRead = (key: string): number => {
  const entry = localCounters.get(key);
  return entry && entry.expiresAt > Date.now() ? entry.count : 0;
};

/** Increment a day counter — shared Redis first, per-process fallback second. */
const incrDaily = async (key: string, ttlSeconds: number): Promise<number> => {
  const res = await cacheIncrExpire(key, ttlSeconds);
  if (res) return res.count;
  return localIncr(key, ttlSeconds);
};

/** Read a day counter without incrementing (precheck path). */
const readDaily = async (key: string): Promise<number> => {
  const raw = await cacheGet(key);
  const n = raw !== null ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(n)) return n;
  return localRead(key);
};

// ─── First-trip alerting ─────────────────────────────────────────────────────

interface TripInfo {
  kind: SmsKind | 'precheck';
  phoneMasked?: string;
  prefix8?: string;
  ip?: string | null;
  count?: number;
  cap?: number;
}

/** Fire-and-forget webhook POST — NEVER awaited by callers of onGuardTrip. */
const fireAlertWebhook = (payload: Record<string, unknown>): void => {
  const url = env.ALERT_WEBHOOK_URL;
  if (!url) return;
  void fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  }).catch((err: unknown) =>
    logger.warn(`[abuseGuard] alert webhook failed: ${(err as Error)?.message}`),
  );
};

/**
 * Record a guard refusal: warn on every trip (with masked details), and on the
 * FIRST trip of this layer per UTC day (Redis NX flag) escalate to a
 * structured logger.error + optional webhook. Alerting must never break the
 * request path — everything here is best-effort.
 */
const onGuardTrip = async (layer: GuardLayer, info: TripInfo): Promise<void> => {
  try {
    const day = utcDayStamp();
    const payload = {
      alert: 'sms_guard_tripped',
      service: 'sawa_server',
      guard: layer,
      day,
      kind: info.kind,
      phone: info.phoneMasked,
      prefix: info.prefix8,
      ip: info.ip ?? undefined,
      count: info.count,
      cap: info.cap,
      at: new Date().toISOString(),
    };
    logger.warn(
      `[abuseGuard] SMS refused by ${layer} guard (kind=${info.kind}${
        info.count !== undefined ? ` count=${info.count}/${info.cap}` : ''
      } phone=${info.phoneMasked ?? '-'} ip=${info.ip ?? '-'})`,
      payload,
    );
    const firstToday = await cacheSetNX(
      KEY.alerted(layer, day),
      payload.at,
      secondsToUtcDayEnd() + 3600,
    );
    if (firstToday) {
      logger.error(
        `[abuseGuard] FIRST '${layer}' SMS-guard trip today — possible SMS abuse (kind=${info.kind} phone=${info.phoneMasked ?? '-'} ip=${info.ip ?? '-'})`,
        payload,
      );
      fireAlertWebhook(payload);
    }
  } catch (err: unknown) {
    logger.warn(`[abuseGuard] alerting failed: ${(err as Error)?.message}`);
  }
};

// ─── The guard ───────────────────────────────────────────────────────────────

export interface SmsGuardParams {
  /** Destination in E.164 form ('+91…') — pass through formatPhoneE164 first. */
  phone: string;
  /** Caller IP (req.ip) when the send is request-triggered; omit to skip layer 4. */
  ip?: string | null;
  kind: SmsKind;
}

/**
 * The authoritative check — call immediately before an SMS send. Evaluates
 * every layer, increments the layer counters as it goes, and throws an
 * AppError on refusal. The GLOBAL counter is incremented last, only after all
 * other layers pass, so refused probes never consume the platform budget.
 */
export async function assertSmsSendAllowed({ phone, ip, kind }: SmsGuardParams): Promise<void> {
  const day = utcDayStamp();
  const ttl = secondsToUtcDayEnd() + 3600; // key survives the day it names, then GCs
  const phoneMasked = maskPhone(phone);

  // 1. Corridor allowlist — stateless, always enforced (even with Redis down).
  if (!corridorAllowed(phone, ACTIVE_PREFIXES)) {
    await onGuardTrip('corridor', { kind, phoneMasked, ip });
    throw corridorRefusal();
  }

  // 2. Per-phone daily cap.
  const phoneCount = await incrDaily(KEY.phone(phone, day), ttl);
  if (phoneCount > env.SMS_PHONE_DAILY_CAP) {
    await onGuardTrip('phone', { kind, phoneMasked, ip, count: phoneCount, cap: env.SMS_PHONE_DAILY_CAP });
    throw capRefusal();
  }

  // 3. Per-prefix daily cap (8 E.164 digits = one 10k-number block).
  const prefix8 = smsPrefix8(phone);
  const prefixCount = await incrDaily(KEY.prefix(prefix8, day), ttl);
  if (prefixCount > env.SMS_PREFIX_DAILY_CAP) {
    await onGuardTrip('prefix', { kind, phoneMasked, prefix8, ip, count: prefixCount, cap: env.SMS_PREFIX_DAILY_CAP });
    throw capRefusal();
  }

  // 4. Per-IP daily budget (skipped when the caller has no request IP —
  //    phone/prefix/global still bound such sends).
  if (ip) {
    const ipCount = await incrDaily(KEY.ip(ip, day), ttl);
    if (ipCount > env.SMS_IP_DAILY_CAP) {
      await onGuardTrip('ip', { kind, phoneMasked, ip, count: ipCount, cap: env.SMS_IP_DAILY_CAP });
      throw capRefusal();
    }
  }

  // 5. Global daily kill-switch — INCREMENTED LAST, just before the actual
  //    send, so only fully-approved sends draw down the platform budget.
  const globalCount = await incrDaily(KEY.global(day), ttl);
  if (globalCount > env.SMS_DAILY_GLOBAL_CAP) {
    await onGuardTrip('global', { kind, phoneMasked, ip, count: globalCount, cap: env.SMS_DAILY_GLOBAL_CAP });
    throw globalRefusal();
  }
}

/**
 * Read-only preflight for multi-SMS requests (signup sends TWO messages).
 * Refuses when any phone's corridor is wrong or when the counters show the
 * full batch could not complete — BEFORE any DB rows are created and before
 * the first SMS goes out, so a request that would die on the second send
 * doesn't half-execute. Consumes nothing; the counting guard above stays the
 * authority at each actual send.
 */
export async function precheckSmsSendAllowed(phones: string[], ip?: string | null): Promise<void> {
  const day = utcDayStamp();
  const sends = phones.length;

  for (const phone of phones) {
    if (!corridorAllowed(phone, ACTIVE_PREFIXES)) {
      await onGuardTrip('corridor', { kind: 'precheck', phoneMasked: maskPhone(phone), ip });
      throw corridorRefusal();
    }
  }

  // Per-phone: each phone contributes one send to its own counter.
  for (const phone of phones) {
    const current = await readDaily(KEY.phone(phone, day));
    if (current + 1 > env.SMS_PHONE_DAILY_CAP) {
      await onGuardTrip('phone', { kind: 'precheck', phoneMasked: maskPhone(phone), ip, count: current, cap: env.SMS_PHONE_DAILY_CAP });
      throw capRefusal();
    }
  }

  // Per-prefix: phones in the batch may share a block.
  const prefixNeeds = new Map<string, number>();
  for (const phone of phones) {
    const p8 = smsPrefix8(phone);
    prefixNeeds.set(p8, (prefixNeeds.get(p8) ?? 0) + 1);
  }
  for (const [p8, needed] of prefixNeeds) {
    const current = await readDaily(KEY.prefix(p8, day));
    if (current + needed > env.SMS_PREFIX_DAILY_CAP) {
      await onGuardTrip('prefix', { kind: 'precheck', prefix8: p8, ip, count: current, cap: env.SMS_PREFIX_DAILY_CAP });
      throw capRefusal();
    }
  }

  // Per-IP: the whole batch comes from one caller.
  if (ip) {
    const current = await readDaily(KEY.ip(ip, day));
    if (current + sends > env.SMS_IP_DAILY_CAP) {
      await onGuardTrip('ip', { kind: 'precheck', ip, count: current, cap: env.SMS_IP_DAILY_CAP });
      throw capRefusal();
    }
  }

  // Global — read-only here; only the real sends draw it down.
  const globalCurrent = await readDaily(KEY.global(day));
  if (globalCurrent + sends > env.SMS_DAILY_GLOBAL_CAP) {
    await onGuardTrip('global', { kind: 'precheck', ip, count: globalCurrent, cap: env.SMS_DAILY_GLOBAL_CAP });
    throw globalRefusal();
  }
}
