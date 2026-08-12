import jwt, { SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError } from './AppError';

export interface JwtPayload {
  userId: string;
  coupleMongoId?: string; // MongoDB _id of the Couple document (High performance)
  coupleId?: string;      // shared couple entity ID (UUID)
  type: 'access' | 'refresh';
}

// Pin the signing/verification algorithm so a forged token that sets
// `"alg":"none"` (or asymmetric-key confusion) can never be accepted.
const JWT_ALG = 'HS256' as const;

export const signAccessToken = (payload: Omit<JwtPayload, 'type'>): string => {
  return jwt.sign(
    { ...payload, type: 'access' },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_EXPIRES_IN, algorithm: JWT_ALG } as SignOptions,
  );
};

export const signRefreshToken = (payload: Omit<JwtPayload, 'type'>): string => {
  return jwt.sign(
    { ...payload, type: 'refresh' },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES_IN, algorithm: JWT_ALG } as SignOptions,
  );
};

export const verifyAccessToken = (token: string): JwtPayload => {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: [JWT_ALG],
    }) as JwtPayload;
    // Reject a refresh token presented where an access token is expected.
    if (payload.type !== 'access') {
      throw new AppError('Invalid or expired access token', 401, 'INVALID_TOKEN');
    }
    return payload;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('Invalid or expired access token', 401, 'INVALID_TOKEN');
  }
};

export const verifyRefreshToken = (token: string): JwtPayload => {
  try {
    const payload = jwt.verify(token, env.JWT_REFRESH_SECRET, {
      algorithms: [JWT_ALG],
    }) as JwtPayload;
    if (payload.type !== 'refresh') {
      throw new AppError('Invalid or expired refresh token', 401, 'INVALID_REFRESH_TOKEN');
    }
    return payload;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('Invalid or expired refresh token', 401, 'INVALID_REFRESH_TOKEN');
  }
};
