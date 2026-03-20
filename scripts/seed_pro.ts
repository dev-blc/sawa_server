import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { User } from '../src/models/User.model';
import { Couple } from '../src/models/Couple.model';
import { Community } from '../src/models/Community.model';
import { Match } from '../src/models/Match.model';
import { Message } from '../src/models/Message.model';
import { Notification } from '../src/models/Notification.model';
import { env } from '../src/config/env';

/**
 * Helper to get base64 of local file
 */
function getBase64(filePath: string): string {
  if (!fs.existsSync(filePath)) return '';
  const bitmap = fs.readFileSync(filePath);
  return 'data:image/png;base64,' + Buffer.from(bitmap).toString('base64');
}

// Image Paths (from recent generation)
const IMG_COUPLE_1 = '/Users/kiran/.gemini/antigravity/brain/8bcc0665-254c-43d9-8957-2e0c79d7e163/professional_couple_1_profile_1774014491930.png';
const IMG_COUPLE_2 = '/Users/kiran/.gemini/antigravity/brain/8bcc0665-254c-43d9-8957-2e0c79d7e163/professional_couple_2_profile_1774014510010.png';
const IMG_COMM_1 = '/Users/kiran/.gemini/antigravity/brain/8bcc0665-254c-43d9-8957-2e0c79d7e163/community_cover_1_outdoor_1774014529377.png';
const IMG_COMM_2 = '/Users/kiran/.gemini/antigravity/brain/8bcc0665-254c-43d9-8957-2e0c79d7e163/community_cover_2_city_1774014549456.png';

async function run() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(env.MONGODB_URI, { dbName: 'sawa_db' });
    console.log('Connected.');

    // 1. FLUSH DB
    console.log('Flushing DB...');
    await User.deleteMany({});
    await Couple.deleteMany({});
    await Community.deleteMany({});
    await Match.deleteMany({});
    await Message.deleteMany({});
    await Notification.deleteMany({});
    console.log('DB Flushed.');

    const CITIES = [
      'Bangalore',
      'Chennai',
      'New Delhi',
      'Mumbai',
      'Gurgaon',
      'Noida',
      'Hyderabad',
      'Goa',
    ];

    const couplesPerCity = [
      { name1: 'Arjun', name2: 'Meera', bio: 'Tech lovers in the heart of the city.', criteria: ['Tech', 'Innovation'] },
      { name1: 'Sameer', name2: 'Zara', bio: 'Foodies always exploring new cafes.', criteria: ['Food', 'Cafes'] },
    ];

    console.log('Seeding 2 couples per city...');
    let coupleCount = 0;
    for (const city of CITIES) {
      for (let i = 0; i < 2; i++) {
        coupleCount++;
        const config = couplesPerCity[i];
        const profileName = `${config.name1} & ${config.name2}`;
        const cId = `seed-couple-${city.toLowerCase().replace(/\s/g, '-')}-${i + 1}`;
        
        const partner1 = await User.create({
          phone: `+91${coupleCount}00000001`,
          name: config.name1,
          coupleId: cId,
          role: 'primary',
          isPhoneVerified: true
        });
        const partner2 = await User.create({
          phone: `+91${coupleCount}00000002`,
          name: config.name2,
          coupleId: cId,
          role: 'partner',
          isPhoneVerified: true
        });

        const newCouple = await Couple.create({
          coupleId: cId,
          partner1: partner1._id,
          partner2: partner2._id,
          profileName,
          location: { city, country: 'India' },
          bio: `${config.bio} Currently living in ${city}. Looking for fun-loving couples!`,
          primaryPhoto: `https://picsum.photos/seed/sawa_city_${city}_${i}/800/1200`,
          isProfileComplete: true,
          preferences: { matchCriteria: config.criteria }
        });

        // Add 1 community for each city (on the first couple of that city)
        if (i === 0) {
           await Community.create({
             name: `${city} ${city === 'Goa' ? 'Sunset' : 'Active'} Club`,
             description: `A community for couples in ${city} who love to connect and share experiences.`,
             city,
             coverImageUrl: `https://picsum.photos/seed/sawa_comm_${city}/1200/800`,
             members: [newCouple._id],
             admins: [newCouple._id],
             tags: [city, 'Local', 'Social']
           });
        }
      }
    }

    console.log(`\nDB Seeded successfully with ${coupleCount} couples across ${CITIES.length} cities.`);

    console.log('\nDB Seeded successfully with professional profiles.');
    process.exit(0);

  } catch (err) {
    console.error('Seed error:', err);
    process.exit(1);
  }
}

run();
