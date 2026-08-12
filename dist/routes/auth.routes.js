"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const rateLimiter_1 = require("../middleware/rateLimiter");
const auth_controller_1 = require("../controllers/auth.controller");
const asyncHandler_1 = require("../utils/asyncHandler");
const authenticate_1 = require("../middleware/authenticate");
const router = (0, express_1.Router)();
// POST /api/v1/auth/send-otp
router.post('/send-otp', rateLimiter_1.authRateLimiter, auth_controller_1.validateSendOtp, (0, asyncHandler_1.asyncHandler)(auth_controller_1.sendOtp));
// POST /api/v1/auth/verify-otp
router.post('/verify-otp', rateLimiter_1.authRateLimiter, auth_controller_1.validateVerifyOtp, (0, asyncHandler_1.asyncHandler)(auth_controller_1.verifyOtp));
// POST /api/v1/auth/login-send-otp
router.post('/login-send-otp', rateLimiter_1.authRateLimiter, auth_controller_1.validateLoginSendOtp, (0, asyncHandler_1.asyncHandler)(auth_controller_1.loginSendOtp));
// POST /api/v1/auth/login-verify-otp
router.post('/login-verify-otp', rateLimiter_1.authRateLimiter, auth_controller_1.validateLoginVerifyOtp, (0, asyncHandler_1.asyncHandler)(auth_controller_1.loginVerifyOtp));
// POST /api/v1/auth/refresh
// Lenient limiter (shared mobile/carrier IPs refresh often) but still bounded.
router.post('/refresh', rateLimiter_1.apiRateLimiter, auth_controller_1.validateRefresh, (0, asyncHandler_1.asyncHandler)(auth_controller_1.refreshToken));
// POST /api/v1/auth/logout  (protected)
router.post('/logout', authenticate_1.authenticate, (0, asyncHandler_1.asyncHandler)(auth_controller_1.logout));
// POST /api/v1/auth/resend-otp  — resend for ONE phone only, reuses existing coupleId
router.post('/resend-otp', rateLimiter_1.authRateLimiter, (0, asyncHandler_1.asyncHandler)(auth_controller_1.resendOtp));
// POST /api/v1/auth/invite-partner — sends a Twilio SMS, so rate-limit per IP
// to prevent unauthenticated SMS flooding / cost abuse.
router.post('/invite-partner', rateLimiter_1.authRateLimiter, (0, asyncHandler_1.asyncHandler)(auth_controller_1.invitePartner));
exports.default = router;
//# sourceMappingURL=auth.routes.js.map