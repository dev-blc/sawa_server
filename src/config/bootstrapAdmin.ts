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
// Legacy insecure defaults that were once committed — still explicitly rejected
// in production in case they linger in any old env var.
const DEFAULT_ADMIN_EMAIL = 'admin@gmail.com';
const DEFAULT_ADMIN_PASSWORD = 'adminsawa';

export async function bootstrapAdmin(): Promise<void> {
  const email = env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.ADMIN_PASSWORD;

  // No credentials configured → skip bootstrap entirely (no committed defaults).
  // Set ADMIN_EMAIL and ADMIN_PASSWORD env vars to enable admin login.
  if (!email || !password) {
    logger.warn(
      '🔐  Admin bootstrap skipped: ADMIN_EMAIL / ADMIN_PASSWORD not set. ' +
        'Set both env vars to provision the admin account.',
    );
    return;
  }

  // Refuse to seed/overwrite the admin with default/weak credentials in production.
  // This closes the "known default admin login" hole without crashing the API.
  if (
    env.NODE_ENV === 'production' &&
    (email === DEFAULT_ADMIN_EMAIL || password === DEFAULT_ADMIN_PASSWORD || password.length < 10)
  ) {
    logger.error(
      '🔐  Refusing to bootstrap admin with default/weak credentials in production. ' +
        'Set ADMIN_EMAIL and a strong ADMIN_PASSWORD (>=10 chars) env var.',
    );
    return;
  }

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
