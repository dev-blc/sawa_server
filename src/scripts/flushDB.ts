import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

async function flushDb() {
  console.log('🗑️  Starting Database Flush...');
  try {
    // List of tables to truncate (order matters if not using CASCADE, 
    // but PostgreSQL TRUNCATE ... CASCADE handles it cleanly)
    const tables = [
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
      'prompts'
    ];

    console.log(`Clearing ${tables.length} tables...`);

    // Using raw query for efficient cascade truncate
    // We wrap table names in quotes because some might be reserved words or case-sensitive
    for (const table of tables) {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE;`);
      console.log(`  ✅ Cleared ${table}`);
    }

    console.log('✨ Database Flush Complete!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Database Flush Failed:', err);
    process.exit(1);
  }
}

flushDb();
