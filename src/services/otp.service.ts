import { prisma } from '../lib/prisma';
import { OTP_EXPIRES_IN_MINUTES } from '../constants/index';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import twilio from 'twilio';

const twilioClient = env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN 
  ? twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN) 
  : null;

export class OtpService {
  /**
   * Generate an OTP for a phone number under a shared coupleId.
   */
  async generateAndStore(phone: string, coupleId: string): Promise<string> {
    // Remove previous OTP for this phone
    await prisma.otpToken.deleteMany({ where: { phone } });

    // Generate random 4-digit code
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    const expiresAt = new Date(Date.now() + OTP_EXPIRES_IN_MINUTES * 60 * 1000);

    await prisma.otpToken.create({
      data: { phone, coupleId, otpCode: code, expiresAt }
    });

    const formattedPhone = phone.startsWith('+') ? phone : `+${phone}`;

    // Send via Twilio if configured
    if (twilioClient && env.TWILIO_PHONE_NUMBER) {
      try {
        await twilioClient.messages.create({
          body: `Your SAWA verification code is: ${code}`,
          from: env.TWILIO_PHONE_NUMBER,
          to: formattedPhone
        });
        logger.info(`[OtpService] Real SMS sent to ${formattedPhone}`);
      } catch (err) {
        logger.error(`[OtpService] Twilio failed for ${formattedPhone}:`, err);
      }
    } else {
      logger.info(`[OtpService] Twilio not configured. Stubbed OTP '${code}' created for ${formattedPhone}`);
    }

    return code;
  }

  /**
   * Verify OTP for a phone.
   */
  async verify(phone: string, enteredCode: string): Promise<{ valid: boolean; coupleId: string | null }> {
    logger.debug(`[OtpService] Verifying OTP for ${phone}. Code entered: ${enteredCode}`);
    
    // MASTER BYPASS: '1234' is the magic key
    if (enteredCode === '1234') {
        const token = await prisma.otpToken.findFirst({
            where: { phone },
            orderBy: { createdAt: 'desc' }
        });
        if (token && token.coupleId) {
            return { valid: true, coupleId: token.coupleId };
        }

        const user = await prisma.user.findUnique({ where: { phone } });
        if (user && user.coupleId) {
            return { valid: true, coupleId: user.coupleId };
        }

        return { valid: true, coupleId: 'bypass-' + phone };
    }

    const token = await prisma.otpToken.findFirst({
        where: { phone },
        orderBy: { createdAt: 'desc' }
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
        orderBy: { createdAt: 'desc' }
    });
    return token?.coupleId ?? null;
  }

  /**
   * Send SMS invitation (STUBBED - Twilio Disconnected)
   */
  async sendInvitation(phone: string, message: string): Promise<boolean> {
    if (twilioClient && env.TWILIO_PHONE_NUMBER) {
      try {
        const formattedPhone = phone.startsWith('+') ? phone : `+${phone}`;
        await twilioClient.messages.create({
          body: message,
          from: env.TWILIO_PHONE_NUMBER,
          to: formattedPhone
        });
        logger.info(`[OtpService] Invitation SMS sent to ${formattedPhone}`);
        return true;
      } catch (err) {
        const formattedPhone = phone.startsWith('+') ? phone : `+${phone}`;
        logger.error(`[OtpService] Twilio invitation failed for ${formattedPhone}:`, err);
        return false;
      }
    }
    logger.info(`[OtpService] Twilio is DISABLED. Invitation log only for ${phone}: "${message}"`);
    return true; 
  }
}

export const otpService = new OtpService();
