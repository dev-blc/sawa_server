import mongoose from 'mongoose';
import { Community } from '../models/Community.model';
import { Couple } from '../models/Couple.model';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import { Notification } from '../models/Notification.model';
import { Match } from '../models/Match.model';

export class CommunityService {
  async getAllCommunities(requestingCoupleId: string, cityFilter?: string) {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
    if (!me) throw new AppError('Profile not found', 404);

    const SUPPORTED_CITIES = [
      'Bangalore',
      'Chennai',
      'New Delhi',
      'Delhi',
      'Mumbai',
      'Gurgaon',
      'Noida',
      'Hyderabad',
      'Goa',
    ];

    const query: any = {};
    if (cityFilter && cityFilter !== 'All City' && cityFilter !== 'All Cities' && cityFilter !== 'Unknown') {
       // Only filter by city if it's one of our primary supported cities
       const isSupported = SUPPORTED_CITIES.some(c => cityFilter.toLowerCase().includes(c.toLowerCase()));
       if (isSupported) {
          query.city = { $regex: new RegExp(cityFilter, 'i') };
       }
       // If not supported, we don't set query.city, which means it returns ALL (Show all communities)
    }

    const comms = await Community.find(query);
    logger.info(`🏘️  DB fetched ${comms.length} communities. Names: ${comms.map(c => c.name).join(', ')}`);

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
              recipient: new mongoose.Types.ObjectId(targetCoupleId),
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

    // Check if there is an active invite for this user
    const invitation = await Notification.findOne({
      $or: [{ recipient: me._id }, { recipient: me.coupleId as any }],
      type: 'community',
      'data.communityId': community._id,
    });

    if (invitation) {
       // Invited! Accept immediately.
       community.members.push(me._id as any);
       await community.save();
       
       const io = (global as any).io;
       if (io) {
          io.to(`chat:${community._id}`).emit('chat:message', {
             _id: new mongoose.Types.ObjectId(),
             chatId: community._id,
             chatType: 'group',
             senderCoupleId: 'system',
             content: `${me.profileName} accepted the invite and joined the community`,
             contentType: 'text',
             timestamp: new Date().toISOString(),
             isSystem: true
          });
       }
       return { status: 'joined', message: 'Joined community' };
    }

    // Otherwise, it's a normal join request
    if (community.joinRequests.includes(me._id as any)) {
      return { status: 'already-requested' };
    }

    community.joinRequests.push(me._id as any);
    await community.save();

    // Send notifications to all admins
    for (const adminId of community.admins) {
      await Notification.create({
        recipient: adminId,
        sender: me._id,
        type: 'community',
        title: 'New Join Request',
        message: `${me.profileName} wants to join ${community.name}${note ? `: "${note}"` : ''}`,
        data: { communityId: community._id, requestId: me._id }
      });
    }

    return { status: 'requested', message: 'Join request sent to host.' };
  }

  async leaveCommunity(requestingCoupleId: string, communityId: string) {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
    if (!me) throw new AppError('Profile not found', 404);

    const community = await Community.findById(communityId);
    if (!community) throw new AppError('Community not found', 404);

    community.members = community.members.filter(m => m.toString() !== me._id.toString());
    
    // If they were an admin, remove them
    const wasAdmin = community.admins.some(a => a.toString() === me._id.toString());
    community.admins = community.admins.filter(a => a.toString() !== me._id.toString());

    // If community has no admins but still has members, appoint a new one
    if (community.admins.length === 0 && community.members.length > 0) {
      community.admins.push(community.members[0]);
    }

    if (community.members.length === 0) {
      // Last person left, delete community?
      await Community.findByIdAndDelete(communityId);
      return { status: 'deleted' };
    }

    await community.save();

    const io = (global as any).io;
    if (io) {
      io.to(`chat:${community._id}`).emit('chat:message', {
        _id: new mongoose.Types.ObjectId(),
        chatId: community._id,
        chatType: 'group',
        senderCoupleId: 'system',
        content: `${me.profileName} left the community`,
        contentType: 'text',
        timestamp: new Date().toISOString(),
        isSystem: true
      });
    }

    return { status: 'left' };
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
              recipient: new mongoose.Types.ObjectId(targetCoupleId),
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

  async processJoinRequest(requestingCoupleId: string, communityId: string, requestId: string, decision: 'accept' | 'reject') {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
    if (!me) throw new AppError('Profile not found', 404);

    const community = await Community.findById(communityId);
    if (!community) throw new AppError('Community not found', 404);

    const isAdmin = community.admins.some(a => a.toString() === me._id.toString());
    if (!isAdmin) throw new AppError('Only administrators can approve join requests', 403);

    community.joinRequests = community.joinRequests.filter(req => req.toString() !== requestId);

    if (decision === 'accept') {
       if (!community.members.some(m => m.toString() === requestId)) {
          community.members.push(new mongoose.Types.ObjectId(requestId) as any);
       }
       await community.save();

       const requestedCouple = await Couple.findById(requestId);
       if (requestedCouple) {
          await Notification.create({
             recipient: requestedCouple._id,
             sender: me._id,
             type: 'community',
             title: 'Request Accepted!',
             message: `Your request to join ${community.name} was accepted!`,
             data: { communityId: community._id, name: community.name }
          });

          const io = (global as any).io;
          if (io) {
             io.to(`chat:${community._id}`).emit('chat:message', {
                _id: new mongoose.Types.ObjectId(),
                chatId: community._id,
                chatType: 'group',
                senderCoupleId: 'system',
                content: `${requestedCouple.profileName} just joined the community!`,
                contentType: 'text',
                timestamp: new Date().toISOString(),
                isSystem: true
             });
          }
       }
       return { message: 'Request accepted' };
    } else {
       await community.save();
       await Notification.create({
          recipient: new mongoose.Types.ObjectId(requestId),
          sender: me._id,
          type: 'system',
          title: 'Request Declined',
          message: `Your request to join ${community.name} was declined by the host.`,
          data: { communityId: community._id }
       });
       return { message: 'Request rejected' };
    }
  }

  async getCommunityDetail(requestingCoupleId: string, communityId: string) {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
    if (!me) throw new AppError('Profile not found', 404);

    const c = await Community.findById(communityId).populate('members').populate('joinRequests');
    if (!c) throw new AppError('Community not found', 404);

    const isMember = c.members.some(m => m._id.toString() === me._id.toString());
    const isAdmin = c.admins.some(a => a.toString() === me._id.toString());
    
    // Check if there's a pending invitation for this couple (even if they read the notification already)
    const invitation = await Notification.findOne({
      $or: [{ recipient: me._id }, { recipient: me.coupleId as any }],
      type: 'community',
      'data.communityId': c._id,
    });

    const adminCouples = await Couple.find({ _id: { $in: c.admins } })
      .populate('partner1', 'name')
      .populate('partner2', 'name')
      .lean();

    /** One row per hosting couple (combined profile — same shape as `members` items). */
    const hosts = adminCouples.map((ac) => {
      const city = ac.location?.city || 'Unknown';
      const p1 = ac.partner1 as { name?: string } | null;
      const p2 = ac.partner2 as { name?: string } | null;
      let name = (ac.profileName || '').trim();
      if (!name) {
        const a = p1?.name?.trim();
        const b = p2?.name?.trim();
        if (a && b) name = `${a} & ${b}`;
        else name = a || b || 'Host';
      }
      return {
        id: String(ac._id),
        coupleId: ac.coupleId,
        name,
        city,
        accent: '#DBCBA6',
        image: ac.primaryPhoto,
      };
    });

    return {
      id: c._id,
      title: c.name,
      about: c.description,
      city: c.city,
      couples: c.members.length,
      imageUri: c.coverImageUrl,
      isMember,
      isAdmin,
      isInvited: !!invitation,
      hosts,
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
