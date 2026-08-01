"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../middleware/authenticate");
const requireEntitlement_1 = require("../middleware/requireEntitlement");
const asyncHandler_1 = require("../utils/asyncHandler");
const community_controller_1 = require("../controllers/community.controller");
const router = (0, express_1.Router)();
router.use(authenticate_1.authenticate);
// GET /api/v1/communities
router.get('/', (0, asyncHandler_1.asyncHandler)(community_controller_1.getAllCommunities));
// GET /api/v1/communities/mine
router.get('/mine', (0, asyncHandler_1.asyncHandler)(community_controller_1.getMyCommunities));
// POST /api/v1/communities — creating a group requires a PAID plan (not trial)
router.post('/', community_controller_1.validateCreateCommunity, (0, requireEntitlement_1.requireEntitlement)({ gate: 'createGroup' }), (0, asyncHandler_1.asyncHandler)(community_controller_1.createCommunity));
// GET /api/v1/communities/:id
router.get('/:id', (0, asyncHandler_1.asyncHandler)(community_controller_1.getCommunityDetail));
// POST /api/v1/communities/:id/join — counts toward the group-join quota
router.post('/:id/join', community_controller_1.validateJoinCommunity, (0, requireEntitlement_1.requireEntitlement)({ gate: 'joinGroup' }), (0, asyncHandler_1.asyncHandler)(community_controller_1.joinCommunity));
// POST /api/v1/communities/:id/invite
router.post('/:id/invite', (0, asyncHandler_1.asyncHandler)(community_controller_1.inviteToCommunity));
// POST /api/v1/communities/:id/leave
router.post('/:id/leave', (0, asyncHandler_1.asyncHandler)(community_controller_1.leaveCommunity));
// PATCH /api/v1/communities/:id  — admin only: edit name, bio, image
router.patch('/:id', (0, asyncHandler_1.asyncHandler)(community_controller_1.updateCommunity));
// DELETE /api/v1/communities/:id
router.delete('/:id', (0, asyncHandler_1.asyncHandler)(community_controller_1.deleteCommunity));
// POST /api/v1/communities/:id/requests/:requestId/:decision
router.post('/:id/requests/:requestId/:decision', (0, asyncHandler_1.asyncHandler)(community_controller_1.processJoinRequest));
// GET /api/v1/communities/:id/inviteable
router.get('/:id/inviteable', (0, asyncHandler_1.asyncHandler)(community_controller_1.getInviteableCouples));
exports.default = router;
//# sourceMappingURL=community.routes.js.map