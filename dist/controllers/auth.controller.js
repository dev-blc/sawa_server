"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invitePartner = exports.resendOtp = exports.logout = exports.loginVerifyOtp = exports.loginSendOtp = exports.refreshToken = exports.verifyOtp = exports.sendOtp = exports.validateLoginVerifyOtp = exports.validateLoginSendOtp = exports.validateRefresh = exports.validateVerifyOtp = exports.validateSendOtp = void 0;
const zod_1 = require("zod");
const auth_service_1 = require("../services/auth.service");
const response_1 = require("../utils/response");
const AppError_1 = require("../utils/AppError");
const validate_1 = require("../middleware/validate");
// ─── Schemas ────────────────────────────────────────────────────────────────
const SendOtpSchema = zod_1.z.object({
    yourPhone: zod_1.z
        .string()
        .min(10, 'Phone must be at least 10 digits')
        .max(15, 'Phone too long')
        .regex(/^\d+$/, 'Phone must contain only digits'),
    partnerPhone: zod_1.z
        .string()
        .min(10, 'Partner phone must be at least 10 digits')
        .max(15, 'Partner phone too long')
        .regex(/^\d+$/, 'Partner phone must contain only digits'),
});
const VerifyOtpSchema = zod_1.z.object({
    yourPhone: zod_1.z.string().min(10).max(15).regex(/^\d+$/),
    yourOtp: zod_1.z
        .string()
        .length(4, 'OTP must be 4 digits')
        .regex(/^\d+$/, 'OTP must be numeric'),
    partnerPhone: zod_1.z.string().min(10).max(15).regex(/^\d+$/),
    partnerOtp: zod_1.z
        .string()
        .length(4, 'Partner OTP must be 4 digits')
        .regex(/^\d+$/, 'OTP must be numeric'),
});
const RefreshSchema = zod_1.z.object({
    refreshToken: zod_1.z.string().min(1, 'Refresh token is required'),
});
const LoginSendOtpSchema = zod_1.z.object({
    phone: zod_1.z.string().min(10).max(15).regex(/^\d+$/),
});
const LoginVerifyOtpSchema = zod_1.z.object({
    phone: zod_1.z.string().min(10).max(15).regex(/^\d+$/),
    otp: zod_1.z.string().length(4).regex(/^\d+$/),
});
// ─── Validation Middleware (exported so routes can use them) ─────────────────
exports.validateSendOtp = (0, validate_1.validate)(SendOtpSchema);
exports.validateVerifyOtp = (0, validate_1.validate)(VerifyOtpSchema);
exports.validateRefresh = (0, validate_1.validate)(RefreshSchema);
exports.validateLoginSendOtp = (0, validate_1.validate)(LoginSendOtpSchema);
exports.validateLoginVerifyOtp = (0, validate_1.validate)(LoginVerifyOtpSchema);
// ─── Controllers ────────────────────────────────────────────────────────────
/**
 * POST /api/v1/auth/send-otp
 * Body: { yourPhone, partnerPhone }
 *
 * Creates/finds a shared coupleId for both phones.
 * Sends real OTPs via Twilio to both numbers.
 */
const sendOtp = async (req, res) => {
    const { yourPhone, partnerPhone } = req.body;
    const result = await auth_service_1.authService.sendOtp(yourPhone, partnerPhone);
    (0, response_1.sendSuccess)({
        res,
        statusCode: 200,
        message: 'OTP sent to both numbers',
        data: { coupleId: result.coupleId },
    });
};
exports.sendOtp = sendOtp;
/**
 * POST /api/v1/auth/verify-otp
 * Body: { yourPhone, yourOtp, partnerPhone, partnerOtp }
 *
 * Verifies both OTPs via Twilio. Returns JWT token pair for the primary user.
 */
const verifyOtp = async (req, res) => {
    const { yourPhone, yourOtp, partnerPhone, partnerOtp } = req.body;
    const result = await auth_service_1.authService.verifyOtp(yourPhone, yourOtp, partnerPhone, partnerOtp);
    (0, response_1.sendSuccess)({
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
exports.verifyOtp = verifyOtp;
/**
 * POST /api/v1/auth/refresh
 * Body: { refreshToken }
 */
const refreshToken = async (req, res) => {
    const { refreshToken: token } = req.body;
    const result = await auth_service_1.authService.refreshAccessToken(token);
    (0, response_1.sendSuccess)({
        res,
        data: { accessToken: result.accessToken, refreshToken: result.refreshToken },
        message: 'Token refreshed',
    });
};
exports.refreshToken = refreshToken;
/**
 * POST /api/v1/auth/login-send-otp
 * Body: { phone }
 */
const loginSendOtp = async (req, res) => {
    const { phone } = req.body;
    const result = await auth_service_1.authService.loginSendOtp(phone);
    // Bypass accounts: return tokens immediately so the client can skip the OTP screen
    if (result.bypass) {
        (0, response_1.sendSuccess)({
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
    (0, response_1.sendSuccess)({
        res,
        statusCode: 200,
        message: 'Login OTP sent',
        data: { coupleId: result.coupleId },
    });
};
exports.loginSendOtp = loginSendOtp;
/**
 * POST /api/v1/auth/login-verify-otp
 * Body: { phone, otp }
 */
const loginVerifyOtp = async (req, res) => {
    const { phone, otp } = req.body;
    const result = await auth_service_1.authService.loginVerifyOtp(phone, otp);
    (0, response_1.sendSuccess)({
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
exports.loginVerifyOtp = loginVerifyOtp;
/**
 * POST /api/v1/auth/logout
 * Protected. Revokes refresh token.
 */
const logout = async (req, res) => {
    if (!req.user) {
        throw new AppError_1.AppError('Unauthorized', 401);
    }
    await auth_service_1.authService.logout(req.user.userId);
    (0, response_1.sendSuccess)({ res, message: 'Logged out successfully' });
};
exports.logout = logout;
/**
 * POST /api/v1/auth/resend-otp
 * Body: { phone }
 *
 * Resends OTP for ONE phone only, reusing the existing coupleId.
 * Partner's OTP is NOT affected — safe to call independently per number.
 */
const resendOtp = async (req, res) => {
    const schema = zod_1.z.object({
        phone: zod_1.z.string().min(10).max(15).regex(/^\d+$/, 'Phone must contain only digits'),
    });
    const { phone } = schema.parse(req.body);
    await auth_service_1.authService.resendOtp(phone);
    (0, response_1.sendSuccess)({ res, statusCode: 200, message: 'OTP resent' });
};
exports.resendOtp = resendOtp;
/**
 * POST /api/v1/auth/invite-partner
 * Body: { partnerPhone }
 */
const invitePartner = async (req, res) => {
    // Unauthenticated by design (called during onboarding before the partner has an
    // account), so validate/normalize strictly before it ever reaches Twilio.
    // Per-IP rate limiting is applied at the route to bound SMS cost abuse.
    const schema = zod_1.z.object({
        partnerPhone: zod_1.z
            .string()
            .min(10, 'Partner phone must be at least 10 digits')
            .max(15, 'Partner phone too long')
            .regex(/^\d+$/, 'Partner phone must contain only digits'),
    });
    const { partnerPhone } = schema.parse(req.body);
    await auth_service_1.authService.sendPartnerInvite(partnerPhone);
    (0, response_1.sendSuccess)({
        res,
        statusCode: 200,
        message: 'Invitation sent to partner',
    });
};
exports.invitePartner = invitePartner;
//# sourceMappingURL=auth.controller.js.map