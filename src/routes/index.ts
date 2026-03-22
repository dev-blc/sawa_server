import { Router } from 'express';
import authRoutes from './auth.routes';
import userRoutes from './user.routes';
import coupleRoutes from './couple.routes';
import matchRoutes from './match.routes';
import communityRoutes from './community.routes';
import chatRoutes from './chat.routes';
import notificationRoutes from './notification.routes';
import adminRoutes from './admin.routes';
import promptRoutes from './prompt.routes';
import reportRoutes from './report.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/couples', coupleRoutes);
router.use('/matches', matchRoutes);
router.use('/communities', communityRoutes);
router.use('/chats', chatRoutes);
router.use('/notifications', notificationRoutes);
router.use('/admin', adminRoutes);
router.use('/prompts', promptRoutes);
router.use('/reports', reportRoutes);

export default router;
