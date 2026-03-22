import { Router } from 'express';
import { AdminController } from '../controllers/admin.controller';

import { adminAuth } from '../middleware/adminAuth';

const router = Router();
const controller = new AdminController();

// Public admin login
router.post('/login', controller.adminLogin);

// Protected admin routes
router.use(adminAuth);

router.get('/data', controller.getDashboardData);
router.post('/prompts', controller.addPrompt);
router.patch('/prompts/:id/toggle', controller.togglePrompt);
router.delete('/prompts/:id', controller.deletePrompt);
router.delete('/users/:id', controller.deleteUser);
router.delete('/communities/:id', controller.deleteCommunity);
router.post('/notifications', controller.sendNotification);

export default router;
