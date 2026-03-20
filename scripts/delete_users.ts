import mongoose from 'mongoose';
import { User } from '../src/models/User.model';
import { Couple } from '../src/models/Couple.model';
import { Match } from '../src/models/Match.model';
import { Message } from '../src/models/Message.model';
import { Notification } from '../src/models/Notification.model';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://kirandev2210_db_user:sawadev@sawa.prqius4.mongodb.net/?appName=sawa';

const USERS_TO_DELETE = [
  '69bda41ee59024062873d6db', // Priyan
  '69bda41ee59024062873d6d8', // Gokul
  '69bda3c6e59024062873d681', // Raji
  '69bda3c6e59024062873d67e'  // Kiran
];

const COUPLE_IDS_TO_DELETE = [
  '8299113f-6220-473d-8769-6cbcd1fa2c66',
  'dee69dec-4f4c-4b58-bbf8-abd96c5f7a78'
];

async function run() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, { dbName: 'sawa_db' });
    console.log('Connected.\n');

    for (const cId of COUPLE_IDS_TO_DELETE) {
      const coupleDoc = await Couple.findOne({ coupleId: cId });
      
      if (coupleDoc) {
        console.log(`Deleting data for Couple: ${cId} (${coupleDoc._id})`);
        
        await Match.deleteMany({
          $or: [{ couple1: coupleDoc._id }, { couple2: coupleDoc._id }]
        });

        await Message.deleteMany({
          $or: [{ sender: coupleDoc._id }, { chatId: { $in: await Match.find({ $or: [{ couple1: coupleDoc._id }, { couple2: coupleDoc._id }] }).select('_id') } }]
        });

        await Notification.deleteMany({
          $or: [{ recipient: coupleDoc._id }, { sender: coupleDoc._id }]
        });

        await Couple.deleteOne({ _id: coupleDoc._id });
        console.log(`✅ Couple ${cId} deleted.`);
      } else {
        console.log(`⚠️ Couple ${cId} not found.`);
      }
    }

    const userStatus = await User.deleteMany({ _id: { $in: USERS_TO_DELETE } });
    console.log(`✅ Deleted ${userStatus.deletedCount} users.`);

    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

run();
