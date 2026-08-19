import crypto from 'crypto';
import { otpService, formatPhoneE164 } from './otp.service';
import { precheckSmsSendAllowed, maskPhone } from './abuseGuard';
import { revokeUserAccessTokens } from './tokenDenylist';
import { userRepository, normalizePhone } from '../repositories/user.repository';
import { signAccessToken, signRefreshToken, verifyRefreshToken, denylistAccessToken } from '../utils/jwt';
import { AppError } from '../utils/AppError';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { TokenPair } from '../types/index';
import { env } from '../config/env';

/** Set of phone numbers (with country code) that skip OTP — for test / demo accounts */
const getBypassPhones = (): Set<string> => {
  if (!env.BYPASS_PHONES) return new Set();
  // Secure-by-default: the OTP bypass is a testing/demo backdoor and is DISABLED
  // in production unless an operator explicitly opts in with
  // BYPASS_PHONES_ALLOW_PROD=true. This prevents accidentally shipping a
  // permanent OTP-less login for the listed numbers.
  if (env.NODE_ENV === 'production' && process.env.BYPASS_PHONES_ALLOW_PROD !== 'true') {
    logger.warn('[auth] BYPASS_PHONES is set but ignored in production (set BYPASS_PHONES_ALLOW_PROD=true to force).');
    return new Set();
  }
  // Normalise every entry to bare 10-digit form so the bypass matches
  // regardless of how the number is stored in env or sent by the client
  // (+91…, 91…, or a bare 10-digit number all collapse to the same key).
  return new Set(
    env.BYPASS_PHONES.split(',')
      .map(p => normalizePhone(p.trim()))
      .filter(Boolean),
  );
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
  async sendOtp(yourPhone: string, partnerPhone: string, ip?: string | null): Promise<{ coupleId: string }> {
    if (yourPhone === partnerPhone) {
      throw new AppError('Your number and partner number cannot be the same', 400, 'SAME_NUMBER');
    }

    // SMS abuse preflight (read-only) — this endpoint is unauthenticated and
    // sends TWO SMS per call, so refuse disallowed/over-budget requests BEFORE
    // any couple/user rows are created and before the first of the two sends.
    // The counting guard inside otpService.generateAndStore stays authoritative.
    await precheckSmsSendAllowed([formatPhoneE164(yourPhone), formatPhoneE164(partnerPhone)], ip);

    const existingYours = await userRepository.findByPhone(yourPhone);
    const existingPartner = await userRepository.findByPhone(partnerPhone);

    // Account-enumeration hardening (M3): distinct "your number" vs "partner
    // number" messages + distinct codes let a caller probe WHICH specific number
    // is already registered (submit the target as one field, a throwaway as the
    // other, read the code). Collapse both into ONE generic code + message so the
    // response no longer reveals which of the two is taken. Residual: it still
    // signals that at least one is registered — inherent to signup UX (a real new
    // user must proceed to OTP, an existing one must be told to sign in) and
    // rate-limited by authRateLimiter + the SMS abuse caps; fully closing it needs
    // a coordinated client change (documented in CHANGELOG). Contract-safe: the
    // mobile SignupScreen only toasts `error` and never branches on the code.
    if (
      (existingYours && existingYours.isPhoneVerified) ||
      (existingPartner && existingPartner.isPhoneVerified)
    ) {
      throw new AppError(
        'An account already exists for one of these numbers. Please sign in instead.',
        400,
        'ACCOUNT_EXISTS',
      );
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
    const appUrl = (env.APP_URL || 'https://sawa.living').replace(/\/$/, '');
    const partnerCodeMsg = `Welcome to SAWA! Use {{code}} to verify your shared profile. Download here: ${appUrl}/app`;

    await Promise.all([
      userRepository.upsertByPhone(yourPhone, coupleId, 'primary'),
      userRepository.upsertByPhone(partnerPhone, coupleId, 'partner'),
    ]);

    // keepValidPrevious=true — mirror the login flow. If "Send Code" fires more
    // than once (double-tap, screen re-mount, slow-network retry) the earlier
    // still-valid code from the FIRST SMS keeps working, so the user never sees a
    // spurious "Invalid or expired OTP" for a code they only generated once.
    await Promise.all([
      otpService.generateAndStore(yourPhone, coupleId, undefined, true, ip),
      otpService.generateAndStore(partnerPhone, coupleId, partnerCodeMsg, true, ip),
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
  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const payload = verifyRefreshToken(refreshToken);

    const user = await userRepository.findByIdWithRefreshToken(payload.userId);
    if (!user || !user.refreshTokenHash) {
      throw new AppError('Invalid refresh token', 401, 'INVALID_REFRESH_TOKEN');
    }

    // Constant-time compare of the stored vs presented refresh-token hash.
    const presented = Buffer.from(hashToken(refreshToken), 'utf8');
    const stored = Buffer.from(user.refreshTokenHash, 'utf8');
    if (presented.length !== stored.length || !crypto.timingSafeEqual(presented, stored)) {
      throw new AppError('Refresh token mismatch', 401, 'INVALID_REFRESH_TOKEN');
    }

    const resolvedCoupleId = payload.coupleId ?? user.coupleId ?? undefined;

    const accessToken = signAccessToken({
      userId: user.id,
      coupleMongoId: payload.coupleMongoId,
      coupleId: resolvedCoupleId,
    });

    // Rolling refresh — issue a fresh refresh token so the session
    // keeps extending as long as the user is active.
    const newRefreshToken = signRefreshToken({
      userId: user.id,
      coupleMongoId: payload.coupleMongoId,
      coupleId: resolvedCoupleId,
    });
    await userRepository.saveRefreshTokenHash(user.id, hashToken(newRefreshToken));

    return { accessToken, refreshToken: newRefreshToken };
  }

  /**
   * STEP 4 — Logout (with access-token containment, audit H4)
   *
   * Clearing the refresh hash alone left the ACCESS token valid for its full
   * `JWT_ACCESS_EXPIRES_IN` (7d default) — a stolen token survived logout.
   * The TTL itself deliberately stays unchanged: the admin panel authenticates
   * with the same access tokens and has NO refresh flow, so shortening the
   * lifetime would break admin sessions. Containment instead is Redis-side,
   * on two axes, both enforced by `authenticate` and the socket handshake:
   *  - jti denylist (utils/jwt.ts): kills exactly the token presented here;
   *  - per-user watermark (services/tokenDenylist.ts): kills EVERY access
   *    token issued to this user before this logout — including older copies
   *    an attacker may hold from before a refresh rotation.
   */
  async logout(userId: string, jti?: string, accessTokenExp?: number): Promise<void> {
    await Promise.all([
      userRepository.clearRefreshToken(userId),
      revokeUserAccessTokens(userId),
      denylistAccessToken(jti, accessTokenExp),
    ]);
  }

  /**
   * LOGIN STEP 1
   * For bypass phones: skips OTP entirely and returns access/refresh tokens immediately.
   * For normal phones: sends OTP and returns only the coupleId.
   */
  async loginSendOtp(phone: string, ip?: string | null): Promise<{
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
    if (getBypassPhones().has(normalizePhone(phone))) {
      logger.info(`[AuthService] Bypass login for ${maskPhone(phone)}`);

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
    // keepValidPrevious=true — don't wipe a still-valid code the user may already
    // have received; avoids "Invalid or expired OTP" when an earlier code is used.
    await otpService.generateAndStore(phone, resolvedCoupleId || '', undefined, true, ip);
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

    await assertNotBanned(coupleId);

    // Ensure the couple row exists BEFORE linking the user to it. The User→Couple
    // foreign key (User.coupleId → Couple.coupleId) rejects any user update whose
    // coupleId has no matching couple row yet — which is exactly the case for a
    // freshly generated coupleId (legacy/edge accounts with no couple). Upserting
    // first guarantees the FK target exists and prevents an "Internal server error"
    // on an otherwise-valid OTP. Mirrors the signup ordering (couple before user).
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

    // Persist the coupleId back to the user row if it was missing or stale.
    if (!user.coupleId || user.coupleId !== coupleId) {
      await prisma.user.update({ where: { id: user.id }, data: { coupleId } });
    }

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
  async resendOtp(phone: string, ip?: string | null): Promise<void> {
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

    // Regenerate OTP for this phone only — partner's OTP is untouched.
    // keepValidPrevious=true so the previously-sent code still works if the user
    // enters it (common: they resend, then auto-fill grabs the first SMS).
    await otpService.generateAndStore(phone, coupleId, undefined, true, ip);
    logger.info(`[AuthService] OTP resent for ${maskPhone(phone)} (coupleId: ${coupleId})`);
  }

  async sendPartnerInvite(partnerPhone: string, ip?: string | null): Promise<boolean> {
    // Use the server's /app page which auto-detects Android vs iOS and redirects
    // to Play Store or App Store accordingly. Falls back to sawa.living if no APP_URL.
    const appUrl = (env.APP_URL || 'https://sawa.living').replace(/\/$/, '');
    const inviteLink = `${appUrl}/app`;
    const msg = `Hi! Your partner has invited you to join them on SAWA — the app for couples. Download here: ${inviteLink}`;
    return otpService.sendInvitation(partnerPhone, msg, ip);
  }
}

const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

export const authService = new AuthService();
