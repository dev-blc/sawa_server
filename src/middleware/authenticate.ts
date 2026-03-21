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
        coupleMongoId?: string;
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
    
    // Set basic info from payload
    req.user = { 
      userId: payload.userId, 
      coupleId: payload.coupleId,
      coupleMongoId: payload.coupleMongoId
    };

    // DEBUG LOG
    console.log(`[Auth] Authenticated user ${payload.userId} for ${req.method} ${req.originalUrl || req.url}`);

    // Optimization: Do NOT fetch User from DB here. 
    // It's a blocking roundtrip on every single protected request.
    // req.user already contains IDs from the JWT.
    
    next();
  } catch (err: any) {
    console.error(`[Auth Error] Failed to authenticate: ${err.message}`);
    if (err instanceof AppError) {
      return next(err);
    }
    next(new AppError(err.message || 'Authentication failed', 401, 'UNAUTHORIZED'));
  }
};
