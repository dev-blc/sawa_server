import request from 'supertest';
import express from 'express';

jest.mock('../middleware/authenticate', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { userId: 'user-1', coupleId: 'couple-1' };
    next();
  },
}));

jest.mock('../lib/prisma', () => ({
  prisma: {
    notification: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    match: { findMany: jest.fn() },
  },
}));

// realtime pulls in push.service (firebase-admin) and the WhatsApp mirror —
// none of that belongs in a route test.
jest.mock('../utils/realtime', () => ({
  emitRealtimeNotification: jest.fn(),
}));

jest.mock('../lib/cache', () => ({
  getCachedNotifUnreadCount: jest.fn().mockResolvedValue(null),
  setCachedNotifUnreadCount: jest.fn().mockResolvedValue(undefined),
  invalidateNotifUnreadCount: jest.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../lib/prisma';
import {
  getCachedNotifUnreadCount,
  setCachedNotifUnreadCount,
  invalidateNotifUnreadCount,
} from '../lib/cache';
import notificationRoutes from '../routes/notification.routes';
import { errorHandler } from '../middleware/errorHandler';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/notifications', notificationRoutes);
  app.use(errorHandler);
  return app;
};

describe('notification routes', () => {
  const app = buildApp();

  beforeEach(() => {
    jest.clearAllMocks();
    (getCachedNotifUnreadCount as jest.Mock).mockResolvedValue(null);
  });

  describe('GET /notifications', () => {
    it('excludes cleared and self-sent rows in the query', async () => {
      (prisma.notification.findMany as jest.Mock).mockResolvedValue([]);

      const res = await request(app).get('/notifications').expect(200);

      expect(res.body.success).toBe(true);
      const where = (prisma.notification.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.recipientId).toBe('couple-1');
      expect(where.clearedAt).toBeNull();
      expect(where.NOT).toEqual({ data: { path: ['senderUserId'], equals: 'user-1' } });
    });
  });

  describe('DELETE /notifications/:id', () => {
    it('soft-clears only the caller couple’s row (IDOR scope) and busts the badge cache', async () => {
      (prisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      const res = await request(app).delete('/notifications/notif-1').expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.cleared).toBe(1);
      const call = (prisma.notification.updateMany as jest.Mock).mock.calls[0][0];
      expect(call.where).toMatchObject({ id: 'notif-1', recipientId: 'couple-1', clearedAt: null });
      expect(call.data.clearedAt).toBeInstanceOf(Date);
      expect(call.data.read).toBe(true);
      expect(invalidateNotifUnreadCount).toHaveBeenCalledWith('couple-1');
    });

    it('is idempotent — clearing an unknown id succeeds with cleared: 0 and no cache bust', async () => {
      (prisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      const res = await request(app).delete('/notifications/unknown-id').expect(200);

      expect(res.body.data.cleared).toBe(0);
      expect(invalidateNotifUnreadCount).not.toHaveBeenCalled();
    });

    it('rejects a malformed id with 400 before touching the database', async () => {
      const res = await request(app).delete('/notifications/bad%20id%21').expect(400);

      expect(res.body.success).toBe(false);
      expect(prisma.notification.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /notifications', () => {
    it('soft-clears every visible row for the couple', async () => {
      (prisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 7 });

      const res = await request(app).delete('/notifications').expect(200);

      expect(res.body.data.cleared).toBe(7);
      const call = (prisma.notification.updateMany as jest.Mock).mock.calls[0][0];
      expect(call.where).toMatchObject({ recipientId: 'couple-1', clearedAt: null });
      expect(call.data.clearedAt).toBeInstanceOf(Date);
      expect(invalidateNotifUnreadCount).toHaveBeenCalledWith('couple-1');
    });
  });

  describe('GET /notifications/unread-count', () => {
    it('counts only unread, uncleared, not-self-sent rows and caches per user', async () => {
      (prisma.notification.count as jest.Mock).mockResolvedValue(3);

      const res = await request(app).get('/notifications/unread-count').expect(200);

      expect(res.body.data.count).toBe(3);
      const where = (prisma.notification.count as jest.Mock).mock.calls[0][0].where;
      expect(where).toMatchObject({ recipientId: 'couple-1', read: false, clearedAt: null });
      expect(where.NOT).toEqual({ data: { path: ['senderUserId'], equals: 'user-1' } });
      expect(setCachedNotifUnreadCount).toHaveBeenCalledWith('couple-1', 'user-1', 3);
    });

    it('serves the per-user cached value without querying', async () => {
      (getCachedNotifUnreadCount as jest.Mock).mockResolvedValue(5);

      const res = await request(app).get('/notifications/unread-count').expect(200);

      expect(res.body.data.count).toBe(5);
      expect(getCachedNotifUnreadCount).toHaveBeenCalledWith('couple-1', 'user-1');
      expect(prisma.notification.count).not.toHaveBeenCalled();
    });
  });
});
