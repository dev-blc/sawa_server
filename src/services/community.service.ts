import mongoose from 'mongoose';
import { Community } from '../models/Community.model';
import { Couple } from '../models/Couple.model';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import { Notification } from '../models/Notification.model';
import { Match } from '../models/Match.model';

// Initial Seed data (mirrors the frontend static mock data shape)
const INITIAL_COMMUNITIES = [
  {
    name: 'Wanderlusters Club',
    description: 'We love exploring new places, hunting for hidden gems, and sharing travel stories. If you pack a bag every other weekend, join us!',
    city: 'Bangalore',
    maxMembers: 200,
    tags: ['Travel', 'Adventure'],
    coverImageUrl: 'https://images.pexels.com/photos/1271619/pexels-photo-1271619.jpeg?auto=compress&cs=tinysrgb&w=800',
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
    coverImageUrl: 'https://images.pexels.com/photos/278918/pexels-photo-278918.jpeg?auto=compress&cs=tinysrgb&w=800',
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

    return comms.map(c => {
      const isMember = c.members.some(m => m.toString() === me._id.toString());
      const isAdmin = c.admins.some(a => a.toString() === me._id.toString());
      
      return {
        id: c._id,
        title: c.name,
        about: c.description,
        city: c.city,
        couples: c.members.length,
        imageUri: c.coverImageUrl,
        isMember,
        isAdmin,
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
      };
    });
  }

  async getMyCommunities(requestingCoupleId: string) {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
    if (!me) throw new AppError('Profile not found', 404);

    const comms = await Community.find({ members: me._id });

    return comms.map(c => {
      const isAdmin = c.admins.some(a => a.toString() === me._id.toString());
      return {
        id: c._id,
        title: c.name,
        about: c.description,
        city: c.city,
        couples: c.members.length,
        imageUri: c.coverImageUrl,
        isMember: true,
        isAdmin,
        joinRequest: {
          name: 'Rahul & Priya',
          city: 'New Delhi',
        },
        members: [] // Unused in list
      };
    });
  }

  async createCommunity(requestingCoupleId: string, data: any) {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
    if (!me) throw new AppError('Profile not found', 404);

    const community = await Community.create({
      name: data.name,
      description: data.description,
      city: data.city,
      coverImageUrl: data.coverImageUrl,
      tags: data.tags,
      admins: [me._id],
      members: [me._id],
    });

    // Send notifications to invited couples
    if (data.invitedCoupleIds && data.invitedCoupleIds.length > 0) {
      for (const targetCoupleId of data.invitedCoupleIds) {
        try {
          // Verify they are matched/connected matches
          const match = await Match.findOne({
            $or: [
              { couple1: me._id, couple2: targetCoupleId, status: 'accepted' },
              { couple1: targetCoupleId, couple2: me._id, status: 'accepted' }
            ]
          });

          if (match) {
            await Notification.create({
              recipient: targetCoupleId,
              sender: me._id,
              type: 'community',
              title: 'Community Invitation',
              message: `${me.profileName} invited you to join their community: ${community.name}`,
              data: { communityId: community._id, name: community.name }
            });
          }
        } catch (err) {
          logger.error(`[CommunityService] Failed to notify couple ${targetCoupleId}: ${err}`);
        }
      }
    }

    return {
       id: community._id,
       name: community.name,
    };
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

    // ─── Phase 2: System Message & Notification ───
    // You could also create a Message record of type 'system' or 'couple-joined' here
    // but for now we'll just return success and let the client know.
    // In a real socket app, the server would emit 'chat:message' to the room now.


    return { status: 'joined', message: note ? 'Join request sent with note' : 'Joined community' };
  }

  async inviteToCommunity(requestingCoupleId: string, communityId: string, invitedCoupleIds: string[]) {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
    if (!me || !me.profileName) throw new AppError('Profile not found', 404);

    const community = await Community.findById(communityId);
    if (!community) throw new AppError('Community not found', 404);

    if (invitedCoupleIds.length > 0) {
      for (const targetCoupleId of invitedCoupleIds) {
        try {
          const match = await Match.findOne({
            $or: [
              { couple1: me._id, couple2: targetCoupleId, status: 'accepted' },
              { couple1: targetCoupleId, couple2: me._id, status: 'accepted' }
            ]
          });

          if (match) {
            await Notification.create({
              recipient: targetCoupleId,
              sender: me._id,
              type: 'community',
              title: 'Community Invitation',
              message: `${me.profileName} invited you to join their community: ${community.name}`,
              data: { communityId: community._id, name: community.name }
            });
          }
        } catch (err) {
          logger.error(`[CommunityService] Failed to notify couple ${targetCoupleId}: ${err}`);
        }
      }
    }
    return { success: true };
  }

  async getCommunityDetail(requestingCoupleId: string, communityId: string) {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
    if (!me) throw new AppError('Profile not found', 404);

    const c = await Community.findById(communityId).populate('members').populate('joinRequests');
    if (!c) throw new AppError('Community not found', 404);

    const isMember = c.members.some(m => m._id.toString() === me._id.toString());
    const isAdmin = c.admins.some(a => a.toString() === me._id.toString());

    return {
      id: c._id,
      title: c.name,
      about: c.description,
      city: c.city,
      couples: c.members.length,
      imageUri: c.coverImageUrl,
      isMember,
      isAdmin,
      members: (c.members as any).map((m: any) => ({
        id: m._id, // Internal ID for keys
        coupleId: m.coupleId, // Business ID for profile navigation
        name: m.profileName,
        city: m.location?.city || 'Unknown',
        accent: '#DBCBA6',
        image: m.primaryPhoto,
      })),
      joinRequests: isAdmin ? (c.joinRequests as any).map((m: any) => ({
        id: m._id,
        coupleId: m.coupleId,
        name: m.profileName,
        city: m.location?.city || 'Unknown',
        accent: '#3CA6C7',
        image: m.primaryPhoto,
      })) : []
    };
  }

  async deleteCommunity(requestingCoupleId: string, communityId: string) {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
    if (!me) throw new AppError('Profile not found', 404);

    const community = await Community.findById(communityId);
    if (!community) throw new AppError('Community not found', 404);

    // Only actual admins can delete
    const isAdmin = community.admins.some(a => a.toString() === me._id.toString());
    if (!isAdmin) {
      throw new AppError('Only administrators can delete this community', 403);
    }

    await Community.findByIdAndDelete(communityId);
    return { success: true };
  }

  async getInviteableCouples(requestingCoupleId: string, communityId: string) {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
    if (!me) throw new AppError('Profile not found', 404);

    const community = await Community.findById(communityId);
    if (!community) throw new AppError('Community not found', 404);

    // 1. Get all accepted matches (friends)
    const matches = await Match.find({
      $or: [{ couple1: me._id }, { couple2: me._id }],
      status: 'accepted'
    }).populate('couple1').populate('couple2');

    // 2. Find internal notifications that are pending invites for this community
    // Using simple heuristic: community notification from 'me' with this communityId
    const pendingInvites = await Notification.find({
      sender: me._id,
      type: 'community',
      'data.communityId': new mongoose.Types.ObjectId(communityId),
    });

    const invitedIds = pendingInvites.map(n => n.recipient.toString());

    return matches.map(m => {
      const other = m.couple1._id.equals(me._id) ? (m.couple2 as any) : (m.couple1 as any);
      const otherId = other._id.toString();
      
      let status: 'available' | 'invited' | 'member' = 'available';
      
      if (community.members.some(mid => mid.toString() === otherId)) {
        status = 'member';
      } else if (invitedIds.includes(otherId)) {
        status = 'invited';
      }

      return {
        id: other._id,
        coupleId: other.coupleId,
        name: other.profileName,
        city: other.location?.city || 'India',
        image: other.primaryPhoto,
        status
      };
    });
  }
}

export const communityService = new CommunityService();
