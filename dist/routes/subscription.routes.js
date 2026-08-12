"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../middleware/authenticate");
const asyncHandler_1 = require("../utils/asyncHandler");
const subscription_controller_1 = require("../controllers/subscription.controller");
const router = (0, express_1.Router)();
// Authenticated — the app. asyncHandler forwards thrown errors to the global
// error handler; without it a throw (e.g. duplicate-receipt P2002, pool timeout,
// store error) would leave the request hanging → client retries → verify storms.
router.get('/me', authenticate_1.authenticate, (0, asyncHandler_1.asyncHandler)(subscription_controller_1.getMySubscription));
router.post('/trial', authenticate_1.authenticate, (0, asyncHandler_1.asyncHandler)(subscription_controller_1.startTrialHandler));
router.post('/apple/verify', authenticate_1.authenticate, (0, asyncHandler_1.asyncHandler)(subscription_controller_1.verifyApple));
router.post('/google/verify', authenticate_1.authenticate, (0, asyncHandler_1.asyncHandler)(subscription_controller_1.verifyGoogle));
// Public — the stores call these. Authenticity is guaranteed by re-verifying the
// purchase directly with Apple / Google (not by trusting the request body).
router.post('/apple/notifications', (0, asyncHandler_1.asyncHandler)(subscription_controller_1.appleNotifications));
router.post('/google/notifications', (0, asyncHandler_1.asyncHandler)(subscription_controller_1.googleNotifications));
exports.default = router;
//# sourceMappingURL=subscription.routes.js.map