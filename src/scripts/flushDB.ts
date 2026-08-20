import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// ─── Destructive-operation guard (mirrors POST /admin/flush-database) ────────
// This script TRUNCATEs every table of whatever DATABASE_URL it discovers —
// on a production host that is the production database. Refuse unless the
// operator explicitly confirms, and refuse outright in production without the
// same env opt-in the HTTP endpoint requires.
const CONFIRM_PHRASE = 'FLUSH-ENTIRE-SAWA-DATABASE';
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_DB_FLUSH !== 'true') {
  console.error('[flushDB] REFUSED: NODE_ENV=production and ALLOW_PROD_DB_FLUSH is not true.');
  process.exit(1);
}
if (process.env.FLUSH_DB_CONFIRM !== CONFIRM_PHRASE && process.argv[2] !== CONFIRM_PHRASE) {
  console.error('[flushDB] REFUSED: pass the confirmation phrase to proceed:');
  console.error(`  npm run db:flush -- ${CONFIRM_PHRASE}`);
  console.error(`  (or set FLUSH_DB_CONFIRM=${CONFIRM_PHRASE})`);
  process.exit(1);
}

/**
 * Load DATABASE_URL by directly reading and parsing candidate .env files.
 * Uses manual parsing so it works regardless of dotenv caching or module load order.
 */
function loadDatabaseUrlFromEnvFiles(): void {
  const candidates = [
    path.resolve(__dirname, '../../.env'),       // server/src/scripts → server/.env
    path.resolve(__dirname, '../../../.env'),     // fallback one level up
    path.resolve(process.cwd(), '.env'),          // cwd (server/) → server/.env
    path.resolve(process.cwd(), 'server/.env'),   // cwd (repo root) → server/.env
  ];

  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/^DATABASE_URL=(.+)$/m);
      if (match) {
        process.env.DATABASE_URL = match[1].trim().replace(/^["']|["']$/g, '');
        console.log('Loaded DATABASE_URL from:', envPath);
        return;
      }
    } catch {
      // try next candidate
    }
  }

  // Final fallback: try dotenv on the server/.env path
  dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });
}

loadDatabaseUrlFromEnvFiles();

/** All application tables (Prisma @@map names). Single TRUNCATE avoids partial clears. */
const TABLES = [
  'onboarding_answers',
  'messages',
  'notifications',
  'matches',
  'community_members',
  'community_admins',
  'community_join_requests',
  'reports',
  'otp_tokens',
  'users',
  'couples',
  'communities',
  'prompts',
] as const;

async function flushDb() {
  if (!process.env.DATABASE_URL?.trim()) {
    console.error(
      'DATABASE_URL is not set. Add it to server/.env (same folder as package.json) and run: npm run db:flush',
    );
    process.exit(1);
  }

  const { prisma } = await import('../lib/prisma');

  console.log('Starting full database flush (all rows removed)...');
  try {
    const list = TABLES.map((t) => `"${t}"`).join(', ');
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`,
    );
    console.log(`Truncated ${TABLES.length} tables in one transaction.`);
    console.log('Database flush complete.');
    await prisma.$disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Database flush failed:', err);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }
}

flushDb();
