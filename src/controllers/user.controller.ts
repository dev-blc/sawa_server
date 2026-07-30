import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import { isPushEnabled, pushToUser } from '../services/push.service';

/**
 * GET /api/v1/users/me
 */
export const getMe = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const user = await prisma.user.findUnique({ 
    where: { id: req.user.userId },
    select: { id: true, name: true, phone: true, email: true, dob: true, role: true, coupleId: true }
  });
  if (!user) throw new AppError('User not found', 404);
  sendSuccess({ res, data: { user: { ...user, _id: user.id } } });
};

/**
 * PATCH /api/v1/users/me
 */
export const updateMe = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  // TODO Phase 2: validate body, update User document
  sendSuccess({ res, message: 'User updated [stub]' });
};

/**
 * POST /api/v1/users/me/push-token
 * Register or update the FCM token for the authenticated user's device.
 *
 * Body: { token: string; platform: 'ios' | 'android' }
 *
 * The mobile app calls this:
 *   - On every successful login (token can change between sessions).
 *   - When FCM rotates the token (`onTokenRefresh`).
 *
 * Sending an empty/null token clears the registration (e.g. on logout).
 */
export const registerPushToken = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);

  const { token, platform, locale } = req.body || {};
  if (token !== null && token !== undefined && typeof token !== 'string') {
    throw new AppError('token must be a string or null', 400, 'INVALID_TOKEN');
  }
  if (platform && platform !== 'ios' && platform !== 'android') {
    throw new AppError('platform must be "ios" or "android"', 400, 'INVALID_PLATFORM');
  }
  // Persist the app language so server-sent push/APNs text is localized to the
  // recipient. Only accept the languages the app actually ships.
  const allowedLocales = ['en', 'hi', 'kn', 'mr'];
  const preferredLocale =
    typeof locale === 'string' && allowedLocales.includes(locale) ? locale : undefined;

  // If the same token is already registered to a different user (e.g. shared
  // device, account switch), clear it from the old user so we don't push to
  // them by mistake.
  if (token) {
    await prisma.user.updateMany({
      where: { pushToken: token, NOT: { id: req.user.userId } },
      data: { pushToken: null, pushPlatform: null },
    });
  }

  await prisma.user.update({
    where: { id: req.user.userId },
    data: {
      pushToken: token || null,
      pushPlatform: token ? platform || null : null,
      ...(preferredLocale ? { preferredLocale } : {}),
    },
  });

  logger.info(
    `[Push] Token ${token ? 'saved' : 'cleared'} for user ${req.user.userId} (${platform || 'unknown platform'})`,
  );

  sendSuccess({ res, message: 'Push token registered' });
};

/**
 * GET /api/v1/users/me/push-status
 * Diagnostic: returns whether this user has a push token saved + server push state.
 * Safe to call from the app or via curl to debug push delivery.
 */
export const getPushStatus = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);

  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { id: true, pushToken: true, pushPlatform: true, coupleId: true },
  });

  if (!user) throw new AppError('User not found', 404);

  // Also get partner's status so both can be checked in one call
  let partner: { id: string; pushToken: string | null; pushPlatform: string | null } | null = null;
  if (user.coupleId) {
    partner = await prisma.user.findFirst({
      where: { coupleId: user.coupleId, NOT: { id: user.id } },
      select: { id: true, pushToken: true, pushPlatform: true },
    }) ?? null;
  }

  sendSuccess({
    res,
    data: {
      serverPushEnabled: isPushEnabled(),
      you: {
        userId: user.id,
        tokenSaved: !!user.pushToken,
        // Show only last 10 chars for security
        tokenPreview: user.pushToken ? `...${user.pushToken.slice(-10)}` : null,
        platform: user.pushPlatform,
      },
      partner: partner
        ? {
            userId: partner.id,
            tokenSaved: !!partner.pushToken,
            tokenPreview: partner.pushToken ? `...${partner.pushToken.slice(-10)}` : null,
            platform: partner.pushPlatform,
          }
        : null,
    },
  });
};

/**
 * POST /api/v1/users/me/test-push
 * Sends a real push to yourself AND your partner via the same code path
 * used by the app (pushToUser). Use to verify the server → FCM → device
 * chain without needing a socket event.
 */
export const testPush = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  if (!isPushEnabled()) throw new AppError('Push not enabled on server', 503);

  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { id: true, name: true, coupleId: true },
  });
  if (!user) throw new AppError('User not found', 404);

  const results: Record<string, unknown> = {};

  // Push to self
  const selfResult = await pushToUser(user.id, {
    title: 'SAWA Server Test',
    body: 'Server → FCM path is working ✓',
    data: { navigate: 'Notifications', source: 'test-push' },
  });
  results.self = selfResult;

  // Push to partner
  if (user.coupleId) {
    const partner = await prisma.user.findFirst({
      where: { coupleId: user.coupleId, NOT: { id: user.id } },
      select: { id: true },
    });
    if (partner) {
      const partnerResult = await pushToUser(partner.id, {
        title: `Message from ${user.name || 'Your partner'} 💛`,
        body: 'Server push test — tap to open',
        data: { navigate: 'Notifications', source: 'test-push' },
      });
      results.partner = partnerResult;
    }
  }

  logger.info(`[Push] test-push triggered by ${user.id}: ${JSON.stringify(results)}`);
  sendSuccess({ res, data: { results } });
};
