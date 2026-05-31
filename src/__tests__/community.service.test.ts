import { CommunityService } from '../services/community.service';
import { AppError } from '../utils/AppError';

jest.mock('../lib/prisma', () => ({
  prisma: {
    couple: { findUnique: jest.fn() },
    community: { create: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
    communityMember: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    communityAdmin: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    communityJoinRequest: { findUnique: jest.fn(), deleteMany: jest.fn() },
    notification: { findFirst: jest.fn(), deleteMany: jest.fn(), create: jest.fn() },
    message: { deleteMany: jest.fn() },
    match: { findFirst: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

jest.mock('../utils/realtime', () => ({
  emitRealtimeNotification: jest.fn(),
}));

import { prisma } from '../lib/prisma';

const service = new CommunityService();
const COUPLE_ID = 'couple-uuid-1';
const COMMUNITY_ID = 'community-uuid-1';

describe('CommunityService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('leaveCommunity', () => {
    it('removes membership and returns left when other members remain', async () => {
      (prisma.couple.findUnique as jest.Mock).mockResolvedValue({ coupleId: COUPLE_ID });
      (prisma.communityMember.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.communityAdmin.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
      (prisma.notification.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
      (prisma.communityAdmin.findMany as jest.Mock).mockResolvedValue([{ coupleId: 'other-admin' }]);
      (prisma.communityMember.findMany as jest.Mock).mockResolvedValue([
        { coupleId: 'other-member' },
      ]);

      const result = await service.leaveCommunity(COUPLE_ID, COMMUNITY_ID);

      expect(result).toEqual({ status: 'left' });
      expect(prisma.communityMember.deleteMany).toHaveBeenCalledWith({
        where: { communityId: COMMUNITY_ID, coupleId: COUPLE_ID },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('cascades delete when last member leaves', async () => {
      (prisma.couple.findUnique as jest.Mock).mockResolvedValue({ coupleId: COUPLE_ID });
      (prisma.communityMember.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.communityAdmin.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.notification.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
      (prisma.communityAdmin.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.communityMember.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.$transaction as jest.Mock).mockResolvedValue([]);

      const result = await service.leaveCommunity(COUPLE_ID, COMMUNITY_ID);

      expect(result).toEqual({ status: 'deleted' });
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('throws when couple profile is missing', async () => {
      (prisma.couple.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.leaveCommunity(COUPLE_ID, COMMUNITY_ID)).rejects.toThrow(AppError);
    });
  });

  describe('deleteCommunity', () => {
    it('throws 403 when requester is not admin', async () => {
      (prisma.couple.findUnique as jest.Mock).mockResolvedValue({ coupleId: COUPLE_ID });
      (prisma.communityAdmin.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.deleteCommunity(COUPLE_ID, COMMUNITY_ID)).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it('cascades delete when requester is admin', async () => {
      (prisma.couple.findUnique as jest.Mock).mockResolvedValue({ coupleId: COUPLE_ID });
      (prisma.communityAdmin.findUnique as jest.Mock).mockResolvedValue({ coupleId: COUPLE_ID });
      (prisma.$transaction as jest.Mock).mockResolvedValue([]);

      const result = await service.deleteCommunity(COUPLE_ID, COMMUNITY_ID);

      expect(result).toEqual({ success: true });
      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  describe('createCommunity', () => {
    it('throws 404 when couple profile is missing', async () => {
      (prisma.couple.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.createCommunity(COUPLE_ID, { name: 'Test', description: 'd', city: 'Bangalore' }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('creates community and adds creator as admin and member', async () => {
      (prisma.couple.findUnique as jest.Mock).mockResolvedValue({
        coupleId: COUPLE_ID,
        profileName: 'Peter & Stella',
      });
      (prisma.community.create as jest.Mock).mockResolvedValue({
        id: COMMUNITY_ID,
        name: 'Brunch Club',
      });

      const result = await service.createCommunity(COUPLE_ID, {
        name: 'Brunch Club',
        description: 'Weekend eats',
        city: 'Bangalore',
      });

      expect(result).toEqual({
        _id: COMMUNITY_ID,
        id: COMMUNITY_ID,
        name: 'Brunch Club',
      });
      expect(prisma.community.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'Brunch Club',
            admins: { create: { coupleId: COUPLE_ID } },
            members: { create: { coupleId: COUPLE_ID } },
          }),
        }),
      );
    });
  });

  describe('joinCommunity edge cases', () => {
    it('returns already-member when couple is already in community', async () => {
      (prisma.couple.findUnique as jest.Mock).mockResolvedValue({ coupleId: COUPLE_ID });
      (prisma.communityMember.findUnique as jest.Mock).mockResolvedValue({ coupleId: COUPLE_ID });

      const result = await service.joinCommunity(COUPLE_ID, COMMUNITY_ID);

      expect(result).toEqual({ status: 'already-member' });
    });
  });
});
