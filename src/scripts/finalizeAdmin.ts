import mongoose from 'mongoose';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

async function finalizeAdmin() {
  if (!MONGODB_URI) return;
  try {
    await mongoose.connect(MONGODB_URI);
    const User = mongoose.model('User', new mongoose.Schema({
      name: String,
      email: String,
      phone: String,
      password: { type: String, select: false },
      role: { type: String, default: 'user' },
      status: { type: String, default: 'active' },
      coupleId: { type: String, default: 'ADMIN_COUPLE' }
    }));

    // 1. Delete ALL existing users to be absolutely sure
    await User.deleteMany({});
    console.log('🗑️ Cleared all users.');

    // 2. Create the requested admin
    const email = 'sawa@gmail.com';
    const password = 'admin';
    const hashedPassword = await bcrypt.hash(password, 10);

    // Using a placeholder phone to avoid ANY sparse/unique/null index issues
    // Since phone is required for non-admins, but unique across all.
    await new User({
      name: 'Sawa Admin',
      email,
      phone: 'ADMIN_SAWA_TEMP', 
      password: hashedPassword,
      role: 'admin',
      status: 'active',
      coupleId: 'ADMIN_COUPLE'
    }).save();

    console.log(`🚀 Final Admin Account Created: ${email} / ${password}`);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

finalizeAdmin();
