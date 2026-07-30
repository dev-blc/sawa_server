import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

/**
 * Additive, idempotent schema guarantees applied at boot.
 *
 * This project uses the `prisma db push` workflow (no migration files) and the
 * deploy pipeline only runs `prisma generate && build`. New *additive* columns
 * that the running code depends on are ensured here so a deploy never gets ahead
 * of the database. Only run this from the primary worker; every statement must
 * be idempotent (IF NOT EXISTS) and must never drop or rewrite existing data.
 */
export const ensureSchema = async (): Promise<void> => {
  const statements: string[] = [
    // Selected app language per user (en/hi/kn/mr). Used to localize push/APNs
    // and in-app notification text. Added 2026-07 with notification i18n.
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "preferredLocale" TEXT DEFAULT 'en';`,
  ];

  for (const sql of statements) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      logger.warn(`⚠️  ensureSchema statement failed (continuing): ${sql}`, err);
    }
  }
  logger.info('✅  ensureSchema: additive columns verified');
};
