import { Request, Response } from 'express';
import { z } from 'zod';
import { authService } from '../services/auth.service';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/AppError';
import { validate } from '../middleware/validate';
import { env } from '../config/env';

// ─── Account-enumeration timing normalization (M3) ────────────────────────────
// The two existence-revealing endpoints (send-otp, login-send-otp) take a fast
// path when the number's registration state lets them skip Twilio — signup's
// SAME_NUMBER / ACCOUNT_EXISTS, login's USER_NOT_FOUND — and would otherwise
// answer markedly faster than a real send, letting a caller distinguish
// registered from unregistered numbers by latency alone. Floor every response to
// a fixed minimum so that side-channel is closed. A genuine send already makes a
// Twilio call (usually > the floor), so legit users are rarely delayed. The
// response BODY still differs by necessity of the client UX (login routes to
// Signup on USER_NOT_FOUND; signup must send an OTP to a new number) — that
// residual is documented; this only removes the timing leg. Off under test.
const ENUM_TIMING_FLOOR_MS = env.NODE_ENV === 'test' ? 0 : 500;
async function withTimingFloor<T>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    const remaining = ENUM_TIMING_FLOOR_MS - (Date.now() - start);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

// ─── Schemas ────────────────────────────────────────────────────────────────

const SendOtpSchema = z.object({
  yourPhone: z
    .string()
    .min(10, 'Phone must be at least 10 digits')
    .max(15, 'Phone too long')
    .regex(/^\d+$/, 'Phone must contain only digits'),
  partnerPhone: z
    .string()
    .min(10, 'Partner phone must be at least 10 digits')
    .max(15, 'Partner phone too long')
    .regex(/^\d+$/, 'Partner phone must contain only digits'),
});

const VerifyOtpSchema = z.object({
  yourPhone: z.string().min(10).max(15).regex(/^\d+$/),
  yourOtp: z
    .string()
    .length(4, 'OTP must be 4 digits')
    .regex(/^\d+$/, 'OTP must be numeric'),
  partnerPhone: z.string().min(10).max(15).regex(/^\d+$/),
  partnerOtp: z
    .string()
    .length(4, 'Partner OTP must be 4 digits')
    .regex(/^\d+$/, 'OTP must be numeric'),
});

const RefreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

const LoginSendOtpSchema = z.object({
  phone: z.string().min(10).max(15).regex(/^\d+$/),
});

const LoginVerifyOtpSchema = z.object({
  phone: z.string().min(10).max(15).regex(/^\d+$/),
  otp: z.string().length(4).regex(/^\d+$/),
});

// ─── Validation Middleware (exported so routes can use them) ─────────────────
export const validateSendOtp = validate(SendOtpSchema);
export const validateVerifyOtp = validate(VerifyOtpSchema);
export const validateRefresh = validate(RefreshSchema);
export const validateLoginSendOtp = validate(LoginSendOtpSchema);
export const validateLoginVerifyOtp = validate(LoginVerifyOtpSchema);

// ─── Controllers ────────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/send-otp
 * Body: { yourPhone, partnerPhone }
 *
 * Creates/finds a shared coupleId for both phones.
 * Sends real OTPs via Twilio to both numbers.
 */
export const sendOtp = async (req: Request, res: Response): Promise<void> => {
  const { yourPhone, partnerPhone } = req.body as z.infer<typeof SendOtpSchema>;

  // req.ip is the real client behind one proxy hop ('trust proxy' in app.ts);
  // it feeds the per-IP daily SMS budget in services/abuseGuard.ts.
  // withTimingFloor: normalize response time so signup enumeration can't be
  // timed (M3) — see the helper at the top of this file.
  const result = await withTimingFloor(() => authService.sendOtp(yourPhone, partnerPhone, req.ip));

  sendSuccess({
    res,
    statusCode: 200,
    message: 'OTP sent to both numbers',
    data: { coupleId: result.coupleId },
  });
};

/**
 * POST /api/v1/auth/verify-otp
 * Body: { yourPhone, yourOtp, partnerPhone, partnerOtp }
 *
 * Verifies both OTPs via Twilio. Returns JWT token pair for the primary user.
 */
export const verifyOtp = async (req: Request, res: Response): Promise<void> => {
  const { yourPhone, yourOtp, partnerPhone, partnerOtp } =
    req.body as z.infer<typeof VerifyOtpSchema>;

  const result = await authService.verifyOtp(yourPhone, yourOtp, partnerPhone, partnerOtp);

    sendSuccess({
    res,
    statusCode: 200,
    message: 'OTP verified successfully',
    data: {
      coupleId: result.coupleId,
      accessToken: result.yourToken.accessToken,
      refreshToken: result.yourToken.refreshToken,
      // Partner tokens returned so the partner device can also log in
      partnerAccessToken: result.partnerToken.accessToken,
      partnerRefreshToken: result.partnerToken.refreshToken,
      yourUser: result.yourUser,
    },
  });
};

/**
 * POST /api/v1/auth/refresh
 * Body: { refreshToken }
 */
export const refreshToken = async (req: Request, res: Response): Promise<void> => {
  const { refreshToken: token } = req.body as z.infer<typeof RefreshSchema>;

  const result = await authService.refreshAccessToken(token);

  sendSuccess({
    res,
    data: { accessToken: result.accessToken, refreshToken: result.refreshToken },
    message: 'Token refreshed',
  });
};

/**
 * POST /api/v1/auth/login-send-otp
 * Body: { phone }
 */
export const loginSendOtp = async (req: Request, res: Response): Promise<void> => {
  const { phone } = req.body as z.infer<typeof LoginSendOtpSchema>;
  // withTimingFloor: uniform response time so an unregistered number (fast
  // USER_NOT_FOUND) can't be told from a registered one (OTP send) by latency (M3).
  const result = await withTimingFloor(() => authService.loginSendOtp(phone, req.ip));

  // Bypass accounts: return tokens immediately so the client can skip the OTP screen
  if (result.bypass) {
    sendSuccess({
      res,
      statusCode: 200,
      message: 'Bypass login successful',
      data: {
        coupleId: result.coupleId,
        bypass: true,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        profile: result.profile,
        user: result.user,
      },
    });
    return;
  }

  sendSuccess({
    res,
    statusCode: 200,
    message: 'Login OTP sent',
    data: { coupleId: result.coupleId },
  });
};

/**
 * POST /api/v1/auth/login-verify-otp
 * Body: { phone, otp }
 */
export const loginVerifyOtp = async (req: Request, res: Response): Promise<void> => {
  const { phone, otp } = req.body as z.infer<typeof LoginVerifyOtpSchema>;
  const result = await authService.loginVerifyOtp(phone, otp);

  sendSuccess({
    res,
    statusCode: 200,
    message: 'Login successful',
    data: {
      coupleId: result.coupleId,
      accessToken: result.token.accessToken,
      refreshToken: result.token.refreshToken,
      profile: result.profile,
      user: result.user,
    },
  });
};

/**
 * POST /api/v1/auth/logout
 * Protected. Revokes refresh token.
 */
export const logout = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) {
    throw new AppError('Unauthorized', 401);
  }

  // jti + exp of the token that made THIS call (attached by `authenticate`)
  // let the service denylist the presented token, alongside the per-user
  // revocation watermark that kills the user's other outstanding tokens.
  await authService.logout(req.user.userId, req.accessToken?.jti, req.accessToken?.exp);

  sendSuccess({ res, message: 'Logged out successfully' });
};

/**
 * POST /api/v1/auth/resend-otp
 * Body: { phone }
 *
 * Resends OTP for ONE phone only, reusing the existing coupleId.
 * Partner's OTP is NOT affected — safe to call independently per number.
 */
export const resendOtp = async (req: Request, res: Response): Promise<void> => {
  const schema = z.object({
    phone: z.string().min(10).max(15).regex(/^\d+$/, 'Phone must contain only digits'),
  });
  const { phone } = schema.parse(req.body);
  await authService.resendOtp(phone, req.ip);
  sendSuccess({ res, statusCode: 200, message: 'OTP resent' });
};

/**
 * POST /api/v1/auth/invite-partner
 * Body: { partnerPhone }
 */
export const invitePartner = async (req: Request, res: Response): Promise<void> => {
  // Unauthenticated by design (called during onboarding before the partner has an
  // account), so validate/normalize strictly before it ever reaches Twilio.
  // Per-IP rate limiting is applied at the route to bound SMS cost abuse.
  const schema = z.object({
    partnerPhone: z
      .string()
      .min(10, 'Partner phone must be at least 10 digits')
      .max(15, 'Partner phone too long')
      .regex(/^\d+$/, 'Partner phone must contain only digits'),
  });
  const { partnerPhone } = schema.parse(req.body);

  await authService.sendPartnerInvite(partnerPhone, req.ip);

  sendSuccess({
    res,
    statusCode: 200,
    message: 'Invitation sent to partner',
  });
};
