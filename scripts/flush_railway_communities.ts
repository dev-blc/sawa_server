import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI;

async function run() {
  if (!MONGODB_URI) {
    console.error('No URI found');
    return;
  }
  try {
    console.log('Connecting to Railway DB...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected.');

    const db = mongoose.connection.db;
    if (!db) {
      console.error('No DB connection');
      return;
    }

    const communities = await db.collection('communities').find({}).toArray();
    console.log(`Found ${communities.length} communities in Railway.`);
    
    if (communities.length > 0) {
      console.log('Community names in Railway:', communities.map(c => c.name));
      
      const resMsg = await db.collection('messages').deleteMany({ chatType: 'group' });
      console.log(`Deleted ${resMsg.deletedCount} group messages.`);

      const resComm = await db.collection('communities').deleteMany({});
      console.log(`Deleted ${resComm.deletedCount} communities from Railway.`);
    } else {
      console.log('No communities found in Railway.');
    }

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
