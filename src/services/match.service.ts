import mongoose from 'mongoose';
import { Couple } from '../models/Couple.model';
import { Match } from '../models/Match.model';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

export class MatchService {
  /**
   * Fetches the discovery feed of couples for the current user.
   * If there are no seeded couples in the database other than the requester, 
   * this seeds a dummy couple (Arjun & Meera) to test the UI.
   */
  async getDiscoveryFeed(requestingCoupleId: string) {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
    if (!me) throw new AppError('Couple profile not found', 404);

    // Get all couple _ids that we have already interacted with
    const interactions = await Match.find({ couple1: me._id }).select('couple2');
    const interactedIds = interactions.map(m => m.couple2);

    // Find couples that are not us, and not interacted with
    let potentialCouples = await Couple.find({
      _id: { $ne: me._id, $nin: interactedIds },
      isProfileComplete: true, 
    }).limit(10); // Fetch up to 10 at a time

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
    if (targetCoupleIdStr.startsWith('dummy-') || !mongoose.Types.ObjectId.isValid(targetCoupleIdStr)) {
      logger.info(`[MatchService] Say Hello for dummy couple ${targetCoupleIdStr} - success (no DB)`);
      return { isMatch: false };
    }

    const targetCouple = await Couple.findById(targetCoupleIdStr);
    if (!targetCouple) {
       logger.warn(`[MatchService] sayHello: Target couple ${targetCoupleIdStr} not found in DB. Skipping interaction.`);
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
         return { isMatch: true };
      }
      
      // If we already liked them, or already accepted
      return { isMatch: existingMatch.status === 'accepted' };
    }

    // Otherwise, create a pending like
    await Match.create({
      couple1: me._id,
      couple2: targetCouple._id,
      status: 'pending',
      actionBy: me._id,
    });

    return { isMatch: false };
  }

  /**
   * Skip a couple
   */
  async skipCouple(requestingCoupleId: string, targetCoupleIdStr: string) {
    const me = await Couple.findOne({ coupleId: requestingCoupleId });
    if (!me) throw new AppError('Profile not found', 404);

    // Transient dummy support
    if (targetCoupleIdStr.startsWith('dummy-') || !mongoose.Types.ObjectId.isValid(targetCoupleIdStr)) {
      logger.info(`[MatchService] Skip for dummy couple ${targetCoupleIdStr} - success (no DB)`);
      return { skipped: true };
    }

    const targetCouple = await Couple.findById(targetCoupleIdStr);
    if (!targetCouple) {
       logger.warn(`[MatchService] skipCouple: Target couple ${targetCoupleIdStr} not found in DB. Already gone.`);
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
    const matches = await Match.find({
      $or: [{ couple1: me._id }, { couple2: me._id }],
      status: 'accepted'
    }).populate('couple1').populate('couple2');

    return matches.map(m => {
      // Return the OPPOSITE couple
      return m.couple1._id.toString() === me._id.toString() ? m.couple2 : m.couple1;
    });
  }
}

export const matchService = new MatchService();
