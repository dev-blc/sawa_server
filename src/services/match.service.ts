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
   * If there are no seeded couples in the database other than the requester, 
   * this seeds a dummy couple (Arjun & Meera) to test the UI.
   */
  async getDiscoveryFeed(requestingCoupleId: string, cityFilter?: string) {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
    if (!me) throw new AppError('Couple profile not found', 404);

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
       _id: { $ne: me._id, $nin: interactedIds },
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

    // --- Developer Seed Fallback ---
    // If empty or too few (because it's just the user testing), provide more dummy couples
    if (potentialCouples.length < 3) {
      logger.info(`[MatchService] Discovery feed too small (${potentialCouples.length}), adding dummy fallbacks`);
      
      const dummyData = [
        { name: 'Arjun & Meera', photo: 'https://picsum.photos/seed/sawa1/800/1200' },
        { name: 'Sameer & Zara', photo: 'https://picsum.photos/seed/sawa2/800/1200' },
        { name: 'Rohan & Ananya', photo: 'https://picsum.photos/seed/sawa3/800/1200' },
        { name: 'Ishaan & Maya', photo: 'https://picsum.photos/seed/sawa4/800/1200' },
      ];

      for (const d of dummyData) {
        // Only add if not already in the list by name
        if (!potentialCouples.some(c => c.profileName === d.name)) {
           // We create temporary transient objects for the feed if they don't exist in DB
           // but for actual interaction safety we should technically check DB
           const mockId = new mongoose.Types.ObjectId();
           potentialCouples.push({
             _id: mockId,
             coupleId: `dummy-${mockId.toString().slice(-6)}`,
             profileName: d.name,
             primaryPhoto: d.photo,
             location: { city: 'New Delhi', country: 'India' },
             isProfileComplete: true,
             answers: []
           } as any);
        }
      }
    }

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
  async sayHello(requestingCoupleId: string, targetCoupleIdStr: string) {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
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

    // Create a notification for the recipient
    await Notification.create({
      recipient: targetCouple._id,
      sender: me._id,
      type: 'match', // Using 'match' type but with pending status logic if needed
      title: "New Connection Request! ❤️",
      message: `${me.profileName} wants to connect with you! Say hello back to start chatting.`,
      data: { 
        matchId: newMatch._id, 
        coupleId: me.coupleId, 
        profileName: me.profileName,
        isPending: true 
      }
    });

    logger.info(`[MatchService] Created pending match and notification for ${targetCoupleIdStr}`);
    return { isMatch: false };
  }

  /**
   * Skip a couple
   */
  async skipCouple(requestingCoupleId: string, targetCoupleIdStr: string) {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
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
       logger.info(`[MatchService] skipCouple: Target couple ${targetCoupleIdStr} is dummy or not in DB. Already gone.`);
       return { skipped: true };
    }

    await Match.create({
      couple1: me._id,
      couple2: targetCouple._id,
      status: 'skipped',
      actionBy: me._id,
    });

    return { skipped: true };
  }

  /**
   * Get all accepted matches for a couple
   */
  async getMatches(requestingCoupleId: string) {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
    if (!me) throw new AppError('Profile not found', 404);

    // Find all matches where we are either couple1 or couple2 and status is accepted
    const [accepted, pending] = await Promise.all([
      Match.find({ $or: [{ couple1: me._id }, { couple2: me._id }], status: 'accepted' }).populate('couple1').populate('couple2'),
      Match.find({ $or: [{ couple1: me._id }, { couple2: me._id }], status: 'pending' }).populate('couple1').populate('couple2')
    ]);

    logger.info(`[MatchService] Accepted: ${accepted.length}, Pending: ${pending.length} for coupleId: ${requestingCoupleId} (ObjectId: ${me._id})`);

    // For debugging, we return ALL interactions that are not skipped/rejected
    // but filter to accepted for the main list if we want strictness.
    // The user said "connected", so we'll stick to 'accepted'.
    
    return accepted.filter(m => m.couple1 && m.couple2).map(m => {
      // Find the "other" couple
      // Compare as strings to be 100% safe against population variations
      const isMeCouple1 = m.couple1._id ? m.couple1._id.toString() === me._id.toString() : m.couple1.toString() === me._id.toString();
      const otherCouple = isMeCouple1 ? (m.couple2 as any) : (m.couple1 as any);
      
      return {
        _id: m._id, // This is the matchId
        coupleId: otherCouple?.coupleId || 'unknown',
        profileName: otherCouple?.profileName || 'Unknown Couple',
        primaryPhoto: otherCouple?.primaryPhoto,
        secondaryPhotos: otherCouple?.secondaryPhotos || [],
        location: otherCouple?.location,
        status: m.status
      };
    });
  }

  /**
   * Refresh discovery feed by clearing all SKIPPED matches for the current couple.
   * This allows them to see those couples again.
   */
  async refreshDiscovery(requestingCoupleId: string) {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
    if (!me) throw new AppError('Profile not found', 404);

    // Delete all matches with status 'skipped' where this couple is common
    await Match.deleteMany({
      $or: [{ couple1: me._id }, { couple2: me._id }],
      status: 'skipped'
    });

    return { success: true };
  }
}

export const matchService = new MatchService();
