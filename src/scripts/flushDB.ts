import { prisma } from '../lib/prisma';
import bcrypt from 'bcryptjs';

async function flush() {
  try {
    console.log('⚠️ Starting database flush...');

    // Delete in order to avoid FK violations
    await prisma.message.deleteMany();
    await prisma.notification.deleteMany();
    await prisma.report.deleteMany();
    await prisma.match.deleteMany();
    await prisma.communityJoinRequest.deleteMany();
    await prisma.communityMember.deleteMany();
    await prisma.communityAdmin.deleteMany();
    await prisma.community.deleteMany();
    await prisma.otpToken.deleteMany();
    await prisma.user.deleteMany();
    await prisma.couple.deleteMany();
    await prisma.prompt.deleteMany();

    console.log('🗑️ All tables cleared.');

  
  } catch (err) {
    console.error('❌ Flush failed:', err);
    process.exit(1);
  }
}

flush();
