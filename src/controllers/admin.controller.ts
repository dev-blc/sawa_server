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
      
      const [stats, users, couples, communities, activities, prompts, reports, chartData, userLogs, communityLogs] = await Promise.all([
        adminService.getStats(),
        adminService.getUsers(),
        adminService.getCouples(),
        adminService.getCommunities(),
        adminService.getActivities(),
        adminService.getPrompts(),
        adminService.getReports(),
        adminService.getChartData(),
        adminService.getUserLogs(),
        adminService.getCommunityLogs(),
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
          chartData,
          userLogs,
          communityLogs,
        },
      });
    } catch (err: any) {
      logger.error('❌ Admin Fetch Error:', err.message);
      res.status(500).json({ success: false, message: 'Internal server error' });
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
}
