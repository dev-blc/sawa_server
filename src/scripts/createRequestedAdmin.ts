import mongoose from 'mongoose';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

async function createAdmin() {
  if (!MONGODB_URI) return;
  try {
    await mongoose.connect(MONGODB_URI);
    const User = mongoose.model('User', new mongoose.Schema({
      name: String,
      email: String,
      password: { type: String, select: false },
      role: { type: String, default: 'user' },
      status: { type: String, default: 'active' }
    }));

    const email = 'sawa@gmail.com';
    const password = 'admin';
    const hashedPassword = await bcrypt.hash(password, 10);

    const exists = await User.findOne({ email });
    if (exists) {
      exists.password = hashedPassword;
      exists.role = 'admin';
      await exists.save();
      console.log(`✅ Updated existing account: ${email}`);
    } else {
      await new User({
        name: 'Sawa Admin',
        email,
        password: hashedPassword,
        role: 'admin',
        status: 'active'
      }).save();
      console.log(`🚀 Created new admin account: ${email}`);
    }
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

createAdmin();
