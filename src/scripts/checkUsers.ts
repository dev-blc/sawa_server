import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

async function checkUsers() {
  if (!MONGODB_URI) return;
  try {
    await mongoose.connect(MONGODB_URI);
    const User = mongoose.model('User', new mongoose.Schema({
      email: String,
      phone: String,
      role: String
    }));

    const users = await User.find({});
    console.log('👥 Current Users in DB:');
    users.forEach(u => {
      console.log(`- ID: ${u._id}, Email: ${u.email}, Phone: ${u.phone}, Role: ${u.role}`);
    });
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkUsers();
