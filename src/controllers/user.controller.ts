import { Request, Response } from 'express';
import { User } from '../models/User.model';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/AppError';

/**
 * GET /api/v1/users/me
 */
export const getMe = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const user = await User.findById(req.user.userId).select('name phone email dob role coupleId');
  if (!user) throw new AppError('User not found', 404);
  sendSuccess({ res, data: { user } });
};

/**
 * PATCH /api/v1/users/me
 */
export const updateMe = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  // TODO Phase 2: validate body, update User document
  sendSuccess({ res, message: 'User updated [stub]' });
};
