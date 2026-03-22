import { User } from '../models/User.model';
import { Couple } from '../models/Couple.model';
import { Community } from '../models/Community.model';
import { Match } from '../models/Match.model';
import { Notification } from '../models/Notification.model';
import { Prompt } from '../models/Prompt.model';
import { Report } from '../models/Report.model';

export class AdminService {
  async getStats() {
    const [totalUsers, totalCouples, totalCommunities, totalMatches, totalPrompts, pendingReports] = await Promise.all([
      User.countDocuments(),
      Couple.countDocuments(),
      Community.countDocuments(),
      Match.countDocuments({ status: 'accepted' }),
      Prompt.countDocuments({ isActive: true }),
      Report.countDocuments({ status: 'pending' }),
    ]);

    // Simple active today logic: anyone updated in the last 24h
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const activeToday = await User.countDocuments({ updatedAt: { $gte: dayAgo } });

    return {
      totalUsers,
      totalCouples,
      totalCommunities,
      totalPrompts,
      activeToday,
      pendingReports,
    };
  }

  async getUsers() {
    const users = await User.find().sort({ createdAt: -1 }).limit(100);
    // Joining with coupleId manually to get city
    const coupleIds = [...new Set(users.map(u => u.coupleId))];
    const couples = await Couple.find({ coupleId: { $in: coupleIds } });
    const coupleMap = new Map(couples.map(c => [c.coupleId, c]));

    return users.map(u => {
      const couple = coupleMap.get(u.coupleId);
      return {
        id: u._id,
        name: u.name || 'Unknown',
        phone: u.phone,
        city: couple?.location?.city || 'Unknown',
        status: u.isPhoneVerified ? 'active' : 'inactive',
        joinedAt: u.createdAt,
      };
    });
  }

  async getCouples() {
    const couples = await Couple.find().sort({ createdAt: -1 }).limit(100);
    return couples.map(c => ({
      id: c._id,
      pairName: c.profileName || 'Anonymous Pair',
      city: c.location?.city || 'Unknown',
      compatibilityScore: Math.floor(Math.random() * 30) + 70, // Mock for now
      streakDays: 0,
      status: c.isProfileComplete ? 'engaged' : 'new',
    }));
  }

  async getCommunities() {
    const comms = await Community.find().sort({ createdAt: -1 });
    return comms.map(c => ({
      id: c._id,
      name: c.name,
      category: c.tags?.[0] || c.city || 'General',
      members: c.members.length,
      growthRate: 0,
    }));
  }

  async getActivities() {
    // Recent notifications or matches
    const notifs = await Notification.find()
      .populate('sender', 'profileName')
      .sort({ createdAt: -1 })
      .limit(20);

    return notifs.map(n => ({
      id: n._id,
      title: n.title,
      actor: n.sender ? (n.sender as any).profileName : 'System',
      type: n.type === 'match' ? 'couple_matched' : 'system_alert',
      happenedAt: n.createdAt,
    }));
  }

  async getPrompts() {
    const list = await Prompt.find().sort({ createdAt: -1 });
    return list.map(p => ({
      id: p._id,
      title: p.text, // Mapping text to title for Admin UI
      question: p.text,
      category: p.category,
      tags: [],
      active: p.isActive,
      createdAt: p.createdAt,
    }));
  }

  async getReports() {
    const list = await Report.find()
      .populate('reporter', 'profileName')
      .populate('target', 'profileName')
      .sort({ createdAt: -1 });

    return list.map(r => ({
      id: r._id,
      reporter: (r.reporter as any)?.profileName || 'Unknown',
      target: (r.target as any)?.profileName || 'Unknown',
      reason: r.reason,
      status: r.status,
      createdAt: r.createdAt,
    }));
  }

  async addPrompt(text: string, category: string) {
    return Prompt.create({ text, category });
  }

  async togglePrompt(id: string) {
    const p = await Prompt.findById(id);
    if (!p) throw new Error('Prompt not found');
    p.isActive = !p.isActive;
    return p.save();
  }

  async deletePrompt(id: string) {
    return Prompt.findByIdAndDelete(id);
  }
}
