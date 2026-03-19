import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { User } from '../models/User.model';
import { Couple } from '../models/Couple.model';
import { Community } from '../models/Community.model';
import { Message } from '../models/Message.model';
import { Match } from '../models/Match.model';
import { logger } from '../utils/logger';

// Load env from root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';

const COUPLES = [
  {
    coupleId: 'seed_couple_1',
    primaryPhoto: 'https://images.unsplash.com/photo-1583511655857-d19b40a7a54e?auto=format&fit=crop&q=80&w=800',
    profileName: 'Aisha & Rohan',
    bio: 'Big foodies looking to explore new cafes and host weekend dinners! ☕️🍕',
    relationshipStatus: 'Married',
    location: { city: 'Bengaluru', country: 'India' },
    isProfileComplete: true,
    answers: [{ questionId: 'q1', selectedOptionIds: ['q1-career'] }]
  },
  {
    coupleId: 'seed_couple_2',
    primaryPhoto: 'https://images.unsplash.com/photo-1591035897819-f4bdf739f446?auto=format&fit=crop&q=80&w=800',
    profileName: 'Priya & Rahul',
    bio: 'Avid travelers and hikers. Always planning the next weekend trip. 🏔️✈️',
    relationshipStatus: 'Engaged',
    location: { city: 'Mumbai', country: 'India' },
    isProfileComplete: true,
    answers: [{ questionId: 'q1', selectedOptionIds: ['q1-living'] }]
  },
  {
    coupleId: 'seed_couple_3',
    primaryPhoto: 'https://images.unsplash.com/photo-1516589178581-6cd7833ae3b2?auto=format&fit=crop&q=80&w=800',
    profileName: 'Simran & Kunal',
    bio: 'Introverted couple who love art, cultural events, and quiet wine nights. 🎨🍷',
    relationshipStatus: 'Dating',
    location: { city: 'New Delhi', country: 'India' },
    isProfileComplete: true,
    answers: [{ questionId: 'q1', selectedOptionIds: ['q1-settled'] }]
  },
  {
    coupleId: 'seed_couple_4',
    primaryPhoto: 'https://images.unsplash.com/photo-1533038595267-37e51c1c73ec?auto=format&fit=crop&q=80&w=800',
    profileName: 'Kavita & Amit',
    bio: 'Tennis partners and fitness enthusiasts. Looking for other active couples! 🎾💪',
    relationshipStatus: 'Married',
    location: { city: 'Bengaluru', country: 'India' },
    isProfileComplete: true,
    answers: [{ questionId: 'q1', selectedOptionIds: ['q1-settled'] }]
  },
  {
    coupleId: 'seed_couple_5',
    primaryPhoto: 'https://images.unsplash.com/photo-1491438590914-bc09fcaaf77a?auto=format&fit=crop&q=80&w=800',
    profileName: 'Zara & Neel',
    bio: 'Techies by day, musicians by night. Love jam sessions and live gigs. 🎸🎹',
    relationshipStatus: 'Dating',
    location: { city: 'Bengaluru', country: 'India' },
    isProfileComplete: true,
    answers: [{ questionId: 'q1', selectedOptionIds: ['q1-career'] }]
  },
  {
    coupleId: 'seed_couple_6',
    primaryPhoto: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&q=80&w=800',
    profileName: 'Anjali & Vikram',
    bio: 'Passionate about sustainable living and weekend farming. 🌿🐥',
    relationshipStatus: 'Married',
    location: { city: 'Pune', country: 'India' },
    isProfileComplete: true,
    answers: [{ questionId: 'q1', selectedOptionIds: ['q1-settled'] }]
  }
];

const COMMUNITIES = [
  {
    name: 'Gourmet Couples Club',
    description: 'A community for couples who bond over finding the best brunch spots, hidden cafes, and street food. Bring your appetite!',
    city: 'All Cities',
    coverImageUrl: 'https://images.unsplash.com/photo-1514362545857-3bc16c4c7d1b?auto=format&fit=crop&q=80&w=800',
    tags: ['Food', 'Social', 'Experience']
  },
  {
    name: 'Brew & Bond',
    description: 'We love testing out new microbreweries and hidden culinary gems across Indiranagar, Koramangala and beyond!',
    city: 'Bengaluru',
    coverImageUrl: 'https://images.unsplash.com/photo-1511081692775-05d0f180a065?auto=format&fit=crop&q=80&w=800',
    tags: ['Coffee', 'Drinks', 'Network']
  },
  {
    name: 'Mumbai Art Crawl',
    description: 'Exploring art galleries, experimental theatre, and vibrant cultural exhibitions through the city together.',
    city: 'Mumbai',
    coverImageUrl: 'https://images.unsplash.com/photo-1460661419201-fd4cecdf8a8b?auto=format&fit=crop&q=80&w=800',
    tags: ['Art', 'Culture', 'Museums']
  },
  {
    name: 'Beach & Chill',
    description: 'For couples based in or visiting Chennai who love beach volleyball, sunrise yoga, or just watching the waves at Marina.',
    city: 'Chennai',
    coverImageUrl: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&q=80&w=800',
    tags: ['Beach', 'Outdoor', 'Relax']
  }
];

const seedData = async () => {
  try {
    const MONGO_URI_BASE = process.env.MONGODB_URI || 'mongodb://localhost:27017';
    
    // 1. CLEAN DEFAULT DB (remove old seed)
    logger.info('Cleaning default database...');
    await mongoose.connect(MONGO_URI_BASE);
    await User.deleteMany({ phone: { $regex: /^seed_phone/ } });
    await Couple.deleteMany({ coupleId: { $regex: /^seed_couple/ } });
    await mongoose.disconnect();

    // 2. SEED SAWA_DB
    logger.info('Seeding sawa_db...');
    await mongoose.connect(MONGO_URI_BASE, { dbName: 'sawa_db' });
    
    // Delete only seed entities to preserve user's real accounts
    await User.deleteMany({ phone: { $regex: /^seed_phone/ } });
    await Couple.deleteMany({ coupleId: { $regex: /^seed_couple/ } });
    await Community.deleteMany({});
    await Message.deleteMany({});
    await Match.deleteMany({});

    // Seed Couples & Users
    for (let i = 0; i < COUPLES.length; i++) {
       const cd = COUPLES[i];
       const user1 = await User.create({
         phone: `seed_phone1_${i}`,
         name: cd.profileName.split(' & ')[0],
         coupleId: cd.coupleId,
         role: 'primary',
         isPhoneVerified: true
       });
       const user2 = await User.create({
         phone: `seed_phone2_${i}`,
         name: cd.profileName.split(' & ')[1],
         coupleId: cd.coupleId,
         role: 'partner',
         isPhoneVerified: true
       });
       await Couple.create({
         ...cd,
         partner1: user1._id,
         partner2: user2._id
       });
    }

    const allCouples = await Couple.find({ coupleId: { $regex: /^seed_couple/ } });
    for (let i = 0; i < COMMUNITIES.length; i++) {
        const commData = COMMUNITIES[i];
        const member1 = allCouples[i % allCouples.length]._id;
        const member2 = allCouples[(i + 1) % allCouples.length]._id;
        await Community.create({
          ...commData,
          members: [member1, member2],
          admins: [member1]
        });
    }

    logger.info('Seeding complete in sawa_db!');
    process.exit(0);
  } catch (error) {
    logger.error('Error during seeding:', error);
    process.exit(1);
  }
};

seedData();
