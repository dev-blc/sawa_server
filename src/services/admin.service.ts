import { prisma } from '../lib/prisma';

export class AdminService {
  async getStats() {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [totalUsers, totalCouples, totalCommunities, totalMatches, totalPrompts, pendingReports, activeToday] =
      await Promise.all([
        prisma.user.count(),
        prisma.couple.count(),
        prisma.community.count(),
        prisma.match.count({ where: { status: 'accepted' } }),
        prisma.prompt.count({ where: { isActive: true } }),
        prisma.report.count({ where: { status: 'pending' } }),
        prisma.user.count({ where: { updatedAt: { gte: dayAgo } } }),
      ]);

    return { totalUsers, totalCouples, totalCommunities, totalPrompts, activeToday, pendingReports };
  }

  async getUsers() {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { coupleProfile: true },
    });

    return users.map(u => ({
      _id: u.id,
      id: u.id,
      name: u.name || 'Unknown',
      phone: u.phone,
      city: u.coupleProfile?.locationCity || 'Unknown',
      status: u.isPhoneVerified ? 'active' : 'inactive',
      joinedAt: u.createdAt,
    }));
  }

  async getCouples() {
    const couples = await prisma.couple.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return couples.map(c => ({
      _id: c.id,
      id: c.id,
      pairName: c.profileName || 'Anonymous Pair',
      city: c.locationCity || 'Unknown',
      compatibilityScore: Math.floor(Math.random() * 30) + 70,
      streakDays: 0,
      status: c.isProfileComplete ? 'engaged' : 'new',
    }));
  }

  async getCommunities() {
    const comms = await prisma.community.findMany({
      orderBy: { createdAt: 'desc' },
      include: { members: true },
    });

    return comms.map(c => ({
      _id: c.id,
      id: c.id,
      name: c.name,
      category: c.tags?.[0] || c.city || 'General',
      members: c.members.length,
      growthRate: 0,
    }));
  }

  async getActivities() {
    const [notifs, users, communities] = await Promise.all([
      prisma.notification.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { sender: true },
      }),
      prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
      prisma.community.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);

    const activities: any[] = [];

    notifs.forEach(n => {
      activities.push({
        _id: `notif-${n.id}`,
        id: `notif-${n.id}`,
        title: n.title,
        actor: n.sender?.profileName || 'System',
        type: n.type === 'match' ? 'couple_matched' : 'system_alert',
        happenedAt: n.createdAt,
      });
    });

    users.forEach(u => {
      activities.push({
        _id: `user-${u.id}`,
        id: `user-${u.id}`,
        title: 'New User Registered',
        actor: u.name || 'Anonymous User',
        type: 'user_registration',
        happenedAt: u.createdAt,
      });
    });

    communities.forEach(c => {
      activities.push({
        _id: `comm-${c.id}`,
        id: `comm-${c.id}`,
        title: 'New Community Created',
        actor: c.name,
        type: 'community_creation',
        happenedAt: c.createdAt,
      });
    });

    return activities
      .sort((a, b) => {
        const dateA = a.happenedAt ? new Date(a.happenedAt).getTime() : 0;
        const dateB = b.happenedAt ? new Date(b.happenedAt).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, 20);
  }

  async getPrompts() {
    const list = await prisma.prompt.findMany({ orderBy: { createdAt: 'desc' } });
    return list.map(p => ({
      _id: p.id,
      id: p.id,
      title: p.text,
      question: p.text,
      category: p.category,
      tags: [],
      active: p.isActive,
      createdAt: p.createdAt,
    }));
  }

  async getReports() {
    const list = await prisma.report.findMany({
      orderBy: { createdAt: 'desc' },
      include: { reporter: true, target: true },
    });

    return list.map(r => ({
      _id: r.id,
      id: r.id,
      reporter: r.reporter?.profileName || 'Unknown',
      target: r.target?.profileName || 'Unknown',
      reason: r.reason,
      status: r.status,
      createdAt: r.createdAt,
    }));
  }

  async addPrompt(text: string, category: string) {
    return prisma.prompt.create({ data: { text, category } });
  }

  async togglePrompt(id: string) {
    const p = await prisma.prompt.findUnique({ where: { id } });
    if (!p) throw new Error('Prompt not found');
    return prisma.prompt.update({ where: { id }, data: { isActive: !p.isActive } });
  }

  async deletePrompt(id: string) {
    return prisma.prompt.delete({ where: { id } });
  }

  async sendNotification(title: string, message: string, recipientIds?: string[]) {
    // If recipientIds is provided and not empty, send to those specific couples
    if (recipientIds && recipientIds.length > 0) {
      const data = recipientIds.map(rid => ({
        recipientId: rid,
        type: 'admin' as any,
        title,
        message,
      }));
      return prisma.notification.createMany({ data });
    }

    // Otherwise, broadcast to ALL couples
    const allCouples = await prisma.couple.findMany({ select: { coupleId: true } });
    const data = allCouples.map(c => ({
      recipientId: c.coupleId,
      type: 'admin' as any,
      title,
      message,
    }));
    return prisma.notification.createMany({ data });
  }
}
