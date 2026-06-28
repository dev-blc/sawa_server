import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Cap connections per PM2 worker so a multi-process cluster (pm2 -i max)
// doesn't exhaust the Postgres pool. With 4 workers × 5 = 20 connections total.
function buildDatabaseUrl(): string {
  const url = process.env.DATABASE_URL || '';
  if (!url) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}connection_limit=5&pool_timeout=2`;
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    datasources: { db: { url: buildDatabaseUrl() } },
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

