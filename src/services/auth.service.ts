import crypto from 'crypto';
import { otpService } from './otp.service';

import { userRepository } from '../repositories/user.repository';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { AppError } from '../utils/AppError';
import { Couple } from '../models/Couple.model';
import { User } from '../models/User.model';
import { logger } from '../utils/logger';
import { TokenPair } from '../types/index';

export class AuthService {
  /**
   * STEP 1 — Send OTP
   *
   * Takes yourPhone and partnerPhone.
   * Creates a shared coupleId (like a couple session ID).
   * Generates dummy OTPs for both numbers.
   * Upserts both users in DB (primary + partner roles).
   */
  async sendOtp(yourPhone: string, partnerPhone: string): Promise<{ coupleId: string }> {
    if (yourPhone === partnerPhone) {
      throw new AppError('Your number and partner number cannot be the same', 400, 'SAME_NUMBER');
    }

    // Check if either number already belongs to a verified couple
    const existingYours = await userRepository.findByPhone(yourPhone);
    const existingPartner = await userRepository.findByPhone(partnerPhone);

    // Determine or create the shared coupleId
    let coupleId: string;

    if (existingYours && existingYours.isPhoneVerified) {
      // Returning user — use their existing coupleId
      coupleId = existingYours.coupleId;
    } else if (existingPartner && existingPartner.isPhoneVerified) {
      coupleId = existingPartner.coupleId;
    } else {
      // New couple — generate a fresh coupleId
      coupleId = crypto.randomUUID();
    }

    // Upsert both users under the same coupleId
    await userRepository.upsertByPhone(yourPhone, coupleId, 'primary');
    await userRepository.upsertByPhone(partnerPhone, coupleId, 'partner');

    // Generate dummy OTPs for both (stored in DB, logged in dev)
    await otpService.generateAndStore(yourPhone, coupleId);
    await otpService.generateAndStore(partnerPhone, coupleId);

    logger.info(`[AuthService] OTPs issued for entity: ${coupleId}`);

    return { coupleId };
  }

  /**
   * STEP 2 — Verify OTP (DUMMY MODE)
   *
   * Accepts any 4-digit entry for both numbers.
   * Marks both users as verified.
   * Returns JWT access + refresh token pair for both users.
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
  }> {
    // Verify both OTPs (dummy: any non-empty code passes)
    const [yourResult, partnerResult] = await Promise.all([
      otpService.verify(yourPhone, yourOtp),
      otpService.verify(partnerPhone, partnerOtp),
    ]);

    if (!yourResult.valid) {
      throw new AppError('Your OTP is invalid or expired', 400, 'INVALID_OTP');
    }

    if (!partnerResult.valid) {
      throw new AppError("Partner's OTP is invalid or expired", 400, 'INVALID_PARTNER_OTP');
    }

    const coupleId = yourResult.coupleId!;

    // Mark both as verified
    const [yourUser, partnerUser] = await Promise.all([
      userRepository.markVerified(yourPhone),
      userRepository.markVerified(partnerPhone),
    ]);

    // Issue JWT tokens for your user (the one on this device)
    const yourAccessToken = signAccessToken({
      userId: yourUser._id.toString(),
      coupleId,
    });
    const yourRefreshToken = signRefreshToken({
      userId: yourUser._id.toString(),
      coupleId,
    });

    // Issue tokens for partner too (they will receive via their device later)
    const partnerAccessToken = signAccessToken({
      userId: partnerUser._id.toString(),
      coupleId,
    });
    const partnerRefreshToken = signRefreshToken({
      userId: partnerUser._id.toString(),
      coupleId,
    });

    // Store hashed refresh tokens
    await Promise.all([
      userRepository.saveRefreshTokenHash(
        yourUser._id.toString(),
        hashToken(yourRefreshToken),
      ),
      userRepository.saveRefreshTokenHash(
        partnerUser._id.toString(),
        hashToken(partnerRefreshToken),
      ),
    ]);

    logger.info(`[AuthService] Both users verified. Entity: ${coupleId}`);

    return {
      coupleId,
      yourToken: { accessToken: yourAccessToken, refreshToken: yourRefreshToken },
      partnerToken: { accessToken: partnerAccessToken, refreshToken: partnerRefreshToken },
    };
  }

  /**
   * STEP 3 — Refresh access token
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
      userId: user._id.toString(),
      coupleId: payload.coupleId ?? user.coupleId,
    });

    return { accessToken };
  }

  /**
   * STEP 4 — Logout (revoke refresh token)
   */
  async logout(userId: string): Promise<void> {
    await userRepository.clearRefreshToken(userId);
  }
  /**
   * LOGIN STEP 1 — Send OTP for Login
   * Accepts just one phone number, checks if user exists.
   * If yes, generates a dummy OTP.
   */
  async loginSendOtp(phone: string): Promise<{ coupleId: string }> {
    const user = await userRepository.findByPhone(phone);
    if (!user) {
      throw new AppError('No account found with this number. Please sign up first.', 404, 'USER_NOT_FOUND');
    }

    await otpService.generateAndStore(phone, user.coupleId);
    logger.info(`[AuthService] Login OTP issued for user: ${phone}, coupleId: ${user.coupleId}`);

    return { coupleId: user.coupleId };
  }

  /**
   * LOGIN STEP 2 — Verify OTP for Login (DUMMY MODE)
   * Verifies the single OTP and issues JWT token for the user.
   */
  async loginVerifyOtp(
    phone: string,
    otp: string
  ): Promise<{
    coupleId: string;
    token: TokenPair;
    profile: any;
  }> {
    const result = await otpService.verify(phone, otp);

    if (!result.valid || !result.coupleId) {
      throw new AppError('Invalid or expired OTP', 400, 'INVALID_OTP');
    }

    const user = await userRepository.findByPhone(phone);
    if (!user) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    const accessToken = signAccessToken({
      userId: user._id.toString(),
      coupleId: user.coupleId,
    });
    
    const refreshToken = signRefreshToken({
      userId: user._id.toString(),
      coupleId: user.coupleId,
    });

    await userRepository.saveRefreshTokenHash(
      user._id.toString(),
      hashToken(refreshToken)
    );

    logger.info(`[AuthService] User logged in successfully. coupleId: ${user.coupleId}`);

    const couple = await Couple.findOne({ coupleId: user.coupleId });

    return {
      coupleId: user.coupleId,
      token: { accessToken, refreshToken },
      profile: couple || null,
    };
  }
}

const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

export const authService = new AuthService();
