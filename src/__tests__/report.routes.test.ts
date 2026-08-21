import request from 'supertest';
import express from 'express';
import reportRoutes from '../routes/report.routes';

jest.mock('../middleware/authenticate', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    // Mirror the real Request augmentation (userId is required on req.user).
    req.user = { userId: 'reporter-user', coupleId: 'reporter-couple' };
    next();
  },
}));

jest.mock('../lib/prisma', () => ({
  prisma: {
    report: { create: jest.fn() },
    // The route resolves the target to its canonical coupleId (findFirst) and
    // reads the reporter's blocked list before pushing to it.
    couple: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    community: { findUnique: jest.fn() },
    communityMember: { findFirst: jest.fn() },
  },
}));

// Community exits now route through the REAL leave pipeline (admin handover,
// empty-group teardown, cache invalidation) instead of a raw row delete.
jest.mock('../services/community.service', () => ({
  communityService: { leaveCommunity: jest.fn().mockResolvedValue({ status: 'left' }) },
}));

import { prisma } from '../lib/prisma';
import { communityService } from '../services/community.service';

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
    // Target is a community, not a couple — the canonical-coupleId resolution misses.
    (prisma.couple.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.couple.findUnique as jest.Mock).mockResolvedValue({ blocked: [] });
    (prisma.couple.update as jest.Mock).mockResolvedValue({});
    (prisma.communityMember.findFirst as jest.Mock).mockResolvedValue({ communityId: 'comm-1' });

    const res = await request(app)
      .post('/reports')
      .send({ targetId: 'comm-1', reason: 'harassment' })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(prisma.couple.update).toHaveBeenCalledWith({
      where: { coupleId: 'reporter-couple' },
      data: { blocked: { push: 'comm-1' } },
    });
    expect(communityService.leaveCommunity).toHaveBeenCalledWith('reporter-couple', 'comm-1');
  });
});
