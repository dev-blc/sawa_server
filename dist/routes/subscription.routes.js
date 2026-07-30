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
// Public — Apple calls this (payload is cryptographically signed & verified).
router.post('/apple/notifications', subscription_controller_1.appleNotifications);
exports.default = router;
//# sourceMappingURL=subscription.routes.js.map