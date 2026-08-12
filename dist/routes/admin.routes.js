"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const admin_controller_1 = require("../controllers/admin.controller");
const adminAuth_1 = require("../middleware/adminAuth");
const rateLimiter_1 = require("../middleware/rateLimiter");
const router = (0, express_1.Router)();
const controller = new admin_controller_1.AdminController();
// Public admin login — rate-limited to throttle online password guessing.
router.post('/login', rateLimiter_1.authRateLimiter, controller.adminLogin);
// Lazy media (couple photo / community cover). Self-authenticates via ?token=
// query param because <img> tags cannot send an Authorization header. Must be
// registered BEFORE the header-based adminAuth middleware.
router.get('/media/:kind/:id', controller.getMedia);
// Protected admin routes
router.use(adminAuth_1.adminAuth);
router.get('/data', controller.getDashboardData);
router.post('/prompts', controller.addPrompt);
router.patch('/prompts/reorder', controller.reorderPrompts);
router.patch('/prompts/:id/toggle', controller.togglePrompt);
router.patch('/prompts/:id', controller.editPrompt);
router.delete('/prompts/:id', controller.deletePrompt);
router.delete('/users/:id', controller.deleteUser);
router.delete('/couples/:id', controller.deleteCouple);
router.post('/couples/:id/ban', controller.banCouple);
router.post('/couples/:id/unban', controller.unbanCouple);
router.delete('/communities/:id', controller.deleteCommunity);
router.post('/communities', controller.addCommunity);
router.patch('/communities/:id', controller.editCommunity);
router.post('/communities/:communityId/requests/:requestId/:decision', controller.processJoinRequestAsAdmin);
router.get('/blocks', controller.getBlocks);
router.delete('/blocks', controller.adminUnblock);
router.patch('/reports/:id', controller.resolveReport);
router.post('/notifications', controller.sendNotification);
router.post('/flush-database', controller.flushDatabase);
exports.default = router;
//# sourceMappingURL=admin.routes.js.map