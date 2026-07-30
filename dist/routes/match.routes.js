"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../middleware/authenticate");
const requireEntitlement_1 = require("../middleware/requireEntitlement");
const asyncHandler_1 = require("../utils/asyncHandler");
const match_controller_1 = require("../controllers/match.controller");
const router = (0, express_1.Router)();
router.use(authenticate_1.authenticate);
// GET /api/v1/matches/discovery -> gets discovery feed
router.get('/discovery', (0, asyncHandler_1.asyncHandler)(match_controller_1.getDiscoveryFeed));
// POST /api/v1/matches/say-hello — counts toward the discovery quota
router.post('/say-hello', match_controller_1.validateMatchAction, (0, requireEntitlement_1.requireEntitlement)({ gate: 'connection' }), (0, asyncHandler_1.asyncHandler)(match_controller_1.sayHello));
// POST /api/v1/matches/skip — a skip ALSO counts toward the quota
router.post('/skip', match_controller_1.validateMatchAction, (0, requireEntitlement_1.requireEntitlement)({ gate: 'connection' }), (0, asyncHandler_1.asyncHandler)(match_controller_1.skipCouple));
// POST /api/v1/matches/refresh-discovery
router.post('/refresh-discovery', (0, asyncHandler_1.asyncHandler)(match_controller_1.refreshDiscovery));
// GET /api/v1/matches -> gets accepted connections
router.get('/', (0, asyncHandler_1.asyncHandler)(match_controller_1.getMatches));
// GET /api/v1/matches/incoming -> gets pending requests
router.get('/incoming', (0, asyncHandler_1.asyncHandler)(match_controller_1.getIncomingRequests));
// POST /api/v1/matches/accept -> accept a pending request
router.post('/accept', match_controller_1.validateMatchAction, (0, asyncHandler_1.asyncHandler)(match_controller_1.acceptMatch));
// POST /api/v1/matches/reject -> reject a pending request
router.post('/reject', match_controller_1.validateMatchAction, (0, asyncHandler_1.asyncHandler)(match_controller_1.rejectMatch));
// POST /api/v1/matches/block -> block a couple
router.post('/block', match_controller_1.validateMatchAction, (0, asyncHandler_1.asyncHandler)(match_controller_1.blockCouple));
// POST /api/v1/matches/unfriend -> remove connection (can say-hello again to reconnect)
router.post('/unfriend', match_controller_1.validateMatchAction, (0, asyncHandler_1.asyncHandler)(match_controller_1.unfriendCouple));
// GET /api/v1/matches/insights/:coupleId
router.get('/insights/:coupleId', (0, asyncHandler_1.asyncHandler)(match_controller_1.getInsights));
exports.default = router;
//# sourceMappingURL=match.routes.js.map