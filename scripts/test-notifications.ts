import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { Couple } from '../src/models/Couple.model';
import { Notification } from '../src/models/Notification.model';

dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sawa';

async function sendTestNotifications() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('Connected!');

    const allCouples = await Couple.find({});
    console.log(`Found ${allCouples.length} couples.`);

    const notifications: any[] = [];
    allCouples.forEach((c) => {
      // Send to both Mongoose _id AND the UUID string to be 100% sure the flexible query catches it
      notifications.push({
        recipient: c._id,
        type: 'system',
        title: 'Welcome to SAWA! 🚀',
        message: 'This is a test notification to your DB _id.',
        read: false,
      });
      if (c.coupleId) {
        notifications.push({
          recipient: c.coupleId,
          type: 'system',
          title: 'Hello via UUID! 🍎',
          message: 'This confirms your UUID-based notifications are working.',
          read: false,
        });
      }
    });

    if (notifications.length > 0) {
      await Notification.insertMany(notifications);
      console.log(`Successfully pushed ${notifications.length} test notifications.`);
    } else {
      console.log('No couples found to notify.');
    }

  } catch (err) {
    console.error('Error in test notification script:', err);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected.');
  }
}

sendTestNotifications();
