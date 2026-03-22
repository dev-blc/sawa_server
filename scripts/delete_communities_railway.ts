import mongoose from 'mongoose';
import { Community } from '../src/models/Community.model';
import { Message } from '../src/models/Message.model';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not found in environment!');
  process.exit(1);
}

async function run() {
  try {
    console.log(`Connecting to: ${MONGODB_URI.split('@')[1] || 'DB'}...`);
    await mongoose.connect(MONGODB_URI);
    console.log('Connected.\n');

    const totalBefore = await Community.countDocuments({});
    console.log(`Total communities in DB: ${totalBefore}`);

    if (totalBefore > 0) {
      const allCommunities = await Community.find({});
      const ids = allCommunities.map(c => c._id);
      
      console.log('Deleting communities...');
      await Message.deleteMany({ chatType: 'group', chatId: { $in: ids } });
      const delResult = await Community.deleteMany({});
      console.log(`✅ Deleted ${delResult.deletedCount} communities.`);
    } else {
      console.log('⚠️ No communities found locally.');
    }

    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

run();
