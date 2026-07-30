"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../middleware/authenticate");
const subscription_controller_1 = require("../controllers/subscription.controller");
const router = (0, express_1.Router)();
// Authenticated — the app.
router.get('/me', authenticate_1.authenticate, subscription_controller_1.getMySubscription);
router.post('/trial', authenticate_1.authenticate, subscription_controller_1.startTrialHandler);
router.post('/apple/verify', authenticate_1.authenticate, subscription_controller_1.verifyApple);
router.post('/google/verify', authenticate_1.authenticate, subscription_controller_1.verifyGoogle);
// Public — the stores call these. Authenticity is guaranteed by re-verifying the
// purchase directly with Apple / Google (not by trusting the request body).
router.post('/apple/notifications', subscription_controller_1.appleNotifications);
router.post('/google/notifications', subscription_controller_1.googleNotifications);
exports.default = router;
//# sourceMappingURL=subscription.routes.js.map