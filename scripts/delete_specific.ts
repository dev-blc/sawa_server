import mongoose from 'mongoose';
import { User } from '../src/models/User.model';
import { Couple } from '../src/models/Couple.model';
import { env } from '../src/config/env';

async function deleteSelected() {
  try {
    await mongoose.connect(env.MONGODB_URI, { dbName: 'sawa_db' });
    console.log('Connected to sawa_db');

    const coupleIds = ['69bd51dc744d07d78f413e4a', '69bd52d19b7e4bf6a6215416'];

    for (const cId of coupleIds) {
      console.log(`\nProcessing Couple: ${cId}`);
      
      const couple = await Couple.findById(cId);
      if (couple) {
          // Delete users
          const uRes = await User.deleteMany({ _id: { $in: [couple.partner1, couple.partner2] } });
          console.log(`  - Deleted ${uRes.deletedCount} partner users.`);
          
          await Couple.findByIdAndDelete(cId);
          console.log(`  - Couple deleted.`);
      } else {
          console.log(`  - Couple not found!`);
      }
    }

    process.exit(0);
  } catch (err) {
    console.error('Error during deletion:', err);
    process.exit(1);
  }
}

deleteSelected();
