import mongoose from 'mongoose';
import { User } from '../src/models/User.model';
import { Couple } from '../src/models/Couple.model';
import { Community } from '../src/models/Community.model';
import { Match } from '../src/models/Match.model';
import { Message } from '../src/models/Message.model';
import { Notification } from '../src/models/Notification.model';
import { env } from '../src/config/env';

async function run() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(env.MONGODB_URI, { dbName: 'sawa_db' });
    console.log('Connected.');

    // 1. Find the users
    const users = await User.find({ 
      name: { $in: [/Gokul/i, /Priyan/i] } 
    });

    if (users.length === 0) {
      console.log('No users found with names Gokul or Priyan.');
      process.exit(0);
    }

    const coupleIds = [...new Set(users.map(u => u.coupleId))];
    console.log(`Found ${users.length} users across ${coupleIds.length} couples.`);

    for (const cId of coupleIds) {
      console.log(`\nProcessing Couple: ${cId}`);
      
      const coupleDoc = await Couple.findOne({ coupleId: cId });
      const _id = coupleDoc?._id;

      // Delete Community where they are admins
      if (_id) {
         const deletedCommunities = await Community.deleteMany({ admins: _id });
         console.log(`Deleted ${deletedCommunities.deletedCount} communities.`);
      }

      // Delete Matches
      if (_id) {
        const deletedMatches = await Match.deleteMany({
          $or: [{ couple1: _id }, { couple2: _id }]
        });
        console.log(`Deleted ${deletedMatches.deletedCount} matches.`);
      }

      // Delete Notifications
      if (_id) {
        const deletedNotifications = await Notification.deleteMany({
          $or: [{ recipient: _id }, { sender: _id }]
        });
        console.log(`Deleted ${deletedNotifications.deletedCount} notifications.`);
      }

      // Delete Messages
      if (_id) {
         const deletedMessages = await Message.deleteMany({
           $or: [{ senderId: _id }, { recipientId: _id }]
         });
         console.log(`Deleted ${deletedMessages.deletedCount} messages.`);
      }

      // Delete Couple doc
      const delCouple = await Couple.deleteOne({ coupleId: cId });
      console.log(`Deleted Couple doc: ${delCouple.deletedCount}`);

      // Delete Users
      const delUsers = await User.deleteMany({ coupleId: cId });
      console.log(`Deleted ${delUsers.deletedCount} users.`);
    }

    console.log('\nCleanup successfully completed.');
    process.exit(0);

  } catch (err) {
    console.error('Error during cleanup:', err);
    process.exit(1);
  }
}

run();
