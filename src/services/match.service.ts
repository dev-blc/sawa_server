import mongoose from 'mongoose';
import { Couple } from '../models/Couple.model';
import { Match, IMatch } from '../models/Match.model';
import { Notification } from '../models/Notification.model';
import { Message } from '../models/Message.model';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

export class MatchService {
  /**
   * Fetches the discovery feed of couples for the current user.
   * Exclusively fetches real users from the database.
   */
  async getDiscoveryFeed(requestingCoupleId: string, cityFilter?: string, coupleMongoId?: string) {
    let me;
    if (coupleMongoId) {
      me = await Couple.findById(coupleMongoId);
    } else {
      me = await Couple.findOne({ coupleId: requestingCoupleId });
    }
    
    if (!me) throw new AppError('Couple profile not found', 404);

    const blockedIds = me.blocked || [];

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

    // Get all couple _ids that we have already interacted with
    const interactions = await Match.find({ couple1: me._id }).select('couple2');
    const interactedIds = interactions.map(m => m.couple2);

    // Build query
    const query: any = {
       _id: { $ne: me._id, $nin: [...interactedIds, ...blockedIds] },
       isProfileComplete: true, 
    };

    // Rule: "if the location is not listed in the country then show all the couples from all the citeit"
    // "if i change it to chennai couples in chennai only shown"
    if (cityFilter && cityFilter !== 'All City' && cityFilter !== 'All Cities' && cityFilter !== 'Unknown') {
       const isSupported = SUPPORTED_CITIES.some(c => cityFilter.toLowerCase().includes(c.toLowerCase()));
       if (isSupported) {
          // It's a major city, filter strictly
          query['location.city'] = { $regex: new RegExp(cityFilter, 'i') };
       }
       // If not supported (e.g. Mountain View), query stays generic (All Cities)
    }

    // Find couples that are not us, and not interacted with
    let potentialCouples = await Couple.find(query).limit(10); // Fetch up to 10 at a time

    // Decorate the couples with dummy insights and tags
    return potentialCouples.map(c => ({
      _id: c._id,
      coupleId: c.coupleId,
      profileName: c.profileName,
      primaryPhoto: c.primaryPhoto || 'https://images.unsplash.com/photo-1511285560929-80b456fea0bc?auto=format&fit=crop&w=400&q=80',
      location: c.location?.city || 'Unknown',
      distance: Math.floor(Math.random() * 10) + 2 + ' km away', // dummy distance
      tags: ['Discovery', 'Adventure', 'Book', 'Fitness'].sort(() => 0.5 - Math.random()).slice(0, 3), 
      matchScore: Math.floor(Math.random() * 20) + 80, 
      insights: [
        'Both career-focused and socially intentional',
        'Similar pace - you both prefer meeting once or twice a month',
      ]
    }));
  }

  /**
   * Say hello (like) to a couple
   */
  async sayHello(requestingCoupleId: string, targetCoupleIdStr: string, coupleMongoId?: string) {
    let me;
    if (coupleMongoId) {
      // Small optimization: we still need profileName for notification, but we can skip the full lookup if we trust the caller
      // Actually, for simplicity and safety, we might still want to find 'me' if we need their profileName
      me = await Couple.findOne({ coupleId: requestingCoupleId });
    } else {
      me = await Couple.findOne({ coupleId: requestingCoupleId });
    }
    
    if (!me) throw new AppError('Profile not found', 404);

    // Transient dummy support
    // Try to find the target couple. We check BOTH _id (ObjectId) and coupleId (UUID).
    let targetCouple;
    if (mongoose.Types.ObjectId.isValid(targetCoupleIdStr)) {
      targetCouple = await Couple.findById(targetCoupleIdStr);
    } 
    
    if (!targetCouple) {
      targetCouple = await Couple.findOne({ coupleId: targetCoupleIdStr });
    }

    if (!targetCouple) {
       // If still not found, it's a dummy or deleted
       logger.info(`[MatchService] Say Hello for dummy or unknown couple ${targetCoupleIdStr} - success (no DB)`);
       return { isMatch: false };
    }

    // Find if any match exists between us in any direction
    let existingMatch = await Match.findOne({
      $or: [
        { couple1: me._id, couple2: targetCouple._id },
        { couple1: targetCouple._id, couple2: me._id }
      ]
    });

    if (existingMatch) {
      // If it was skipped by us before, we can't like it now (unless we reset)
      // But for this logic, we check if it was pending and NOT by us
      if (existingMatch.status === 'pending' && existingMatch.actionBy.toString() !== me._id.toString()) {
         // Mutual like!
          existingMatch.status = 'accepted';
          existingMatch.actionBy = me._id;
          await existingMatch.save();

          // Create notifications for both
          await Notification.create({
            recipient: me._id,
            sender: targetCouple._id,
            type: 'match',
            title: "You've Connected!",
            message: `You connected with ${targetCouple.profileName}! Say hello.`,
            data: { matchId: existingMatch._id, coupleName: targetCouple.profileName }
          });

          await Notification.create({
            recipient: targetCouple._id,
            sender: me._id,
            type: 'match',
            title: "You've Connected!",
            message: `You connected with ${me.profileName}! Say hello.`,
            data: { matchId: existingMatch._id, coupleName: me.profileName }
          });

          return { isMatch: true, matchId: existingMatch._id };
       }
      
      // If we already liked them, or already accepted
      return { 
        isMatch: existingMatch.status === 'accepted',
        matchId: existingMatch._id
      };
    }

    // Otherwise, create a pending like
    const newMatch = await Match.create({
      couple1: me._id,
      couple2: targetCouple._id,
      status: 'pending',
      actionBy: me._id,
    });

    // Create a notification for the recipient (BACKGROUND)
    (async () => {
      try {
        await Notification.create({
          recipient: targetCouple._id,
          sender: me._id,
          type: 'match',
          title: "New Connection Request! ❤️",
          message: `${me.profileName} wants to connect with you! Say hello back to start chatting.`,
          data: { 
            matchId: newMatch._id, 
            coupleId: me.coupleId, 
            profileName: me.profileName,
            isPending: true 
          }
        });
      } catch (err) {
        logger.error(`[MatchService] Background notification failed:`, err);
      }
    })();

    logger.info(`[MatchService] Created pending match for ${targetCoupleIdStr}`);
    return { isMatch: false };
  }

  /**
   * Skip a couple
   */
  async skipCouple(requestingCoupleId: string, targetCoupleIdStr: string) {
    // 1. We still need our own _id. Try to get it efficiently (just skip if not found)
    const me = await Couple.findOne({ coupleId: requestingCoupleId }).select('_id');
    if (!me) throw new AppError('Profile not found', 404);

    // 2. We don't strictly need to verify the target couple exists if we just want to create a match record
    // But we need their Mongo _id. If the targetCoupleIdStr is an ObjectId, we use it directly.
    let targetId: any = targetCoupleIdStr;
    if (!mongoose.Types.ObjectId.isValid(targetCoupleIdStr)) {
       const target = await Couple.findOne({ coupleId: targetCoupleIdStr }).select('_id');
       if (!target) return { skipped: true }; // Just ignore if target not in DB
       targetId = target._id;
    }

    // 3. Create the skip record
    await Match.create({
      couple1: me._id,
      couple2: targetId,
      status: 'skipped',
      actionBy: me._id,
    });

    logger.info(`[MatchService] Skipped couple ${targetCoupleIdStr}`);
    return { skipped: true };
  }

  /**
   * Get all incoming connection requests (`Who wants to connect`)
   */
  async getIncomingRequests(requestingCoupleId: string, coupleMongoId?: string) {
    let meId;
    if (coupleMongoId) {
      meId = new mongoose.Types.ObjectId(coupleMongoId);
    } else {
      const me = await Couple.findOne({ coupleId: requestingCoupleId }).select('_id');
      if (!me) throw new AppError('Profile not found', 404);
      meId = me._id;
    }

    const pending = await Match.find({ 
      couple2: meId, 
      status: 'pending' 
    })
    .populate({
      path: 'couple1',
      select: 'profileName primaryPhoto location coupleId'
    })
    .lean();

    return (pending as any[])
      .map((m) => {
        const otherCouple = m.couple1;
        if (!otherCouple) return null;

        return {
          _id: m._id,
          coupleId: otherCouple.coupleId,
          profileName: otherCouple.profileName || 'Someone',
          primaryPhoto: otherCouple.primaryPhoto,
          location: otherCouple.location?.city || 'Unknown',
          distance: Math.floor(Math.random() * 8) + 1 + 'km away',
          status: 'pending',
          createdAt: m.createdAt
        };
      })
      .filter(Boolean);
  }

  /**
   * Get all accepted matches for a couple (`New connections`)
   */
  async getMatches(requestingCoupleId: string, coupleMongoId?: string) {
    let meId;
    if (coupleMongoId) {
      meId = new mongoose.Types.ObjectId(coupleMongoId);
    } else {
      const me = await Couple.findOne({ coupleId: requestingCoupleId }).select('_id');
      if (!me) throw new AppError('Profile not found', 404);
      meId = me._id;
    }

    const matches = await Match.find({ 
      $or: [{ couple1: meId }, { couple2: meId }], 
      status: 'accepted' 
    })
    .populate({
      path: 'couple1',
      select: 'profileName primaryPhoto location coupleId'
    })
    .populate({
      path: 'couple2',
      select: 'profileName primaryPhoto location coupleId'
    })
    .lean();

    return (matches as any[])
      .map((m) => {
        const c1Id = m.couple1?._id?.toString();
        const c2Id = m.couple2?._id?.toString();
        
        if (!c1Id || !c2Id) return null;

        const isMeCouple1 = c1Id === meId.toString();
        const otherCouple = isMeCouple1 ? m.couple2 : m.couple1;

        if (!otherCouple) return null;

        return {
          _id: m._id,
          coupleId: otherCouple.coupleId,
          profileName: otherCouple.profileName || 'Unknown Couple',
          primaryPhoto: otherCouple.primaryPhoto,
          location: otherCouple.location?.city || 'Unknown',
          distance: Math.floor(Math.random() * 8) + 1 + 'km away',
          status: m.status,
        };
      })
      .filter(Boolean);
  }

  /**
   * Explicitly accept a pending connection
   */
  async acceptMatch(requestingCoupleId: string, targetCoupleIdStr: string, coupleMongoId?: string) {
    // This essentially Reuses sayHello logic which handles mutual likes
    return this.sayHello(requestingCoupleId, targetCoupleIdStr, coupleMongoId);
  }

  /**
   * Explicitly reject a pending connection
   */
  async rejectMatch(requestingCoupleId: string, targetCoupleIdStr: string) {
    let meId;
    const me = await Couple.findOne({ coupleId: requestingCoupleId }).select('_id');
    if (!me) throw new AppError('Profile not found', 404);
    meId = me._id;

    let targetId: any = targetCoupleIdStr;
    if (!mongoose.Types.ObjectId.isValid(targetCoupleIdStr)) {
       const target = await Couple.findOne({ coupleId: targetCoupleIdStr }).select('_id');
       if (!target) throw new AppError('Target profile not found', 404);
       targetId = target._id;
    }

    // Delete the match or mark as rejected
    await Match.findOneAndDelete({
      $or: [
        { couple1: meId, couple2: targetId },
        { couple1: targetId, couple2: meId }
      ],
      status: 'pending'
    });

    // Option: notify the other couple of rejection (silent usually, but user asked for it)
    const target = await Couple.findById(targetId);
    if (target) {
       await Notification.create({
          recipient: target._id,
          sender: meId,
          type: 'alert',
          title: "Connection Update",
          message: "A couple decided not to connect at this time. Keep exploring!",
       });
    }

    return { success: true };
  }

  /**
   * Refresh discovery feed by clearing all SKIPPED matches for the current couple.
   * This allows them to see those couples again.
   */
  async refreshDiscovery(requestingCoupleId: string) {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
    if (!me) throw new AppError('Profile not found', 404);

    // Delete all matches that are NOT accepted (Reset skipped and pending)
    await Match.deleteMany({
      $or: [{ couple1: me._id }, { couple2: me._id }],
      status: { $in: ['skipped', 'pending'] }
    });

    return { success: true };
  }
}

export const matchService = new MatchService();
