import { Request, Response, NextFunction } from 'express';
import { User } from '../models/User.model';
import { verifyAccessToken } from '../utils/jwt';
import { AppError } from '../utils/AppError';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        coupleId?: string;
        userName?: string;
      };
    }
  }
}

/**
 * Middleware: Validates JWT Bearer token and attaches user payload to req.user.
 * Add to any protected route.
 */
export const authenticate = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new AppError('Authorization header missing', 401, 'UNAUTHORIZED'));
  }

  const token = authHeader.split(' ')[1];

  if (!token) {
    return next(new AppError('Token missing', 401, 'UNAUTHORIZED'));
  }

  const payload = verifyAccessToken(token);
  
  // Set basic info from payload
  req.user = { userId: payload.userId, coupleId: payload.coupleId };

  // Fetch name asynchronously to attach if available
  const user = await User.findById(payload.userId).select('name');
  if (user) {
    req.user.userName = user.name;
  }

  next();
};
