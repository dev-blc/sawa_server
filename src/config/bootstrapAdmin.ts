import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { env } from './env';
import { logger } from '../utils/logger';

/**
 * Idempotent admin bootstrap. Runs once on server startup so the admin
 * dashboard login ALWAYS works after a deploy, without needing to manually
 * run a seed script against production.
 *
 * - Ensures an `admin-system` couple exists (satisfies the User.coupleId FK).
 * - Upserts a user with role='admin' using ADMIN_EMAIL / ADMIN_PASSWORD.
 * - The password is re-hashed and updated every boot so it always matches env.
 *
 * Safe to run concurrently (PM2 cluster) — upsert + caught P2002 handle races.
 */
export async function bootstrapAdmin(): Promise<void> {
  const email = env.ADMIN_EMAIL.trim().toLowerCase();
  const password = env.ADMIN_PASSWORD;

  try {
    await prisma.couple.upsert({
      where: { coupleId: 'admin-system' },
      update: {},
      create: {
        coupleId: 'admin-system',
        profileName: 'Admin System',
        isProfileComplete: true,
        isSubscribed: true,
      },
    });

    const hashed = await bcrypt.hash(password, 10);

    const existing = await prisma.user.findFirst({ where: { email } });
    if (existing) {
      await prisma.user.update({
        where: { id: existing.id },
        data: { password: hashed, role: 'admin', coupleId: existing.coupleId ?? 'admin-system' },
      });
      logger.info(`🔐  Admin account ensured (updated): ${email}`);
    } else {
      await prisma.user.create({
        data: {
          email,
          password: hashed,
          role: 'admin',
          coupleId: 'admin-system',
          name: 'System Admin',
          isPhoneVerified: true,
        },
      });
      logger.info(`🔐  Admin account ensured (created): ${email}`);
    }
  } catch (err: any) {
    // Unique-constraint race in cluster mode is fine — another worker won.
    if (err?.code === 'P2002') {
      logger.warn('🔐  Admin bootstrap race (another worker created it) — ignoring.');
      return;
    }
    logger.error('❌  Admin bootstrap failed:', err?.message || err);
  }
}
