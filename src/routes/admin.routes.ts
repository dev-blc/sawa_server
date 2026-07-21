import { Router } from 'express';
import { AdminController } from '../controllers/admin.controller';

import { adminAuth } from '../middleware/adminAuth';

const router = Router();
const controller = new AdminController();

// Public admin login
router.post('/login', controller.adminLogin);

// Lazy media (couple photo / community cover). Self-authenticates via ?token=
// query param because <img> tags cannot send an Authorization header. Must be
// registered BEFORE the header-based adminAuth middleware.
router.get('/media/:kind/:id', controller.getMedia);

// Protected admin routes
router.use(adminAuth);

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
router.post(
  '/communities/:communityId/requests/:requestId/:decision',
  controller.processJoinRequestAsAdmin,
);
router.get('/blocks', controller.getBlocks);
router.delete('/blocks', controller.adminUnblock);
router.patch('/reports/:id', controller.resolveReport);
router.post('/notifications', controller.sendNotification);
router.post('/flush-database', controller.flushDatabase);

export default router;
