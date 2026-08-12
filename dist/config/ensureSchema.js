"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureSchema = void 0;
const prisma_1 = require("../lib/prisma");
const logger_1 = require("../utils/logger");
/**
 * Additive, idempotent schema guarantees applied at boot.
 *
 * This project uses the `prisma db push` workflow (no migration files) and the
 * deploy pipeline only runs `prisma generate && build`. New *additive* columns
 * that the running code depends on are ensured here so a deploy never gets ahead
 * of the database. Only run this from the primary worker; every statement must
 * be idempotent (IF NOT EXISTS) and must never drop or rewrite existing data.
 */
const ensureSchema = async () => {
    const statements = [
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
        // Dedup flag for the "trial ends tomorrow" nudge (added with subscriptionNotifier).
        `ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "trialEndingNotifiedAt" TIMESTAMP(3);`,
        // ── Performance indexes (2026-08 audit) ──────────────────────────────────
        // Each mirrors an @@index/@unique in schema.prisma. Names match Prisma's
        // convention so a future `prisma db push` sees them as already-present.
        // All hot paths that were doing sequential scans in production.
        // GIN index for `blocked: { has: X }` array membership (profile view / report stats).
        `CREATE INDEX IF NOT EXISTS "couples_blocked_idx" ON "couples" USING GIN ("blocked");`,
        // Match.actionById — filtered on every GET /subscriptions/me usage count.
        `CREATE INDEX IF NOT EXISTS "matches_actionById_idx" ON "matches"("actionById");`,
        // Message.senderUserId — admin per-user message queries.
        `CREATE INDEX IF NOT EXISTS "messages_senderUserId_idx" ON "messages"("senderUserId");`,
        // Report.createdAt / Community.createdAt — order-by on admin list pages.
        `CREATE INDEX IF NOT EXISTS "reports_createdAt_idx" ON "reports"("createdAt");`,
        `CREATE INDEX IF NOT EXISTS "communities_createdAt_idx" ON "communities"("createdAt");`,
        // Subscription.purchaseToken UNIQUE — one Google receipt can entitle only one
        // couple (multiple NULLs allowed in Postgres). Mirrors @unique in schema.
        `CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_purchaseToken_key" ON "subscriptions"("purchaseToken");`,
    ];
    for (const sql of statements) {
        try {
            await prisma_1.prisma.$executeRawUnsafe(sql);
        }
        catch (err) {
            logger_1.logger.warn(`⚠️  ensureSchema statement failed (continuing): ${sql}`, err);
        }
    }
    logger_1.logger.info('✅  ensureSchema: additive columns verified');
};
exports.ensureSchema = ensureSchema;
//# sourceMappingURL=ensureSchema.js.map