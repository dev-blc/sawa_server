import { prisma } from '../lib/prisma';
import bcrypt from 'bcryptjs';

const COUPLES = [
  {
    coupleId: 'seed_couple_1',
    primaryPhoto: 'https://images.unsplash.com/photo-1583511655857-d19b40a7a54e?auto=format&fit=crop&q=80&w=800',
    profileName: 'Aisha & Rohan',
    bio: 'Big foodies looking to explore new cafes!',
    relationshipStatus: 'Married',
    locationCity: 'Bengaluru',
    locationCountry: 'India',
    isProfileComplete: true,
    answers: [{ questionId: 'q1', selectedOptionIds: ['q1-career'] }]
  },
  {
    coupleId: 'seed_couple_2',
    primaryPhoto: 'https://images.unsplash.com/photo-1591035897819-f4bdf739f446?auto=format&fit=crop&q=80&w=800',
    profileName: 'Priya & Rahul',
    bio: 'Avid travelers and hikers.',
    relationshipStatus: 'Engaged',
    locationCity: 'Mumbai',
    locationCountry: 'India',
    isProfileComplete: true,
    answers: [{ questionId: 'q1', selectedOptionIds: ['q1-living'] }]
  }
];

const COMMUNITIES = [
  {
    name: 'Gourmet Couples Club',
    description: 'A community for foodies.',
    city: 'All Cities',
    coverImageUrl: 'https://images.unsplash.com/photo-1514362545857-3bc16c4c7d1b?auto=format&fit=crop&q=80&w=800',
    tags: ['Food']
  }
];

async function seed() {
  try {
    console.log('🌱 Starting Seeding...');

    // 1. Seed Admin
    const adminEmail = 'admin@gmail.com';
    const adminPass = await bcrypt.hash('adminsawa', 10);
    await prisma.user.upsert({
      where: { email: adminEmail },
      update: { password: adminPass },
      create: { 
        email: adminEmail, 
        password: adminPass, 
        role: 'admin', 
        name: 'System Admin', 
        phone: '0000000000', 
        isPhoneVerified: true 
      }
    });
    console.log('✅ Admin seeded');

    // 2. Seed Prompts
    const prompts = [
      "What's your favorite family activity?",
      'Movie this weekend?',
      'Coffee sometime this week?',
      'Any plans for the holidays?',
    ];
    for (const text of prompts) {
      await prisma.prompt.upsert({
        where: { text },
        update: {},
        create: { text, category: 'chat_shortcut', isActive: true }
      });
    }
    console.log('✅ Prompts seeded');

    // 3. Seed Couples & Users
    for (let i = 0; i < COUPLES.length; i++) {
        const c = COUPLES[i];
        
        // Step A: Upsert Couple (no members yet)
        const couple = await prisma.couple.upsert({
            where: { coupleId: c.coupleId },
            update: {
                profileName: c.profileName,
                bio: c.bio,
                locationCity: c.locationCity,
                isProfileComplete: true
            },
            create: { 
                coupleId: c.coupleId,
                profileName: c.profileName,
                primaryPhoto: c.primaryPhoto,
                bio: c.bio,
                relationshipStatus: c.relationshipStatus,
                locationCity: c.locationCity,
                locationCountry: c.locationCountry,
                isProfileComplete: true,
                answers: {
                    create: (c.answers as any[]).map(a => ({
                        questionId: a.questionId,
                        selectedOptionIds: a.selectedOptionIds
                    }))
                }
            }
        });

        // Step B: Upsert Users (now they can point to coupleId)
        const u1 = await prisma.user.upsert({
            where: { phone: `seed_phone1_${i}` },
            update: { coupleId: c.coupleId },
            create: { 
                phone: `seed_phone1_${i}`, 
                name: c.profileName.split(' & ')[0], 
                coupleId: c.coupleId, 
                role: 'primary', 
                isPhoneVerified: true 
            }
        });
        const u2 = await prisma.user.upsert({
            where: { phone: `seed_phone2_${i}` },
            update: { coupleId: c.coupleId },
            create: { 
                phone: `seed_phone2_${i}`, 
                name: c.profileName.split(' & ')[1], 
                coupleId: c.coupleId, 
                role: 'partner', 
                isPhoneVerified: true 
            }
        });
        
        // Step C: Link partners back to couple
        await prisma.couple.update({
            where: { id: couple.id },
            data: { partner1Id: u1.id, partner2Id: u2.id }
        });
    }
    console.log('✅ Couples seeded');

    // 4. Seed Communities
    for (const comm of COMMUNITIES) {
        await prisma.community.upsert({
            where: { name: comm.name },
            update: {},
            create: {
                name: comm.name,
                description: comm.description,
                city: comm.city,
                coverImageUrl: comm.coverImageUrl,
                tags: comm.tags,
                admins: { create: { couple: { connect: { coupleId: COUPLES[0].coupleId } } } },
                members: { create: { couple: { connect: { coupleId: COUPLES[0].coupleId } } } }
            }
        });
    }
    console.log('✅ Communities seeded');

    console.log('🚀 Seeding complete!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seeding failed:', err);
    process.exit(1);
  }
}

seed();
