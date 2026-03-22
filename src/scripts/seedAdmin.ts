import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { User } from '../models/User.model';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sawa_db';

async function seedAdmin() {
  try {
    console.log('🛰️ Connecting to database...');
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB.');

    const email = 'admin@gmail.com';
    const password = 'adminsawa';
    
    // Check if admin already exists
    const existingAdmin = await User.findOne({ email, role: 'admin' });
    if (existingAdmin) {
      console.log('ℹ️ Admin account already exists. Updating password...');
      const hashedPassword = await bcrypt.hash(password, 10);
      existingAdmin.password = hashedPassword;
      await existingAdmin.save();
      console.log('✨ Admin password updated successfully!');
    } else {
      console.log('🚀 Creating new admin account...');
      const hashedPassword = await bcrypt.hash(password, 10);
      
      const admin = new User({
        email,
        password: hashedPassword,
        role: 'admin',
        coupleId: 'admin-system', // System admin doesn't need a real couple
        name: 'System Admin',
        isPhoneVerified: true
      });

      await admin.save();
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

    const { Prompt } = require('../models/Prompt.model');
    for (const text of DEFAULT_PROMPTS) {
      const exists = await Prompt.findOne({ text });
      if (!exists) {
        await new Prompt({ text, category: 'chat_shortcut', isActive: true }).save();
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
