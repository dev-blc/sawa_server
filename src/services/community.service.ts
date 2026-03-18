import mongoose from 'mongoose';
import { Community } from '../models/Community.model';
import { Couple } from '../models/Couple.model';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

// Initial Seed data (mirrors the frontend static mock data shape)
const INITIAL_COMMUNITIES = [
  {
    name: 'Wanderlusters Club',
    description: 'We love exploring new places, hunting for hidden gems, and sharing travel stories. If you pack a bag every other weekend, join us!',
    city: 'Bangalore',
    maxMembers: 200,
    tags: ['Travel', 'Adventure'],
    coverImageUrl: 'https://images.unsplash.com/photo-1517868866752-1df6b7cbe390?auto=format&fit=crop&w=800&q=80',
  },
  {
    name: 'Weekend Foodies',
    description: 'A community for couples who bond over finding the best brunch spots, hidden cafes, and street food. Bring your appetite!',
    city: 'Chennai',
    maxMembers: 150,
    tags: ['Food', 'Social'],
    coverImageUrl: 'https://images.unsplash.com/photo-1502301103665-0b95cc738daf?auto=format&fit=crop&w=800&q=80',
  },
  {
    name: 'Board Game Knights',
    description: 'For couples who get overly competitive playing Catan, Monopoly, or obscure indie board games. Snacks are mandatory.',
    city: 'Mumbai',
    maxMembers: 100,
    tags: ['Games', 'Indoor'],
    coverImageUrl: 'https://images.unsplash.com/photo-1610443209569-a1b4d00d72de?auto=format&fit=crop&w=800&q=80',
  },
];

export class CommunityService {
  async ensureSeeded(creatorId: mongoose.Types.ObjectId) {
    const count = await Community.countDocuments();
    if (count === 0) {
      logger.info('[CommunityService] Seeding initial communities...');
      for (const comm of INITIAL_COMMUNITIES) {
        await Community.create({
          ...comm,
          admins: [creatorId],
          members: [creatorId], // The seeded requester is automatically a member
        });
      }
    }
  }

  async getAllCommunities(requestingCoupleId: string) {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
    if (!me) throw new AppError('Profile not found', 404);

    await this.ensureSeeded(me._id);

    const comms = await Community.find();

    return comms.map(c => ({
      id: c._id,
      title: c.name,
      about: c.description,
      city: c.city,
      couples: c.members.length,
      imageUri: c.coverImageUrl,
      isMember: c.members.includes(me._id as any) || c.members.some(m => m.toString() === me._id.toString()),
      joinRequest: {
        name: 'Rahul & Priya', // Dummy request for UI mapping
        city: 'New Delhi',
      },
      members: Array.from({ length: c.members.length }).map((_, i) => ({
        id: `member-${i}`,
        name: `Couple ${i + 1}`,
        city: c.city,
        accent: '#DBCBA6'
      }))
    }));
  }

  async getMyCommunities(requestingCoupleId: string) {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
    if (!me) throw new AppError('Profile not found', 404);

    const comms = await Community.find({ members: me._id });
    // In our seed, the requester is in all of them by default.

    return comms.map(c => ({
      id: c._id,
      title: c.name,
      about: c.description,
      city: c.city,
      couples: c.members.length,
      imageUri: c.coverImageUrl,
      isMember: true,
      joinRequest: {
        name: 'Rahul & Priya',
        city: 'New Delhi',
      },
      members: [] // Unused in list
    }));
  }

  async joinCommunity(requestingCoupleId: string, communityId: string, note?: string) {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
    if (!me) throw new AppError('Profile not found', 404);

    const community = await Community.findById(communityId);
    if (!community) throw new AppError('Community not found', 404);

    if (community.members.includes(me._id as any)) {
      return { status: 'already-member' };
    }

    // Usually you'd push to joinRequests and let admin approve,
    // but for UI flow we will just add them immediately.
    community.members.push(me._id as any);
    await community.save();

    return { status: 'joined', message: note ? 'Join request sent with note' : 'Joined community' };
  }
}

export const communityService = new CommunityService();
