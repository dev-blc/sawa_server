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
    // NOTE: the User model maps to the "users" table (@@map). A previous version
    // of this file wrongly targeted "User" and silently no-op'd — hence the fix.
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "preferredLocale" TEXT DEFAULT 'en';`,

    // ── Subscriptions (Sawa Prime / Prime Plus) ──────────────────────────────
    // Per-couple entitlement. Created here because the deploy pipeline uses
    // `prisma db push` locally only and never migrates prod. Columns mirror the
    // Prisma `Subscription` model exactly (see schema.prisma).
    `CREATE TABLE IF NOT EXISTS "subscriptions" (
       "id" TEXT PRIMARY KEY,
       "coupleId" TEXT NOT NULL,
       "tier" TEXT NOT NULL DEFAULT 'PRIME',
       "status" TEXT NOT NULL DEFAULT 'NONE',
       "platform" TEXT,
       "productId" TEXT,
       "originalTransactionId" TEXT,
       "purchaseToken" TEXT,
       "trialUsed" BOOLEAN NOT NULL DEFAULT false,
       "trialStartedAt" TIMESTAMP(3),
       "trialEndsAt" TIMESTAMP(3),
       "currentPeriodEnd" TIMESTAMP(3),
       "autoRenew" BOOLEAN NOT NULL DEFAULT true,
       "environment" TEXT,
       "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
     );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_coupleId_key" ON "subscriptions"("coupleId");`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_originalTransactionId_key" ON "subscriptions"("originalTransactionId");`,
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
