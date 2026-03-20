import mongoose from 'mongoose';
import { User } from '../src/models/User.model';
import { Couple } from '../src/models/Couple.model';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://kirandev2210_db_user:sawadev@sawa.prqius4.mongodb.net/?appName=sawa';

async function run() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, { dbName: 'sawa_db' });
    console.log('Connected.\n');

    const users = await User.find().sort({ createdAt: -1 });
    
    console.log('--- USER LIST ---');
    for (const u of users) {
      console.log(`ID: ${u._id} | Name: ${u.name || 'N/A'} | Phone: ${u.phone} | CoupleId: ${u.coupleId} | Role: ${u.role}`);
    }
    console.log('-----------------\n');

    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

run();
