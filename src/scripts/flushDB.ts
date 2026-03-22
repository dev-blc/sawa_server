import mongoose from 'mongoose';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not found in environment variables');
  process.exit(1);
}

const flushDB = async () => {
  try {
    console.log('🛰️ Connecting to database for FLUSH operation...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB.');

    // 1. Define collections to clear
    const collections = [
      'users',
      'communities',
      'prompts',
      'reports',
      'messages',
      'couples',
      'notifications',
      'matches'
    ];

    console.log('⚠️ Starting database flush...');
    for (const collectionName of collections) {
      const collection = mongoose.connection.collection(collectionName);
      const count = await collection.countDocuments();
      await collection.deleteMany({});
      console.log(`🗑️ Cleared ${count} documents from ${collectionName}`);
    }

    // 2. Re-seed Admin Account (CRITICAL)
    console.log('👤 Re-seeding admin account...');
    const adminEmail = 'admin@gmail.com';
    const adminPassword = 'adminsawa';
    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    const User = mongoose.model('User', new mongoose.Schema({
      name: String,
      email: String,
      password: { type: String, select: false },
      role: { type: String, default: 'user' },
      status: { type: String, default: 'active' }
    }));

    await new User({
      name: 'Sawa Admin',
      email: adminEmail,
      password: hashedPassword,
      role: 'admin',
      status: 'active'
    }).save();

    console.log(`✨ Admin account recreated: ${adminEmail}`);
    console.log('🚀 Database flush and admin reset complete!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Database flush failed:', err);
    process.exit(1);
  }
};

flushDB();
