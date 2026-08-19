import crypto from 'crypto';
import twilio from 'twilio';
import { prisma } from '../lib/prisma';
import { OTP_EXPIRES_IN_MINUTES, OTP_MAX_ATTEMPTS } from '../constants/index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/AppError';
import { cacheGet, cacheSet, cacheInvalidate } from '../lib/cache';
import { assertSmsSendAllowed, maskPhone } from './abuseGuard';

/**
 * How long (seconds) a just-verified code stays "replayable". A second verify
 * with the SAME phone+code inside this window succeeds again instead of failing
 * with "Invalid or expired OTP". Covers the real edge cases where the token was
 * already consumed by the first request: a double auto-submit, the user tapping
 * Confirm while auto-fill also submits, or a lost/timed-out response that the
 * app (or user) retries. Those all resolve within seconds — the previous
 * 10-minute window kept a supposedly one-time code live far longer than any
 * legitimate retry needs (audit finding).
 */
const OTP_REPLAY_TTL_SECONDS = 90;
const otpOkKey = (phone: string, code: string) => `otp_ok:${phone}:${code}`;

// Brute-force guard: after OTP_MAX_ATTEMPTS wrong codes for a phone, verification
// is locked for this window. 4-digit codes are only 10k combinations, so without
// this an attacker could exhaust them within a single valid code's lifetime. The
// counter is stored in Redis (shared across cluster workers) and resets on the
// first correct code.
const OTP_LOCKOUT_TTL_SECONDS = 15 * 60;
const otpFailKey = (phone: string) => `otp_fail:${phone}`;

// ─── CONFIGURATION ──────────────────────────────────────────────────────────

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER;

// Android SMS Retriever hash — appended to SMS so Android auto-detects the OTP.
// The hash is derived from the app package name + signing certificate, so it is
// UNIQUE per signing key. The value below is the hash for the direct-distribution
// APK (package `com.sawa.couplesapp`, signed with `sawa-release.keystore`).
//
// IMPORTANT:
//   - If the app is ever re-signed with a different keystore, this value MUST change.
//   - Google Play App Signing re-signs the app with Google's own key, which produces
//     a DIFFERENT hash. For a Play-distributed build, set ANDROID_APP_HASH in the env
//     to the Play "App signing key" hash (from Play Console → App integrity).
//   - The env var (when set) always overrides this default.
const DEFAULT_ANDROID_APP_HASH = 'AJnYV5HCtqV';
const ANDROID_APP_HASH = process.env.ANDROID_APP_HASH || DEFAULT_ANDROID_APP_HASH;

// Twilio is required — all three credentials must be set
const TWILIO_READY = !!(TWILIO_SID && TWILIO_AUTH && TWILIO_PHONE);

const twilioClient = TWILIO_READY
  ? twilio(TWILIO_SID!, TWILIO_AUTH!)
  : null;

// Exported so the auth service and the abuse-guard preflight normalize numbers
// EXACTLY the way the send path does — one source of truth for E.164 shaping.
export function formatPhoneE164(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (phone.startsWith('+')) return phone;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

export class OtpService {
  /**
   * Generate a real OTP and send via Twilio SMS.
   * Throws if Twilio is not configured.
   */
  async generateAndStore(
    phone: string,
    coupleId: string,
    customMessage?: string,
    keepValidPrevious = false,
    ip?: string | null,
  ): Promise<void> {
    if (!TWILIO_READY || !twilioClient || !TWILIO_PHONE) {
      logger.error('[OtpService] Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER.');
      throw new AppError('SMS service is not configured. Please contact support.', 503, 'SMS_NOT_CONFIGURED');
    }

    // ── SMS abuse guard ──────────────────────────────────────────────────────
    // Every OTP SMS passes the layered checks (corridor allowlist, per-phone /
    // per-prefix / per-IP daily caps, global kill-switch) BEFORE any DB write
    // or Twilio call — a refused probe leaves no OTP rows behind. Throws
    // 400/429/503 AppError on refusal; the global budget is consumed last,
    // inside the guard, once every other layer has passed.
    const to = formatPhoneE164(phone);
    await assertSmsSendAllowed({ phone: to, ip, kind: 'otp' });

    // Clean up OTPs for this phone before issuing a new one.
    //   - keepValidPrevious=true  → only purge already-EXPIRED codes, so any
    //     still-valid code the user already received keeps working. This makes
    //     login/resend forgiving: if the user taps "Resend" (or an older SMS is
    //     the one that got auto-filled), the earlier code is still accepted as
    //     long as it hasn't expired. Prevents spurious "Invalid or expired OTP".
    //   - keepValidPrevious=false → wipe all previous codes (signup default,
    //     protects couple pairing so an old code can't resolve a stale coupleId).
    if (keepValidPrevious) {
      await prisma.otpToken.deleteMany({ where: { phone, expiresAt: { lt: new Date() } } });
    } else {
      await prisma.otpToken.deleteMany({ where: { phone } });
    }

    // Use a CSPRNG (not Math.random) so codes are not predictable.
    const code = crypto.randomInt(1000, 10000).toString();
    const expiresAt = new Date(Date.now() + OTP_EXPIRES_IN_MINUTES * 60 * 1000);

    await prisma.otpToken.create({
      data: { phone, coupleId, otpCode: code, expiresAt },
    });

    // SMS format for Android OTP auto-detect (must be < 140 bytes):
    //   - Must END with the 11-character app hash (SMS Retriever API requirement)
    //   - Must NOT start with "<#>" — on MIUI/Poco that prefix suppresses the
    //     keyboard OTP suggestion bar that lets users tap-to-fill the code
    //   - Keep the message human-readable so Android TextClassifier picks up the OTP
    const body = ANDROID_APP_HASH
      ? `[SAWA] Your verification code is: ${code}. Valid for ${OTP_EXPIRES_IN_MINUTES} minutes.\n${ANDROID_APP_HASH}`
      : (customMessage
          ? customMessage.replace('{{code}}', code)
          : `[SAWA] Your verification code is: ${code}. Valid for ${OTP_EXPIRES_IN_MINUTES} minutes.`);

    try {
      await twilioClient.messages.create({ body, from: TWILIO_PHONE, to });
      logger.info(`[OtpService] SMS sent to ${maskPhone(to)}`);
    } catch (err) {
      logger.error(`[OtpService] Twilio SMS failed for ${maskPhone(to)}:`, err);
      throw new AppError('Failed to send OTP. Please try again.', 500, 'SMS_SEND_FAILED');
    }
  }

  /**
   * Verify OTP — strictly checks the stored code. No bypass allowed.
   */
  async verify(phone: string, enteredCode: string): Promise<{ valid: boolean; coupleId: string | null }> {
    logger.debug(`[OtpService] Verifying OTP for ${phone}`);

    const code = (enteredCode ?? '').trim();

    // Brute-force guard: refuse verification once a phone has failed too many
    // times within the lockout window.
    let failCount = 0;
    try {
      const raw = await cacheGet(otpFailKey(phone));
      failCount = raw ? parseInt(raw, 10) || 0 : 0;
    } catch { /* best-effort — fail open on cache outage */ }
    if (failCount >= OTP_MAX_ATTEMPTS) {
      throw new AppError(
        'Too many incorrect codes. Please wait a few minutes before trying again.',
        429,
        'OTP_LOCKED',
      );
    }

    // Accept ANY still-valid code issued for this phone (not just the latest).
    // A user may receive more than one code (resend, re-navigation, an older SMS
    // still on screen); as long as the code they entered hasn't expired, let them
    // in. This is the main fix for intermittent "Invalid or expired OTP" reports.
    const token = await prisma.otpToken.findFirst({
      where: { phone, otpCode: code, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (token) {
      const coupleId = token.coupleId;
      // Consume the matched code + purge any other now-stale codes for this phone.
      await prisma.otpToken.deleteMany({ where: { phone } });
      // Remember this success briefly so a duplicate verify with the same code
      // (double-submit / retry / lost response) still succeeds.
      try { await cacheSet(otpOkKey(phone, code), coupleId ?? '', OTP_REPLAY_TTL_SECONDS); } catch { /* best-effort */ }
      // Reset the failed-attempt counter on the first correct code.
      try { await cacheInvalidate(otpFailKey(phone)); } catch { /* best-effort */ }
      return { valid: true, coupleId };
    }

    // No live token — it may have just been consumed by a duplicate request for
    // the exact same code. Fall back to the short-lived success marker so the
    // user isn't wrongly shown "Invalid or expired OTP".
    try {
      const cached = await cacheGet(otpOkKey(phone, code));
      if (cached !== null) {
        try { await cacheInvalidate(otpFailKey(phone)); } catch { /* best-effort */ }
        return { valid: true, coupleId: cached || null };
      }
    } catch { /* best-effort */ }

    // Wrong code — record the failed attempt (best-effort) so repeated guesses
    // trip the lockout above.
    try { await cacheSet(otpFailKey(phone), String(failCount + 1), OTP_LOCKOUT_TTL_SECONDS); } catch { /* best-effort */ }

    return { valid: false, coupleId: null };
  }

  /**
   * Get coupleId for a phone
   */
  async getEntityId(phone: string): Promise<string | null> {
    const token = await prisma.otpToken.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });
    return token?.coupleId ?? null;
  }

  /**
   * Send SMS invitation via Twilio.
   * Returns false on Twilio config/send failures (soft, historical contract);
   * abuse-guard refusals THROW instead — cost abuse must surface as an error,
   * never masquerade as a soft "not sent".
   */
  async sendInvitation(phone: string, message: string, ip?: string | null): Promise<boolean> {
    if (!TWILIO_READY || !twilioClient || !TWILIO_PHONE) {
      logger.warn(`[OtpService] Twilio not configured — invitation not sent to ${maskPhone(phone)}`);
      return false;
    }

    // SMS abuse guard — same layered checks as OTP sends (see generateAndStore).
    const to = formatPhoneE164(phone);
    await assertSmsSendAllowed({ phone: to, ip, kind: 'invite' });

    try {
      await twilioClient.messages.create({ body: message, from: TWILIO_PHONE, to });
      logger.info(`[OtpService] Invitation sent to ${maskPhone(to)}`);
      return true;
    } catch (err) {
      logger.error(`[OtpService] Invitation failed for ${maskPhone(to)}:`, err);
      return false;
    }
  }
}

export const otpService = new OtpService();
