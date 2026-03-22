import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('MONGODB_URI not found in environment');
  process.exit(1);
}

const CommunitySchema = new mongoose.Schema({
  name: String,
}, { strict: false });

const Community = mongoose.model('Community', CommunitySchema);

async function deleteDummies() {
  try {
    await mongoose.connect(MONGODB_URI!);
    console.log('Connected to Prod DB.');

    const dummyNames = [
      'Wanderlusters Club',
      'Weekend Foodies',
      'Board Game Knights',
      'tada trip',
      'Cat community',
      'Weekend  Foodies',
      'Board  Game Knights',
      'Wanderlusters  Club'
    ];

    console.log('Deleting dummy communities...');
    const result = await Community.deleteMany({
      name: { $in: dummyNames }
    });
    console.log(`✅ Deleted ${result.deletedCount} dummy communities.`);

    // Also list what remains
    const remaining = await Community.find({});
    console.log(`\nRemaining communities (${remaining.length}):`);
    remaining.forEach((c: any) => console.log(`- ${c.name} (${c.city})`));

    await mongoose.disconnect();
    console.log('\nDone.');
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

deleteDummies();
