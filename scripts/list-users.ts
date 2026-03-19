import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { Couple } from '../src/models/Couple.model';
import { User } from '../src/models/User.model';

dotenv.config({ path: path.join(__dirname, '../.env') });


const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sawa';

async function listUsers() {
  try {
    await mongoose.connect(MONGO_URI, { dbName: 'sawa_db' });

    
    const couples = await Couple.find({});
    console.log(`--- COUPLE DOCUMENTS (${couples.length}) ---`);
    couples.forEach((c: any) => {
      console.log(`- ${c.profileName}: _id=${c._id}, coupleId=${c.coupleId}, Complete: ${c.isProfileComplete}`);
    });

    const users = await User.find({}).sort({ createdAt: -1 }).limit(10);
    console.log(`\n--- RECENT RAW USERS (Max 10) ---`);
    users.forEach((u: any) => {
      console.log(`- ${u.name || '[Unnamed]'} pt: ${u.phone} ID: ${u._id} Role: ${u.role} CoupleID: ${u.coupleId}`);
    });

  } finally {
    await mongoose.disconnect();
  }
}

listUsers();


