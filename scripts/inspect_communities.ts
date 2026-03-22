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
  city: String,
  description: String,
  members: [mongoose.Schema.Types.ObjectId],
  admins: [mongoose.Schema.Types.ObjectId],
}, { strict: false });

const Community = mongoose.model('Community', CommunitySchema);

async function inspectCommunities() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI!);
    console.log('Connected.');

    const communities = await Community.find({});
    console.log(`\nFound ${communities.length} communities:\n`);

    communities.forEach((c: any) => {
      console.log(`- [${c._id}] ${c.name} (${c.city})`);
      console.log(`  Desc: ${c.description?.substring(0, 50)}...`);
      console.log(`  Members: ${c.members?.length || 0}`);
    });

    console.log('\n--- End of List ---\n');
    await mongoose.disconnect();
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

inspectCommunities();
