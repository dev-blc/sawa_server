import twilio from 'twilio';
import { prisma } from '../lib/prisma';
import { OTP_EXPIRES_IN_MINUTES } from '../constants/index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/AppError';

// ─── CONFIGURATION ──────────────────────────────────────────────────────────

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER;

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
  ): Promise<void> {
    if (!TWILIO_READY || !twilioClient || !TWILIO_PHONE) {
      logger.error('[OtpService] Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER.');
      throw new AppError('SMS service is not configured. Please contact support.', 503, 'SMS_NOT_CONFIGURED');
    }

    // Remove any existing OTP for this phone
    await prisma.otpToken.deleteMany({ where: { phone } });

    const code = Math.floor(1000 + Math.random() * 9000).toString();
    const expiresAt = new Date(Date.now() + OTP_EXPIRES_IN_MINUTES * 60 * 1000);

    await prisma.otpToken.create({
      data: { phone, coupleId, otpCode: code, expiresAt },
    });

    const body = customMessage
      ? customMessage.replace('{{code}}', code)
      : `[SAWA] Your verification code is: ${code}. Valid for ${OTP_EXPIRES_IN_MINUTES} minutes.`;

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

    const token = await prisma.otpToken.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });

    if (!token) {
      return { valid: false, coupleId: null };
    }

    if (token.expiresAt < new Date()) {
      await prisma.otpToken.delete({ where: { id: token.id } });
      return { valid: false, coupleId: null };
    }

    if (enteredCode !== token.otpCode) {
      return { valid: false, coupleId: null };
    }

    const coupleId = token.coupleId;
    await prisma.otpToken.delete({ where: { id: token.id } });
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
