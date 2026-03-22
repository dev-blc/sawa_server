import { prisma } from '../lib/prisma';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

dotenv.config();

async function finalizeAdmin() {
  try {
    // 1. Delete ALL existing users to be absolutely sure
    await prisma.user.deleteMany({});
    console.log('🗑️ Cleared all users.');

    // 2. Create the requested admin
    const email = 'sawa@gmail.com';
    const password = 'admin';
    const hashedPassword = await bcrypt.hash(password, 10);

    await prisma.user.create({
      data: {
        name: 'Sawa Admin',
        email,
        phone: 'ADMIN_SAWA_TEMP', 
        password: hashedPassword,
        role: 'admin',
        coupleId: 'ADMIN_COUPLE',
        isPhoneVerified: true
      }
    });

    console.log(`🚀 Final Admin Account Created: ${email} / ${password}`);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

finalizeAdmin();
