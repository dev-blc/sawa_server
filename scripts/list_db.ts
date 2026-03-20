import mongoose from 'mongoose';
import { User } from '../src/models/User.model';
import { Couple } from '../src/models/Couple.model';
import { env } from '../src/config/env';

async function listAll() {
  try {
    await mongoose.connect(env.MONGODB_URI, { dbName: 'sawa_db' });
    console.log('Connected to sawa_db\n');

    const users = await User.find({}).lean();
    console.log('--- ALL USERS ---');
    users.forEach((u: any) => {
      console.log(`- ID: ${u._id} | Name: ${u.name} | Phone: ${u.phone} | Role: ${u.role} | CoupleId: ${u.coupleId}`);
    });

    const couples = await Couple.find({}).lean();
    console.log('\n--- ALL COUPLES ---');
    couples.forEach((c: any) => {
      console.log(`- ID: ${c._id} | Profile: ${c.profileName} | Members: [${c.partner1}, ${c.partner2}] | Complete: ${c.isProfileComplete}`);
    });

    process.exit(0);
  } catch (err) {
    console.error('Error listing DB:', err);
    process.exit(1);
  }
}

listAll();
