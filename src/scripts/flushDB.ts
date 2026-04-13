import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

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
