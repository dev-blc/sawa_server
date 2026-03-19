import mongoose from 'mongoose';
import { Community } from './src/models/Community.model';
import { connectDB } from './src/config/db';
import dotenv from 'dotenv';

dotenv.config();

const COMMUNITY_ID_TO_DELETE = '69bc4299b2c55150a9b93bad'; // Chennai Trip

async function deleteCommunity() {
  await connectDB();
  
  const community = await Community.findById(COMMUNITY_ID_TO_DELETE);
  if (!community) {
    console.log('Error: Community not found.');
    process.exit(1);
  }

  console.log(`Deleting community: ${community.name} (ID: ${community._id})...`);
  await Community.findByIdAndDelete(COMMUNITY_ID_TO_DELETE);
  console.log('✅ Community deleted successfully.');
  
  process.exit(0);
}

deleteCommunity().catch(err => {
  console.error('Delete failed:', err);
  process.exit(1);
});
