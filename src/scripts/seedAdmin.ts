import { prisma } from '../lib/prisma';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

async function seedAdmin() {
  try {
    console.log('🛰️ Connecting to database...');
    
    const email = 'admin@gmail.com';
    const password = 'adminsawa';
    
    // Check if admin already exists
    const existingAdmin = await prisma.user.findFirst({ where: { email, role: 'admin' } });
    if (existingAdmin) {
      console.log('ℹ️ Admin account already exists. Updating password...');
      const hashedPassword = await bcrypt.hash(password, 10);
      await prisma.user.update({
          where: { id: existingAdmin.id },
          data: { password: hashedPassword }
      });
      console.log('✨ Admin password updated successfully!');
    } else {
      console.log('🚀 Creating new admin account...');
      const hashedPassword = await bcrypt.hash(password, 10);
      
      await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          role: 'admin',
          coupleId: 'admin-system', 
          name: 'System Admin',
          isPhoneVerified: true
        }
      });

      console.log('✨ Admin account created successfully!');
    }

    // Seed default prompts
    const DEFAULT_PROMPTS = [
      "Hello, how are you?",
      "Let's connect!",
      "I'd love to chat more.",
      "Are you free this weekend?",
      "Coffee sometime?"
    ];

    for (const text of DEFAULT_PROMPTS) {
      const exists = await prisma.prompt.findFirst({ where: { text } });
      if (!exists) {
        await prisma.prompt.create({
            data: { text, category: 'chat_shortcut', isActive: true }
        });
        console.log(`📝 Seeded prompt: ${text}`);
      }
    }

    console.log('✅ Seeding complete!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seeding failed:', err);
    process.exit(1);
  }
}

seedAdmin();
