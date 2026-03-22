import { prisma } from '../lib/prisma';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

dotenv.config();

async function createAdmin() {
  try {
    const email = 'sawa@gmail.com';
    const password = 'admin';
    const hashedPassword = await bcrypt.hash(password, 10);

    const exists = await prisma.user.findFirst({ where: { email } });
    if (exists) {
      await prisma.user.update({
        where: { id: exists.id },
        data: {
          password: hashedPassword,
          role: 'admin',
        }
      });
      console.log(`✅ Updated existing account: ${email}`);
    } else {
      await prisma.user.create({
        data: {
          name: 'Sawa Admin',
          email,
          password: hashedPassword,
          role: 'admin',
          isPhoneVerified: true
        }
      });
      console.log(`🚀 Created new admin account: ${email}`);
    }
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

createAdmin();
