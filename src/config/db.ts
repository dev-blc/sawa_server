import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

export const connectDB = async (): Promise<void> => {
  try {
    await prisma.$connect();
    logger.info('✅  PostgreSQL connected via Prisma');
  } catch (error) {
    logger.error('❌  PostgreSQL connection failed:', error);
    process.exit(1);
  }
};
