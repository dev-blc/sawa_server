import crypto from 'crypto';
import { otpService } from './otp.service';
import { userRepository } from '../repositories/user.repository';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { AppError } from '../utils/AppError';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { TokenPair } from '../types/index';
import { env } from '../config/env';

/** Set of phone numbers (with country code) that skip OTP — for test / demo accounts */
const getBypassPhones = (): Set<string> => {
  if (!env.BYPASS_PHONES) return new Set();
  return new Set(env.BYPASS_PHONES.split(',').map(p => p.trim()).filter(Boolean));
};

/**
 * Throws if the couple is banned by an admin. Both partners share the ban.
 * Called from every login path so a fresh OTP can't bypass an active ban.
 */
const assertNotBanned = async (coupleId: string | null | undefined): Promise<void> => {
  if (!coupleId) return;
  const couple = await prisma.couple.findUnique({
    where: { coupleId },
    select: { bannedAt: true },
  });
  if (couple?.bannedAt) {
    throw new AppError(
      'This account has been suspended. Please contact support.',
      403,
      'ACCOUNT_BANNED',
    );
  }
};

export class AuthService {
  /**
   * STEP 1 — Send OTP
   */
  async sendOtp(yourPhone: string, partnerPhone: string): Promise<{ coupleId: string }> {
    if (yourPhone === partnerPhone) {
      throw new AppError('Your number and partner number cannot be the same', 400, 'SAME_NUMBER');
    }

    const existingYours = await userRepository.findByPhone(yourPhone);
    const existingPartner = await userRepository.findByPhone(partnerPhone);

    if (existingYours && existingYours.isPhoneVerified) {
      throw new AppError('This number is already registered. Please Sign In instead.', 400, 'USER_EXISTS');
    }
    if (existingPartner && existingPartner.isPhoneVerified) {
      throw new AppError('Partner number is already registered to another account.', 400, 'PARTNER_EXISTS');
    }

    // If either phone belongs to a partially-registered banned couple, block reuse.
    await assertNotBanned(existingYours?.coupleId);
    await assertNotBanned(existingPartner?.coupleId);

    const coupleId = crypto.randomUUID();

    // One upsert (not two) — FK constraint satisfied before user rows are created.
    await prisma.couple.upsert({
      where: { coupleId },
      update: {},
      create: { coupleId, profileName: 'Sawa Couple' },
    });

    // Both user rows + both OTPs can be kicked off in parallel once the couple row exists.
    const partnerCodeMsg = `Welcome to SAWA! Use {{code}} to verify your shared profile. Download it here: https://apps.apple.com/in/app/sawa-made-for-two/id514584879`;

    await Promise.all([
      userRepository.upsertByPhone(yourPhone, coupleId, 'primary'),
      userRepository.upsertByPhone(partnerPhone, coupleId, 'partner'),
    ]);

    await Promise.all([
      otpService.generateAndStore(yourPhone, coupleId),
      otpService.generateAndStore(partnerPhone, coupleId, partnerCodeMsg),
    ]);

    logger.info(`[AuthService] OTPs issued for entity: ${coupleId}`);
    return { coupleId };
  }

  /**
   * STEP 2 — Verify OTP
   */
  async verifyOtp(
    yourPhone: string,
    yourOtp: string,
    partnerPhone: string,
    partnerOtp: string,
  ): Promise<{
    coupleId: string;
    yourToken: TokenPair;
    partnerToken: TokenPair;
    yourUser: {
      id: string;
      name: string;
      role: string;
    };
  }> {
    // Verify OTPs and fetch existing user records in one parallel shot.
    const [yourResult, partnerResult, existingYours, existingPartner] = await Promise.all([
      otpService.verify(yourPhone, yourOtp),
      otpService.verify(partnerPhone, partnerOtp),
      userRepository.findByPhone(yourPhone),
      userRepository.findByPhone(partnerPhone),
    ]);

    if (!yourResult.valid) {
      throw new AppError('Your OTP is invalid or expired', 400, 'INVALID_OTP');
    }
    if (!partnerResult.valid) {
      throw new AppError("Partner's OTP is invalid or expired", 400, 'INVALID_PARTNER_OTP');
    }

    const coupleId = yourResult.coupleId!;

    const defaultName = (existingYours?.name || existingPartner?.name)
      ? `${existingYours?.name || 'User'} & ${existingPartner?.name || 'Partner'}`
      : 'Sawa Couple';

    // Ensure couple row exists (FK constraint) then upsert users in parallel.
    const couple = await prisma.couple.upsert({
      where: { coupleId },
      update: {},
      create: { coupleId, profileName: defaultName, isProfileComplete: false, isSubscribed: false },
    });

    await Promise.all([
      userRepository.upsertByPhone(yourPhone, coupleId, 'primary'),
      userRepository.upsertByPhone(partnerPhone, coupleId, 'partner'),
    ]);

    const [yourUser, partnerUser] = await Promise.all([
      userRepository.markVerified(yourPhone),
      userRepository.markVerified(partnerPhone),
    ]);

    // `couple` is already available from the upsert above — no extra findUnique needed.

    const yourAccessToken = signAccessToken({
      userId: yourUser.id,
      coupleMongoId: couple?.id || undefined,
      coupleId,
    });
    const yourRefreshToken = signRefreshToken({
      userId: yourUser.id,
      coupleMongoId: couple?.id || undefined,
      coupleId,
    });

    const partnerAccessToken = signAccessToken({
      userId: partnerUser.id,
      coupleMongoId: couple?.id || undefined,
      coupleId,
    });
    const partnerRefreshToken = signRefreshToken({
      userId: partnerUser.id,
      coupleMongoId: couple?.id || undefined,
      coupleId,
    });

    await Promise.all([
      userRepository.saveRefreshTokenHash(yourUser.id, hashToken(yourRefreshToken)),
      userRepository.saveRefreshTokenHash(partnerUser.id, hashToken(partnerRefreshToken)),
    ]);

    return {
      coupleId,
      yourToken: { accessToken: yourAccessToken, refreshToken: yourRefreshToken },
      partnerToken: { accessToken: partnerAccessToken, refreshToken: partnerRefreshToken },
      yourUser: {
        id: yourUser.id,
        name: yourUser.name || '',
        role: yourUser.role
      }
    };
  }

  /**
   * STEP 3 — Refresh
   */
  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string }> {
    const payload = verifyRefreshToken(refreshToken);

    const user = await userRepository.findByIdWithRefreshToken(payload.userId);
    if (!user || !user.refreshTokenHash) {
      throw new AppError('Invalid refresh token', 401, 'INVALID_REFRESH_TOKEN');
    }

    if (hashToken(refreshToken) !== user.refreshTokenHash) {
      throw new AppError('Refresh token mismatch', 401, 'INVALID_REFRESH_TOKEN');
    }

    const accessToken = signAccessToken({
      userId: user.id,
      coupleMongoId: payload.coupleMongoId,
      coupleId: payload.coupleId ?? user.coupleId ?? undefined,
    });

    return { accessToken };
  }

  /**
   * STEP 4 — Logout
   */
  async logout(userId: string): Promise<void> {
    await userRepository.clearRefreshToken(userId);
  }

  /**
   * LOGIN STEP 1
   * For bypass phones: skips OTP entirely and returns access/refresh tokens immediately.
   * For normal phones: sends OTP and returns only the coupleId.
   */
  async loginSendOtp(phone: string): Promise<{
    coupleId: string;
    bypass?: true;
    accessToken?: string;
    refreshToken?: string;
    profile?: any;
    user?: { id: string; name: string; role: string };
  }> {
    const user = await userRepository.findByPhone(phone);
    if (!user) {
      throw new AppError('No account found with this number.', 404, 'USER_NOT_FOUND');
    }

    await assertNotBanned(user.coupleId);

    // ── Bypass: issue tokens immediately, no OTP needed ──────────────────────
    if (getBypassPhones().has(phone)) {
      logger.info(`[AuthService] Bypass login for ${phone}`);

      const couple = user.coupleId
        ? await prisma.couple.upsert({
            where: { coupleId: user.coupleId },
            update: {},
            create: { coupleId: user.coupleId, profileName: user.name || 'Sawa Couple', isProfileComplete: false, isSubscribed: false },
          })
        : null;

      const accessToken = signAccessToken({
        userId: user.id,
        coupleMongoId: couple?.id || undefined,
        coupleId: user.coupleId || undefined,
      });
      const refreshToken = signRefreshToken({
        userId: user.id,
        coupleMongoId: couple?.id || undefined,
        coupleId: user.coupleId || undefined,
      });

      await userRepository.saveRefreshTokenHash(user.id, hashToken(refreshToken));

      return {
        coupleId: user.coupleId || '',
        bypass: true,
        accessToken,
        refreshToken,
        profile: couple ? { ...couple, _id: (couple as any).id } : null,
        user: { id: user.id, name: user.name || '', role: user.role },
      };
    }

    // ── Normal flow ───────────────────────────────────────────────────────────
    // If the user row somehow has no coupleId (legacy / migration gap), try
    // to find their couple via the Couple table's partner references before
    // falling back to an empty string (which would cause loginVerifyOtp to
    // generate a fresh UUID and create a new couple from scratch).
    let resolvedCoupleId = user.coupleId;
    if (!resolvedCoupleId) {
      const linked = await prisma.couple.findFirst({
        where: { OR: [{ partner1Id: user.id }, { partner2Id: user.id }] },
        select: { coupleId: true },
      });
      resolvedCoupleId = linked?.coupleId ?? null;
      if (resolvedCoupleId) {
        // Repair the stale user row so future logins won't need this lookup.
        await prisma.user.update({ where: { id: user.id }, data: { coupleId: resolvedCoupleId } });
      }
    }
    await otpService.generateAndStore(phone, resolvedCoupleId || '');
    return { coupleId: resolvedCoupleId || '' };
  }

  /**
   * LOGIN STEP 2
   */
  async loginVerifyOtp(phone: string, otp: string): Promise<{
    coupleId: string;
    token: TokenPair;
    profile: any;
    user: {
      id: string;
      name: string;
      role: string;
    };
  }> {
    // OTP verify + user lookup in parallel — saves one DB round trip.
    const [result, user] = await Promise.all([
      otpService.verify(phone, otp),
      userRepository.findByPhone(phone),
    ]);

    // Only check OTP validity — do NOT gate on coupleId here, since accounts
    // registered before coupleId was reliably stored may have an empty coupleId.
    if (!result.valid) {
      throw new AppError('Invalid or expired OTP', 400, 'INVALID_OTP');
    }
    if (!user) {
      throw new AppError('No account found with this number.', 404, 'USER_NOT_FOUND');
    }

    // Resolve coupleId with priority:
    //   1. The user row's own coupleId (most authoritative)
    //   2. The coupleId stored with the OTP token (set during loginSendOtp)
    //   3. A couple where this user is partner1 or partner2 (handles legacy rows)
    //   4. A fresh UUID (absolute last resort — new account scenario)
    let coupleId: string = user.coupleId || result.coupleId || '';

    if (!coupleId) {
      // Neither the user row nor the OTP token has a coupleId — look up via
      // the Couple table's partner references to avoid creating a duplicate couple.
      const linked = await prisma.couple.findFirst({
        where: { OR: [{ partner1Id: user.id }, { partner2Id: user.id }] },
        select: { coupleId: true },
      });
      coupleId = linked?.coupleId ?? crypto.randomUUID();
    }

    // Persist the coupleId back to the user row if it was missing or stale.
    if (!user.coupleId || user.coupleId !== coupleId) {
      await prisma.user.update({ where: { id: user.id }, data: { coupleId } });
    }

    await assertNotBanned(coupleId);

    // Upsert couple (handles missing row) — single query, not a find + conditional create.
    const couple = await prisma.couple.upsert({
      where: { coupleId },
      update: {},
      create: {
        coupleId,
        profileName: user.name || 'Sawa Couple',
        isProfileComplete: false,
        isSubscribed: false,
      },
    });

    const accessToken = signAccessToken({
      userId: user.id,
      coupleMongoId: couple.id,
      coupleId,
    });
    const refreshToken = signRefreshToken({
      userId: user.id,
      coupleMongoId: couple.id,
      coupleId,
    });

    await userRepository.saveRefreshTokenHash(user.id, hashToken(refreshToken));

    return {
      coupleId,
      token: { accessToken, refreshToken },
      profile: { ...couple, _id: couple.id },
      user: {
        id: user.id,
        _id: user.id,
        name: user.name || '',
        role: user.role as any,
      } as any,
    };
  }

  /**
   * RESEND OTP — only for one phone at a time.
   * Reuses the existing coupleId so the other partner's OTP is NOT affected.
   * Safe to call multiple times; each call replaces only that phone's OTP.
   */
  async resendOtp(phone: string): Promise<void> {
    // Find the coupleId from the existing OTP record for this phone
    const existingToken = await prisma.otpToken.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
      select: { coupleId: true },
    });

    let coupleId = existingToken?.coupleId;

    // Fallback: look up the user record (handles edge case where OTP was already verified/expired)
    if (!coupleId) {
      const user = await userRepository.findByPhone(phone);
      coupleId = user?.coupleId ?? undefined;
    }

    if (!coupleId) {
      throw new AppError(
        'No active signup session found for this number. Please start registration again.',
        400,
        'NO_SESSION',
      );
    }

    // Regenerate OTP for this phone only — partner's OTP is untouched
    await otpService.generateAndStore(phone, coupleId);
    logger.info(`[AuthService] OTP resent for ${phone} (coupleId: ${coupleId})`);
  }

  async sendPartnerInvite(partnerPhone: string): Promise<boolean> {
    const inviteLink = "https://apps.apple.com/in/app/sawa-made-for-two/id514584879";
    const msg = `Hi! Your partner has invited you to join them on SAWA: ${inviteLink}`;
    return otpService.sendInvitation(partnerPhone, msg);
  }
}

const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

export const authService = new AuthService();
