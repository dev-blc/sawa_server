import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { Notification } from '../src/models/Notification.model';
import { Couple } from '../src/models/Couple.model';

dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sawa';

async function debugNotifications() {
  const targetId = '53c2a43c-0e69-496d-9311-21e30437d3c6';
  try {
    console.log('--- NOTIFICATION DEBUGGER ---');
    await mongoose.connect(MONGO_URI);
    console.log('Connected to DB.');

    const user = await Couple.findOne({ 
       $or: [{ coupleId: targetId }, { _id: mongoose.isValidObjectId(targetId) ? targetId : undefined }] 
    });

    if (!user) {
      console.log('ERROR: Could not find user with that ID.');
      return;
    }

    console.log(`User Found: _id=${user._id}, coupleId=${user.coupleId}`);

    const allNotis = await Notification.find({});
    console.log(`\nTotal Notifications in DB: ${allNotis.length}`);

    const userNotis = await Notification.find({
       $or: [{ recipient: user._id }, { recipient: user.coupleId }]
    });

    console.log(`Notifications found for this user: ${userNotis.length}`);
    
    if (userNotis.length === 0 && allNotis.length > 0) {
       console.log('\n--- SAMPLE DB NOTIFICATION RECIPIENTS ---');
       allNotis.slice(0, 5).forEach(n => {
          console.log(`[${n.title}] Recipient field value: "${n.recipient}" (Type: ${typeof n.recipient})`);
       });
    }

  } catch (err) {
    console.error('Debug script failed:', err);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected.');
  }
}

debugNotifications();
