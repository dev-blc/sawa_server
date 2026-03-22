import { prisma } from '../lib/prisma';
import { AppError } from '../utils/AppError';
import type { User } from '@prisma/client';

export class UserRepository {
  async findByPhone(phone: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { phone } });
  }

  async findById(id: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { id } });
  }

  async findByEntityId(coupleId: string): Promise<User[]> {
    return prisma.user.findMany({ where: { coupleId } });
  }

  async upsertByPhone(
    phone: string,
    coupleId: string,
    role: 'primary' | 'partner',
  ): Promise<User> {
    return prisma.user.upsert({
      where: { phone },
      update: {},
      create: { phone, coupleId, role, isPhoneVerified: false },
    });
  }

  async markVerified(phone: string): Promise<User> {
    const user = await prisma.user.update({
      where: { phone },
      data: { isPhoneVerified: true },
    });
    if (!user) throw new AppError(`User not found for phone: ${phone}`, 404, 'USER_NOT_FOUND');
    return user;
  }

  async saveRefreshTokenHash(userId: string, hash: string): Promise<void> {
    await prisma.user.update({ where: { id: userId }, data: { refreshTokenHash: hash } });
  }

  async clearRefreshToken(userId: string): Promise<void> {
    await prisma.user.update({ where: { id: userId }, data: { refreshTokenHash: null } });
  }

  async findByIdWithRefreshToken(userId: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { id: userId } });
  }

  async update(id: string, data: Partial<User>): Promise<User> {
    const user = await prisma.user.update({ where: { id }, data });
    if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    return user;
  }
}

export const userRepository = new UserRepository();
