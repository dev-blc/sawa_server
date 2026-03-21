import mongoose from 'mongoose';
import { Community } from '../src/models/Community.model';
import { Message } from '../src/models/Message.model';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://kirandev2210_db_user:sawadev@sawa.prqius4.mongodb.net/?appName=sawa';

async function run() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, { dbName: 'sawa_db' });
    console.log('Connected.\n');

    // 1. Fetch all communities first (so we know their IDs for message cleanup)
    const allCommunities = await Community.find({});
    const communityIds = allCommunities.map(c => c._id);

    console.log(`Found ${allCommunities.length} communities to delete.`);

    if (communityIds.length > 0) {
      // 2. Delete group messages associated with these communities
      const msgResult = await Message.deleteMany({
        chatType: 'group',
        chatId: { $in: communityIds }
      });
      console.log(`✅ Deleted ${msgResult.deletedCount} group messages.`);

      // 3. Delete the communities themselves
      const communityResult = await Community.deleteMany({ _id: { $in: communityIds } });
      console.log(`✅ Deleted ${communityResult.deletedCount} communities.`);
    } else {
      console.log('⚠️ No communities found to delete.');
    }

    console.log('\nDatabase cleanup finished (Users and Couples preserved).');
    process.exit(0);
  } catch (err) {
    console.error('Error during cleanup:', err);
    process.exit(1);
  }
}

run();
