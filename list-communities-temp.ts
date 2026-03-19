import mongoose from 'mongoose';
import { Community } from './src/models/Community.model';
import { connectDB } from './src/config/db';
import dotenv from 'dotenv';

dotenv.config();

async function listCommunities() {
  await connectDB();
  const communities = await Community.find();
  console.log('COMMUNITIES_LIST_START');
  console.log(JSON.stringify(communities, null, 2));
  console.log('COMMUNITIES_LIST_END');
  process.exit(0);
}

listCommunities().catch(err => {
  console.error(err);
  process.exit(1);
});
