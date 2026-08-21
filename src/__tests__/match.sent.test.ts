import { MatchService } from '../services/match.service';

// Pure-logic tests for the sent-requests mirror and the connections summary
// (the Couples-tab "My Connections" card). No DB — prisma is stubbed.
jest.mock('../lib/prisma', () => ({
  prisma: {
    couple: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
    match: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
    notification: { create: jest.fn() },
  },
}));

import { prisma } from '../lib/prisma';

const svc = new MatchService();

const ME = { id: 'me-id', coupleId: 'me-couple', locationCity: 'Goa', locationLatitude: null, locationLongitude: null };
const other = (n: string) => ({
  id: `${n}-id`, coupleId: `${n}-couple`, profileName: `${n} & partner`,
  primaryPhoto: null, locationCity: 'Goa', locationLatitude: null, locationLongitude: null,
});

/** couple.findUnique is called twice (me, then my blocked list) — serve both. */
const stubMe = (blocked: string[] = []) => {
  (prisma.couple.findUnique as jest.Mock)
    .mockResolvedValueOnce(ME)
    .mockResolvedValueOnce({ blocked });
};

describe('MatchService.getSentRequests', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns only MY pending hellos, shaped like the incoming cards', async () => {
    stubMe();
    (prisma.match.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'm1', couple1Id: 'me-couple', couple2Id: 'a-couple',
        createdAt: new Date('2026-08-20T10:00:00Z'),
        couple1: { ...other('me'), coupleId: 'me-couple' }, couple2: other('a'),
      },
    ]);

    const out = await svc.getSentRequests('me-couple');

    expect(prisma.match.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'pending', actionById: 'me-couple' }),
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      _id: 'm1',
      coupleId: 'a-couple',
      profileName: 'a & partner',
      status: 'pending',
    });
  });

  it('filters couples I have blocked (legacy /couples/blocks rows survive)', async () => {
    stubMe(['a-couple']);
    (prisma.match.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'm1', couple1Id: 'me-couple', couple2Id: 'a-couple',
        createdAt: new Date(), couple1: null, couple2: other('a'),
      },
      {
        id: 'm2', couple1Id: 'me-couple', couple2Id: 'b-couple',
        createdAt: new Date(), couple1: null, couple2: other('b'),
      },
    ]);

    const out = await svc.getSentRequests('me-couple');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ coupleId: 'b-couple' });
  });
});

describe('MatchService.getConnectionsSummary', () => {
  beforeEach(() => jest.clearAllMocks());

  it('splits pending rows by direction and counts accepted as connected', async () => {
    stubMe();
    (prisma.match.findMany as jest.Mock).mockResolvedValue([
      // I said hello → sent
      { couple1Id: 'me-couple', couple2Id: 'a-couple', actionById: 'me-couple', status: 'pending',
        couple1: { id: 'me-id', coupleId: 'me-couple' }, couple2: { id: 'a-id', coupleId: 'a-couple' } },
      // They said hello → incoming
      { couple1Id: 'b-couple', couple2Id: 'me-couple', actionById: 'b-couple', status: 'pending',
        couple1: { id: 'b-id', coupleId: 'b-couple' }, couple2: { id: 'me-id', coupleId: 'me-couple' } },
      // Connected
      { couple1Id: 'me-couple', couple2Id: 'c-couple', actionById: 'me-couple', status: 'accepted',
        couple1: { id: 'me-id', coupleId: 'me-couple' }, couple2: { id: 'c-id', coupleId: 'c-couple' } },
    ]);

    const out = await svc.getConnectionsSummary('me-couple');
    expect(out).toEqual({ incoming: 1, sent: 1, connected: 1 });
  });

  it('never counts a blocked couple — the badge must agree with the list', async () => {
    stubMe(['c-couple']);
    (prisma.match.findMany as jest.Mock).mockResolvedValue([
      { couple1Id: 'me-couple', couple2Id: 'c-couple', actionById: 'me-couple', status: 'accepted',
        couple1: { id: 'me-id', coupleId: 'me-couple' }, couple2: { id: 'c-id', coupleId: 'c-couple' } },
    ]);

    const out = await svc.getConnectionsSummary('me-couple');
    expect(out).toEqual({ incoming: 0, sent: 0, connected: 0 });
  });
});
