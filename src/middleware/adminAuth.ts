import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { verifyAccessToken } from '../utils/jwt';
import { AppError } from '../utils/AppError';

declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        coupleMongoId?: string;
        coupleId?: string;
        userName?: string;
        role?: string;
      };
    }
  }
}

/**
 * Middleware: Validates JWT Bearer token and checks if the user has an 'admin' role.
 */
export const adminAuth = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new AppError('Authorization header missing', 401, 'UNAUTHORIZED'));
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return next(new AppError('Token missing', 401, 'UNAUTHORIZED'));
    }

    const payload = verifyAccessToken(token);
    
    // For admin actions, we MUST verify the role from the database to ensure security.
    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    
    if (!user || user.role !== 'admin') {
      return next(new AppError('Access denied. Admins only.', 403, 'FORBIDDEN'));
    }

    req.user = { 
      userId: payload.userId, 
      coupleId: user.coupleId || undefined,
      role: user.role
    };

    next();
  } catch (err: any) {
    console.error(`[Admin Auth Error] ${err.message}`);
    next(new AppError('Administrative authentication failed', 401, 'UNAUTHORIZED'));
  }
};
