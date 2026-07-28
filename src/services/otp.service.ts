import twilio from 'twilio';
import { prisma } from '../lib/prisma';
import { OTP_EXPIRES_IN_MINUTES } from '../constants/index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/AppError';

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

function formatPhoneE164(phone: string): string {
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
  ): Promise<void> {
    if (!TWILIO_READY || !twilioClient || !TWILIO_PHONE) {
      logger.error('[OtpService] Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER.');
      throw new AppError('SMS service is not configured. Please contact support.', 503, 'SMS_NOT_CONFIGURED');
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
      await prisma.otpToken.deleteMany({ where: { phone, expiresAt: { lt: new Date() } } });
    } else {
      await prisma.otpToken.deleteMany({ where: { phone } });
    }

    const code = Math.floor(1000 + Math.random() * 9000).toString();
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
      await twilioClient.messages.create({ body, from: TWILIO_PHONE, to: formatPhoneE164(phone) });
      logger.info(`[OtpService] SMS sent to ${phone}`);
    } catch (err) {
      logger.error(`[OtpService] Twilio SMS failed for ${phone}:`, err);
      throw new AppError('Failed to send OTP. Please try again.', 500, 'SMS_SEND_FAILED');
    }
  }

  /**
   * Verify OTP — strictly checks the stored code. No bypass allowed.
   */
  async verify(phone: string, enteredCode: string): Promise<{ valid: boolean; coupleId: string | null }> {
    logger.debug(`[OtpService] Verifying OTP for ${phone}`);

    const code = (enteredCode ?? '').trim();

    // Accept ANY still-valid code issued for this phone (not just the latest).
    // A user may receive more than one code (resend, re-navigation, an older SMS
    // still on screen); as long as the code they entered hasn't expired, let them
    // in. This is the main fix for intermittent "Invalid or expired OTP" reports.
    const token = await prisma.otpToken.findFirst({
      where: { phone, otpCode: code, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (!token) {
      return { valid: false, coupleId: null };
    }

    const coupleId = token.coupleId;
    // Consume the matched code + purge any other now-stale codes for this phone.
    await prisma.otpToken.deleteMany({ where: { phone } });
    return { valid: true, coupleId };
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
   * Send SMS invitation via Twilio
   */
  async sendInvitation(phone: string, message: string): Promise<boolean> {
    if (!TWILIO_READY || !twilioClient || !TWILIO_PHONE) {
      logger.warn(`[OtpService] Twilio not configured — invitation not sent to ${phone}`);
      return false;
    }
    try {
      await twilioClient.messages.create({ body: message, from: TWILIO_PHONE, to: formatPhoneE164(phone) });
      logger.info(`[OtpService] Invitation sent to ${phone}`);
      return true;
    } catch (err) {
      logger.error(`[OtpService] Invitation failed for ${phone}:`, err);
      return false;
    }
  }
}

export const otpService = new OtpService();
