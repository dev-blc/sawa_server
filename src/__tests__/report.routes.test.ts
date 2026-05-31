import request from 'supertest';
import express from 'express';
import reportRoutes from '../routes/report.routes';

jest.mock('../middleware/authenticate', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user: { coupleId: string } }).user = { coupleId: 'reporter-couple' };
    next();
  },
}));

jest.mock('../lib/prisma', () => ({
  prisma: {
    report: { create: jest.fn() },
    couple: { update: jest.fn() },
    community: { findUnique: jest.fn() },
    communityMember: { deleteMany: jest.fn() },
  },
}));

import { prisma } from '../lib/prisma';

describe('POST /reports', () => {
  const app = express();
  app.use(express.json());
  app.use('/reports', reportRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 400 when targetId or reason is missing', async () => {
    const res = await request(app).post('/reports').send({ reason: 'spam' }).expect(400);

    expect(res.body.success).toBe(false);
  });

  it('creates report, blocks target, and leaves community when target is a community', async () => {
    (prisma.report.create as jest.Mock).mockResolvedValue({
      id: 'report-1',
      reporterId: 'reporter-couple',
      targetId: 'comm-1',
      reason: 'harassment',
      details: '',
      status: 'pending',
    });
    (prisma.community.findUnique as jest.Mock).mockResolvedValue({ id: 'comm-1' });
    (prisma.couple.update as jest.Mock).mockResolvedValue({});
    (prisma.communityMember.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

    const res = await request(app)
      .post('/reports')
      .send({ targetId: 'comm-1', reason: 'harassment' })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(prisma.couple.update).toHaveBeenCalledWith({
      where: { coupleId: 'reporter-couple' },
      data: { blocked: { push: 'comm-1' } },
    });
    expect(prisma.communityMember.deleteMany).toHaveBeenCalledWith({
      where: { communityId: 'comm-1', coupleId: 'reporter-couple' },
    });
  });
});
