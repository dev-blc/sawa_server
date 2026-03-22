import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../models/User.model';
import { Community } from '../models/Community.model';
import { AdminService } from '../services/admin.service';
import { signAccessToken } from '../utils/jwt';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

const adminService = new AdminService();

export class AdminController {
  async adminLogin(req: Request, res: Response) {
    try {
      const { email, password } = req.body;
      const user = await User.findOne({ email, role: 'admin' }).select('+password');
      
      if (!user || !user.password) {
        return res.status(401).json({ success: false, message: 'Invalid credentials or not an admin' });
      }

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }

      const token = signAccessToken({ 
        userId: user._id.toString(), 
        coupleId: user.coupleId,
        type: 'access'
      } as any);

      res.status(200).json({ 
        success: true, 
        data: { token, user: { id: user._id, name: user.name, role: user.role } } 
      });
    } catch (err: any) {
      logger.error('❌ Admin Login Error:', err.message);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }

  async getDashboardData(req: Request, res: Response) {
    try {
      logger.info('🛰️ Admin fetching dashboard data...');
      
      const [stats, users, couples, communities, activities, prompts, reports] = await Promise.all([
        adminService.getStats(),
        adminService.getUsers(),
        adminService.getCouples(),
        adminService.getCommunities(),
        adminService.getActivities(),
        adminService.getPrompts(),
        adminService.getReports(),
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
        },
      });
    } catch (err: any) {
      logger.error('❌ Admin Fetch Error:', err.message);
      res.status(500).json({ success: false, message: 'Internal server error' });
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
      await User.findByIdAndDelete(id);
      res.status(200).json({ success: true, message: 'User deleted' });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async deleteCommunity(req: Request, res: Response) {
    try {
      const { id } = req.params;
      await Community.findByIdAndDelete(id);
      res.status(200).json({ success: true, message: 'Community deleted' });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
}
