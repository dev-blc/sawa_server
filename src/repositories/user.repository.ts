import { prisma } from '../lib/prisma';
import { AppError } from '../utils/AppError';
import type { User } from '@prisma/client';

/**
 * Normalises any phone format to a bare 10-digit string for consistent DB storage.
 * Examples:
 *   +919876543210 → 9876543210
 *   919876543210  → 9876543210
 *   9876543210    → 9876543210
 */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

export class UserRepository {
  async findByPhone(phone: string): Promise<User | null> {
    const normalized = normalizePhone(phone);
    // Single query covering all three legacy storage formats.
    return prisma.user.findFirst({
      where: {
        OR: [
          { phone: normalized },
          { phone: `91${normalized}` },
          { phone: `+91${normalized}` },
        ],
      },
    });
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
    const normalized = normalizePhone(phone);
    return prisma.user.upsert({
      where: { phone: normalized },
      update: {},
      create: { phone: normalized, coupleId, role, isPhoneVerified: false },
    });
  }

  async markVerified(phone: string): Promise<User> {
    const normalized = normalizePhone(phone);
    const user = await prisma.user.update({
      where: { phone: normalized },
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
