import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { AdminService } from '../services/admin.service';
import { signAccessToken } from '../utils/jwt';
import { logger } from '../utils/logger';

const adminService = new AdminService();

export class AdminController {
  async adminLogin(req: Request, res: Response) {
    try {
      const { email, password } = req.body;
      const user = await prisma.user.findFirst({ 
        where: { email, role: 'admin' }
      });
      
      if (!user || !user.password) {
        return res.status(401).json({ success: false, message: 'Invalid credentials or not an admin' });
      }

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }

      const token = signAccessToken({ 
        userId: user.id, 
        coupleId: user.coupleId || undefined
      });

      res.status(200).json({ 
        success: true, 
        data: { token, user: { id: user.id, _id: user.id, name: user.name, role: user.role } } 
      });
    } catch (err: any) {
      logger.error('❌ Admin Login Error:', err.message);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }

  async getDashboardData(req: Request, res: Response) {
    try {
      logger.info('🛰️ Admin fetching dashboard data...');
      
      const [stats, users, couples, communities, activities, prompts, reports, blocks, chartData, userLogs, communityLogs, cityDistribution] = await Promise.all([
        adminService.getStats(),
        adminService.getUsers(),
        adminService.getCouples(),
        adminService.getCommunities(),
        adminService.getActivities(),
        adminService.getPrompts(),
        adminService.getReports(),
        adminService.getBlocks(),
        adminService.getChartData(),
        adminService.getUserLogs(),
        adminService.getCommunityLogs(),
        adminService.getCityDistribution(),
      ]);

      res.status(200).json({
        success: true,
        data: {
          stats,
          users,
          couples,
          communities,
          activities,
          prompts,
          reports,
          blocks,
          chartData,
          userLogs,
          communityLogs,
          cityDistribution,
        },
      });
    } catch (err: any) {
      logger.error('❌ Admin Fetch Error:', err.message);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }

  async deleteCouple(req: Request, res: Response) {
    try {
      const { id } = req.params;
      await adminService.deleteCouple(id);
      res.status(200).json({ success: true, message: 'Couple and associated users deleted' });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async addCommunity(req: Request, res: Response) {
    try {
      const data = req.body;
      const c = await adminService.createCommunity(data);
      res.status(201).json({ success: true, data: c });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async editCommunity(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { name, description, city, coverImageUrl, coverImageBase64, tags } = req.body;
      const updateData: Record<string, any> = {};
      if (name?.trim()) updateData.name = name.trim();
      if (description !== undefined) updateData.description = description;
      if (city?.trim()) updateData.city = city.trim();
      if (tags !== undefined) updateData.tags = Array.isArray(tags) ? tags : tags.split(',').map((t: string) => t.trim()).filter(Boolean);
      if (coverImageBase64 && coverImageBase64.length > 10) {
        const prefix = coverImageBase64.startsWith('data:') ? '' : 'data:image/jpeg;base64,';
        updateData.coverImageUrl = prefix + coverImageBase64;
      } else if (coverImageUrl !== undefined) {
        updateData.coverImageUrl = coverImageUrl;
      }
      const c = await prisma.community.update({ where: { id }, data: updateData });
      res.status(200).json({ success: true, data: c });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async banCouple(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { reason } = req.body || {};
      const couple = await adminService.banCouple(id, reason);
      res.status(200).json({ success: true, data: couple });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async unbanCouple(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const couple = await adminService.unbanCouple(id);
      res.status(200).json({ success: true, data: couple });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async processJoinRequestAsAdmin(req: Request, res: Response) {
    try {
      const { communityId, requestId, decision } = req.params;
      if (decision !== 'accept' && decision !== 'reject') {
        return res.status(400).json({ success: false, message: 'Invalid decision' });
      }
      const result = await adminService.processJoinRequestAsAdmin(
        communityId,
        requestId,
        decision as 'accept' | 'reject',
      );
      res.status(200).json({ success: true, data: result });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async addPrompt(req: Request, res: Response) {
    try {
      const { title, category } = req.body;
      const p = await adminService.addPrompt(title, category);
      res.status(201).json({ success: true, data: p });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async togglePrompt(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const p = await adminService.togglePrompt(id);
      res.status(200).json({ success: true, data: p });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async deleteUser(req: Request, res: Response) {
    try {
      const { id } = req.params;
      await prisma.user.delete({ where: { id } });
      res.status(200).json({ success: true, message: 'User deleted' });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async deleteCommunity(req: Request, res: Response) {
    try {
      const { id } = req.params;
      // Delete in order to satisfy all FK constraints
      await prisma.$transaction([
        prisma.message.deleteMany({ where: { communityId: id } }),
        prisma.communityMember.deleteMany({ where: { communityId: id } }),
        prisma.communityAdmin.deleteMany({ where: { communityId: id } }),
        prisma.communityJoinRequest.deleteMany({ where: { communityId: id } }),
        prisma.community.delete({ where: { id } }),
      ]);
      res.status(200).json({ success: true, message: 'Community deleted' });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async deletePrompt(req: Request, res: Response) {
    try {
      const { id } = req.params;
      await adminService.deletePrompt(id);
      res.status(200).json({ success: true, message: 'Prompt deleted' });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async sendNotification(req: Request, res: Response) {
    try {
      const { title, message, recipientIds } = req.body;
      const result = await adminService.sendNotification(title, message, recipientIds);
      res.status(200).json({ success: true, data: result });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async flushDatabase(req: Request, res: Response) {
    try {
      const tables = [
        'onboarding_answers',
        'messages',
        'notifications',
        'matches',
        'community_members',
        'community_admins',
        'community_join_requests',
        'reports',
        'otp_tokens',
        'users',
        'couples',
        'communities',
        'prompts',
      ] as const;

      const list = tables.map((t) => `"${t}"`).join(', ');
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`,
      );

      logger.warn('ADMIN: Full database flush', { tables: [...tables] });
      res.status(200).json({
        success: true,
        message: 'Database flushed successfully',
        cleared: [...tables],
      });
    } catch (err: any) {
      logger.error('ADMIN: Database flush failed', { error: err.message });
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async getBlocks(req: Request, res: Response) {
    try {
      const blocks = await adminService.getBlocks();
      res.status(200).json({ success: true, data: { blocks } });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async resolveReport(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { status } = req.body; // 'resolved' | 'dismissed'
      if (!['resolved', 'dismissed'].includes(status)) {
        return res.status(400).json({ success: false, message: 'status must be resolved or dismissed' });
      }
      const report = await prisma.report.update({
        where: { id },
        data: { status },
      });
      res.status(200).json({ success: true, data: report });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
}
