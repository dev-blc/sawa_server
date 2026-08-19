import { MatchService } from '../services/match.service';

// Mock the Prisma client — these tests exercise the bidirectional-block guard
// (v3 M2) in pure logic, no DB. Only the reads the guard reaches are stubbed;
// a blocked pair must throw BEFORE any match row is written.
jest.mock('../lib/prisma', () => ({
  prisma: {
    couple: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
    match: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
    notification: { create: jest.fn() },
  },
}));

import { prisma } from '../lib/prisma';

const svc = new MatchService();

const coupleRow = (over: Record<string, unknown>) => ({
  id: 'x-id',
  coupleId: 'x-couple',
  profileName: 'X & Y',
  primaryPhoto: null,
  locationCity: 'Goa',
  locationLatitude: null,
  locationLongitude: null,
  bio: null,
  activities: [],
  socialVibes: [],
  matchCriteria: [],
  blocked: [],
  answers: [],
  ...over,
});

describe('MatchService bidirectional block (v3 M2)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('sayHello', () => {
    it('rejects (403 BLOCKED) when the TARGET couple has blocked the requester', async () => {
      (prisma.couple.findUnique as jest.Mock).mockResolvedValue(
        coupleRow({ id: 'me-id', coupleId: 'me-couple', blocked: [] }),
      );
      (prisma.couple.findFirst as jest.Mock).mockResolvedValue(
        coupleRow({ id: 'target-id', coupleId: 'target-couple', blocked: ['me-couple'] }),
      );

      await expect(svc.sayHello('me-couple', 'target-couple')).rejects.toMatchObject({
        statusCode: 403,
        code: 'BLOCKED',
      });
      // A blocked pair must never create a Match row.
      expect(prisma.match.create).not.toHaveBeenCalled();
    });

    it('rejects (403 BLOCKED) when the REQUESTER has blocked the target', async () => {
      (prisma.couple.findUnique as jest.Mock).mockResolvedValue(
        coupleRow({ id: 'me-id', coupleId: 'me-couple', blocked: ['target-couple'] }),
      );
      (prisma.couple.findFirst as jest.Mock).mockResolvedValue(
        coupleRow({ id: 'target-id', coupleId: 'target-couple', blocked: [] }),
      );

      await expect(svc.sayHello('me-couple', 'target-couple')).rejects.toMatchObject({
        statusCode: 403,
        code: 'BLOCKED',
      });
      expect(prisma.match.create).not.toHaveBeenCalled();
    });

    it('uses one neutral message that does not leak the block direction', async () => {
      (prisma.couple.findUnique as jest.Mock).mockResolvedValue(
        coupleRow({ id: 'me-id', coupleId: 'me-couple', blocked: [] }),
      );
      (prisma.couple.findFirst as jest.Mock).mockResolvedValue(
        coupleRow({ id: 'target-id', coupleId: 'target-couple', blocked: ['me-couple'] }),
      );

      await expect(svc.sayHello('me-couple', 'target-couple')).rejects.toThrow(
        'This connection is not available',
      );
    });
  });

  describe('getDiscoveryFeed', () => {
    it("excludes couples whose blocked[] contains the requester via NOT { blocked: { has } }", async () => {
      (prisma.couple.findUnique as jest.Mock).mockResolvedValue(
        coupleRow({ id: 'me-id', coupleId: 'me-couple', partner1Id: null, partner2Id: null, blocked: [] }),
      );
      (prisma.match.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.couple.findMany as jest.Mock).mockResolvedValue([]);

      const feed = await svc.getDiscoveryFeed('me-couple');
      expect(feed).toEqual([]);

      const whereArg = (prisma.couple.findMany as jest.Mock).mock.calls[0][0].where;
      // The GIN-indexed bidirectional exclusion (schema: @@index([blocked], type: Gin)).
      expect(whereArg.NOT).toEqual({ blocked: { has: 'me-couple' } });
    });
  });
});
