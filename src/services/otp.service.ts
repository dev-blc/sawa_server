import twilio from 'twilio';
import { prisma } from '../lib/prisma';
import { OTP_EXPIRES_IN_MINUTES } from '../constants/index';
import { logger } from '../utils/logger';

// ─── CONFIGURATION ──────────────────────────────────────────────────────────

/**
 * TOGGLE: Set this to true to enable real Twilio SMS.
 * If false, the app uses dummy OTP '1234' and logs invitations to console.
 */
const USE_TWILIO = false; 

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER;

const twilioClient = (USE_TWILIO && TWILIO_SID && TWILIO_AUTH) 
  ? twilio(TWILIO_SID, TWILIO_AUTH) 
  : null;

// ─────────────────────────────────────────────────────────────────────────────

export class OtpService {
  /**
   * Generate an OTP for a phone number under a shared coupleId.
   * Optional custom message can be provided for the SMS.
   */
  async generateAndStore(phone: string, coupleId: string, customMessage?: string): Promise<string> {
    // Remove previous OTP for this phone
    await prisma.otpToken.deleteMany({ where: { phone } });

    // Generate code
    let code: string;
    if (USE_TWILIO) {
       code = Math.floor(1000 + Math.random() * 9000).toString();
    } else {
       code = '1234';
    }

    const expiresAt = new Date(Date.now() + OTP_EXPIRES_IN_MINUTES * 60 * 1000);

    await prisma.otpToken.create({
      data: { phone, coupleId, otpCode: code, expiresAt }
    });

    if (USE_TWILIO && twilioClient && TWILIO_PHONE) {
      try {
        const body = customMessage 
           ? customMessage.replace('{{code}}', code)
           : `[SAWA] Your verification code is: ${code}. Valid for ${OTP_EXPIRES_IN_MINUTES} minutes.`;

        await twilioClient.messages.create({
          body,
          from: TWILIO_PHONE,
          to: phone.startsWith('+') ? phone : `+${phone}`
        });
        logger.info(`[OtpService] Twilio SMS sent to ${phone}`);
      } catch (err) {
        logger.error(`[OtpService] Twilio failed for ${phone}:`, err);
      }
    } else {
      logger.info(`[OtpService] Dummy OTP '${code}' created for ${phone} (entity: ${coupleId})`);
    }

    return code;
  }

  /**
   * Verify OTP for a phone.
   */
  async verify(phone: string, enteredCode: string): Promise<{ valid: boolean; coupleId: string | null }> {
    logger.debug(`[OtpService] Verifying OTP for ${phone}. Code entered: ${enteredCode}`);
    
    // If NOT in twilio mode, master bypass '1234' is allowed
    if (!USE_TWILIO && enteredCode === '1234') {
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
   * Send SMS invitation
   */
  async sendInvitation(phone: string, message: string): Promise<boolean> {
    if (USE_TWILIO && twilioClient && TWILIO_PHONE) {
       try {
         await twilioClient.messages.create({
            body: message,
            from: TWILIO_PHONE,
            to: phone.startsWith('+') ? phone : `+${phone}`
         });
         logger.info(`[OtpService] Twilio Invitation sent to ${phone}`);
         return true;
       } catch (err) {
         logger.error(`[OtpService] Twilio Invitation failed for ${phone}:`, err);
         return false;
       }
    } else {
      logger.info(`[OtpService] Twilio is DISABLED. Invitation log only for ${phone}: "${message}"`);
      return true; 
    }
  }
}

export const otpService = new OtpService();
