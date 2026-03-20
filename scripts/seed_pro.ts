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

    // 2. SEED COUPLE 1
    console.log('Seeding Couple 1 (Alex & Sarah)...');
    const c1Id = 'seed-couple-1111-2222';
    const u1 = await User.create({
      phone: '+1111111111',
      name: 'Alex',
      email: 'alex@example.com',
      coupleId: c1Id,
      role: 'primary',
      isPhoneVerified: true
    });
    const u2 = await User.create({
      phone: '+1111111112',
      name: 'Sarah',
      email: 'sarah@example.com',
      coupleId: c1Id,
      role: 'partner',
      isPhoneVerified: true
    });
    const couple1 = await Couple.create({
      coupleId: c1Id,
      partner1: u1._id,
      partner2: u2._id,
      profileName: 'Alex & Sarah',
      relationshipStatus: 'Married',
      bio: 'We are a career-driven couple living in the city. We love weekend brunch, modern art, and staying active with coastal walks.',
      primaryPhoto: getBase64(IMG_COUPLE_1),
      isProfileComplete: true,
      preferences: {
        matchCriteria: ['City explorers', 'Brunch lovers', 'Professional couples']
      }
    });

    // 3. SEED COUPLE 2 (Mark & Elena) - Bangalore
    console.log('Seeding Couple 2 (Mark & Elena)...');
    const c2Id = 'seed-couple-3333-4444';
    const u3 = await User.create({
      phone: '+2222222221',
      name: 'Mark',
      email: 'mark@example.com',
      coupleId: c2Id,
      role: 'primary',
      isPhoneVerified: true
    });
    const u4 = await User.create({
      phone: '+2222222222',
      name: 'Elena',
      email: 'elena@example.com',
      coupleId: c2Id,
      role: 'partner',
      isPhoneVerified: true
    });
    const couple2 = await Couple.create({
      coupleId: c2Id,
      partner1: u3._id,
      partner2: u4._id,
      profileName: 'Mark & Elena',
      relationshipStatus: 'Engaged',
      location: { city: 'Bangalore', country: 'India' },
      bio: 'Nature lovers and weekend hikers. We recently moved to Bangalore and are looking for other couples who enjoy the outdoors and casual dinner parties.',
      primaryPhoto: getBase64(IMG_COUPLE_2),
      isProfileComplete: true,
      preferences: {
        matchCriteria: ['Hikers', 'Outdoor fans', 'Down-to-earth']
      }
    });

    // 4. SEED COUPLE 3 (Vikram & Priya) - Chennai
    console.log('Seeding Couple 3 (Vikram & Priya)...');
    const c3Id = 'seed-couple-5555-6666';
    const u5 = await User.create({ phone: '+3333333331', name: 'Vikram', coupleId: c3Id, role: 'primary', isPhoneVerified: true });
    const u6 = await User.create({ phone: '+3333333332', name: 'Priya', coupleId: c3Id, role: 'partner', isPhoneVerified: true });
    await Couple.create({
      coupleId: c3Id,
      partner1: u5._id,
      partner2: u6._id,
      profileName: 'Vikram & Priya',
      location: { city: 'Chennai', country: 'India' },
      bio: 'Die-hard foodies in Chennai. We know all the best spots for filter coffee and fine dining. Let\'s explore the culinary scene together!',
      primaryPhoto: 'https://picsum.photos/seed/sawa3/800/1200',
      isProfileComplete: true,
    });

    // 5. SEED COUPLE 4 (Rohan & Sonal) - Goa
    console.log('Seeding Couple 4 (Rohan & Sonal)...');
    const c4Id = 'seed-couple-7777-8888';
    const u7 = await User.create({ phone: '+4444444441', name: 'Rohan', coupleId: c4Id, role: 'primary', isPhoneVerified: true });
    const u8 = await User.create({ phone: '+4444444442', name: 'Sonal', coupleId: c4Id, role: 'partner', isPhoneVerified: true });
    await Couple.create({
      coupleId: c4Id,
      partner1: u7._id,
      partner2: u8._id,
      profileName: 'Rohan & Sonal',
      location: { city: 'Goa', country: 'India' },
      bio: 'Beach lovers living the dream in Goa. We love sunset surfing, beach shacks, and hosting bonfire nights.',
      primaryPhoto: 'https://picsum.photos/seed/sawa4/800/1200',
      isProfileComplete: true,
    });

    // 6. SEED COMMUNITIES
    console.log('Seeding Communities...');
    await Community.create({
      name: 'Urban Explorers',
      description: 'A community for couples who love discovering hidden gems in the city.',
      city: 'Mumbai',
      coverImageUrl: getBase64(IMG_COMM_2),
      members: [couple1._id],
      admins: [couple1._id],
      tags: ['City Life', 'Culture', 'Nightlife']
    });

    await Community.create({
      name: 'Weekend Brunch Club',
      description: 'Dedicated to the finest art of brunching.',
      city: 'Mumbai',
      coverImageUrl: getBase64(IMG_COMM_1),
      members: [couple2._id],
      admins: [couple2._id],
      tags: ['Foodies', 'Social', 'Brunch']
    });

    console.log('\nDB Seeded successfully with professional profiles.');
    process.exit(0);

  } catch (err) {
    console.error('Seed error:', err);
    process.exit(1);
  }
}

run();
