"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.otpService = exports.OtpService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const twilio_1 = __importDefault(require("twilio"));
const prisma_1 = require("../lib/prisma");
const index_1 = require("../constants/index");
const logger_1 = require("../utils/logger");
const AppError_1 = require("../utils/AppError");
const cache_1 = require("../lib/cache");
/**
 * How long (seconds) a just-verified code stays "replayable". A second verify
 * with the SAME phone+code inside this window succeeds again instead of failing
 * with "Invalid or expired OTP". Covers the real edge cases where the token was
 * already consumed by the first request: a double auto-submit, the user tapping
 * Confirm while auto-fill also submits, or a lost/timed-out response that the
 * app (or user) retries.
 */
const OTP_REPLAY_TTL_SECONDS = 600;
const otpOkKey = (phone, code) => `otp_ok:${phone}:${code}`;
// Brute-force guard: after OTP_MAX_ATTEMPTS wrong codes for a phone, verification
// is locked for this window. 4-digit codes are only 10k combinations, so without
// this an attacker could exhaust them within a single valid code's lifetime. The
// counter is stored in Redis (shared across cluster workers) and resets on the
// first correct code.
const OTP_LOCKOUT_TTL_SECONDS = 15 * 60;
const otpFailKey = (phone) => `otp_fail:${phone}`;
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
    ? (0, twilio_1.default)(TWILIO_SID, TWILIO_AUTH)
    : null;
function formatPhoneE164(phone) {
    const digits = phone.replace(/\D/g, '');
    if (phone.startsWith('+'))
        return phone;
    if (digits.length === 12 && digits.startsWith('91'))
        return `+${digits}`;
    if (digits.length === 10)
        return `+91${digits}`;
    return `+${digits}`;
}
class OtpService {
    /**
     * Generate a real OTP and send via Twilio SMS.
     * Throws if Twilio is not configured.
     */
    async generateAndStore(phone, coupleId, customMessage, keepValidPrevious = false) {
        if (!TWILIO_READY || !twilioClient || !TWILIO_PHONE) {
            logger_1.logger.error('[OtpService] Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER.');
            throw new AppError_1.AppError('SMS service is not configured. Please contact support.', 503, 'SMS_NOT_CONFIGURED');
        }
        // Clean up OTPs for this phone before issuing a new one.
        //   - keepValidPrevious=true  → only purge already-EXPIRED codes, so any
        //     still-valid code the user already received keeps working. This makes
        //     login/resend forgiving: if the user taps "Resend" (or an older SMS is
        //     the one that got auto-filled), the earlier code is still accepted as
        //     long as it hasn't expired. Prevents spurious "Invalid or expired OTP".
        //   - keepValidPrevious=false → wipe all previous codes (signup default,
        //     protects couple pairing so an old code can't resolve a stale coupleId).
        if (keepValidPrevious) {
            await prisma_1.prisma.otpToken.deleteMany({ where: { phone, expiresAt: { lt: new Date() } } });
        }
        else {
            await prisma_1.prisma.otpToken.deleteMany({ where: { phone } });
        }
        // Use a CSPRNG (not Math.random) so codes are not predictable.
        const code = crypto_1.default.randomInt(1000, 10000).toString();
        const expiresAt = new Date(Date.now() + index_1.OTP_EXPIRES_IN_MINUTES * 60 * 1000);
        await prisma_1.prisma.otpToken.create({
            data: { phone, coupleId, otpCode: code, expiresAt },
        });
        // SMS format for Android OTP auto-detect (must be < 140 bytes):
        //   - Must END with the 11-character app hash (SMS Retriever API requirement)
        //   - Must NOT start with "<#>" — on MIUI/Poco that prefix suppresses the
        //     keyboard OTP suggestion bar that lets users tap-to-fill the code
        //   - Keep the message human-readable so Android TextClassifier picks up the OTP
        const body = ANDROID_APP_HASH
            ? `[SAWA] Your verification code is: ${code}. Valid for ${index_1.OTP_EXPIRES_IN_MINUTES} minutes.\n${ANDROID_APP_HASH}`
            : (customMessage
                ? customMessage.replace('{{code}}', code)
                : `[SAWA] Your verification code is: ${code}. Valid for ${index_1.OTP_EXPIRES_IN_MINUTES} minutes.`);
        try {
            await twilioClient.messages.create({ body, from: TWILIO_PHONE, to: formatPhoneE164(phone) });
            logger_1.logger.info(`[OtpService] SMS sent to ${phone}`);
        }
        catch (err) {
            logger_1.logger.error(`[OtpService] Twilio SMS failed for ${phone}:`, err);
            throw new AppError_1.AppError('Failed to send OTP. Please try again.', 500, 'SMS_SEND_FAILED');
        }
    }
    /**
     * Verify OTP — strictly checks the stored code. No bypass allowed.
     */
    async verify(phone, enteredCode) {
        logger_1.logger.debug(`[OtpService] Verifying OTP for ${phone}`);
        const code = (enteredCode ?? '').trim();
        // Brute-force guard: refuse verification once a phone has failed too many
        // times within the lockout window.
        let failCount = 0;
        try {
            const raw = await (0, cache_1.cacheGet)(otpFailKey(phone));
            failCount = raw ? parseInt(raw, 10) || 0 : 0;
        }
        catch { /* best-effort — fail open on cache outage */ }
        if (failCount >= index_1.OTP_MAX_ATTEMPTS) {
            throw new AppError_1.AppError('Too many incorrect codes. Please wait a few minutes before trying again.', 429, 'OTP_LOCKED');
        }
        // Accept ANY still-valid code issued for this phone (not just the latest).
        // A user may receive more than one code (resend, re-navigation, an older SMS
        // still on screen); as long as the code they entered hasn't expired, let them
        // in. This is the main fix for intermittent "Invalid or expired OTP" reports.
        const token = await prisma_1.prisma.otpToken.findFirst({
            where: { phone, otpCode: code, expiresAt: { gt: new Date() } },
            orderBy: { createdAt: 'desc' },
        });
        if (token) {
            const coupleId = token.coupleId;
            // Consume the matched code + purge any other now-stale codes for this phone.
            await prisma_1.prisma.otpToken.deleteMany({ where: { phone } });
            // Remember this success briefly so a duplicate verify with the same code
            // (double-submit / retry / lost response) still succeeds.
            try {
                await (0, cache_1.cacheSet)(otpOkKey(phone, code), coupleId ?? '', OTP_REPLAY_TTL_SECONDS);
            }
            catch { /* best-effort */ }
            // Reset the failed-attempt counter on the first correct code.
            try {
                await (0, cache_1.cacheInvalidate)(otpFailKey(phone));
            }
            catch { /* best-effort */ }
            return { valid: true, coupleId };
        }
        // No live token — it may have just been consumed by a duplicate request for
        // the exact same code. Fall back to the short-lived success marker so the
        // user isn't wrongly shown "Invalid or expired OTP".
        try {
            const cached = await (0, cache_1.cacheGet)(otpOkKey(phone, code));
            if (cached !== null) {
                try {
                    await (0, cache_1.cacheInvalidate)(otpFailKey(phone));
                }
                catch { /* best-effort */ }
                return { valid: true, coupleId: cached || null };
            }
        }
        catch { /* best-effort */ }
        // Wrong code — record the failed attempt (best-effort) so repeated guesses
        // trip the lockout above.
        try {
            await (0, cache_1.cacheSet)(otpFailKey(phone), String(failCount + 1), OTP_LOCKOUT_TTL_SECONDS);
        }
        catch { /* best-effort */ }
        return { valid: false, coupleId: null };
    }
    /**
     * Get coupleId for a phone
     */
    async getEntityId(phone) {
        const token = await prisma_1.prisma.otpToken.findFirst({
            where: { phone },
            orderBy: { createdAt: 'desc' },
        });
        return token?.coupleId ?? null;
    }
    /**
     * Send SMS invitation via Twilio
     */
    async sendInvitation(phone, message) {
        if (!TWILIO_READY || !twilioClient || !TWILIO_PHONE) {
            logger_1.logger.warn(`[OtpService] Twilio not configured — invitation not sent to ${phone}`);
            return false;
        }
        try {
            await twilioClient.messages.create({ body: message, from: TWILIO_PHONE, to: formatPhoneE164(phone) });
            logger_1.logger.info(`[OtpService] Invitation sent to ${phone}`);
            return true;
        }
        catch (err) {
            logger_1.logger.error(`[OtpService] Invitation failed for ${phone}:`, err);
            return false;
        }
    }
}
exports.OtpService = OtpService;
exports.otpService = new OtpService();
//# sourceMappingURL=otp.service.js.map