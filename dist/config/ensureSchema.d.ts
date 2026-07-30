/**
 * Additive, idempotent schema guarantees applied at boot.
 *
 * This project uses the `prisma db push` workflow (no migration files) and the
 * deploy pipeline only runs `prisma generate && build`. New *additive* columns
 * that the running code depends on are ensured here so a deploy never gets ahead
 * of the database. Only run this from the primary worker; every statement must
 * be idempotent (IF NOT EXISTS) and must never drop or rewrite existing data.
 */
export declare const ensureSchema: () => Promise<void>;
//# sourceMappingURL=ensureSchema.d.ts.map