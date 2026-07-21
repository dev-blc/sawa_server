import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { AdminService } from '../services/admin.service';
import { signAccessToken, verifyAccessToken } from '../utils/jwt';
import { logger } from '../utils/logger';
import { materializeImageLoose } from '../lib/storage';

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

  /**
   * Lazily serve a couple photo / community cover image. Authenticated via a
   * `?token=` query param (an <img> tag cannot send an Authorization header).
   * Keeps the big /admin/data payload free of multi-MB base64 blobs.
   */
  async getMedia(req: Request, res: Response) {
    try {
      const { kind, id } = req.params;
      const token = String(req.query.token || '');
      if (kind !== 'couple' && kind !== 'community') {
        return res.status(400).send('Invalid media kind');
      }
      if (!token) return res.status(401).send('Missing token');

      let payload: { userId: string };
      try {
        payload = verifyAccessToken(token);
      } catch {
        return res.status(401).send('Invalid token');
      }
      const requester = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: { role: true },
      });
      if (!requester || requester.role !== 'admin') {
        return res.status(403).send('Forbidden');
      }

      const raw = await adminService.getRawImage(kind, id);
      if (!raw) return res.status(404).send('Not found');

      // Already an external URL — just redirect to it.
      if (raw.startsWith('http')) {
        return res.redirect(raw);
      }

      const match = raw.match(/^data:([^;]+);base64,(.*)$/s);
      if (!match) return res.status(415).send('Unsupported image format');

      const buffer = Buffer.from(match[2], 'base64');
      res.setHeader('Content-Type', match[1]);
      res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
      return res.end(buffer);
    } catch (err: any) {
      logger.error('❌ Admin getMedia Error:', err.message);
      return res.status(500).send('Media error');
    }
  }

  async getDashboardData(req: Request, res: Response) {
    try {
      logger.info('🛰️ Admin fetching dashboard data...');

      // Pass the caller's token so image fields become lazy media URLs
      // (carrying the token in the query string) instead of inline base64.
      const token = (req.headers.authorization || '').split(' ')[1];

      const [stats, users, couples, communities, activities, prompts, reports, blocks, chartData, userLogs, communityLogs, cityDistribution] = await Promise.all([
        adminService.getStats(),
        adminService.getUsers(token),
        adminService.getCouples(token),
        adminService.getCommunities(token),
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
        updateData.coverImageUrl = await materializeImageLoose(coverImageBase64);
      } else if (coverImageUrl !== undefined) {
        updateData.coverImageUrl = await materializeImageLoose(coverImageUrl);
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

  async editPrompt(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { title } = req.body;
      if (!title || !title.trim()) {
        return res.status(400).json({ success: false, message: 'title is required' });
      }
      const p = await adminService.editPrompt(id, title.trim());
      res.status(200).json({ success: true, data: p });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async reorderPrompts(req: Request, res: Response) {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, message: 'ids array is required' });
      }
      await adminService.reorderPrompts(ids);
      res.status(200).json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async deleteUser(req: Request, res: Response) {
    try {
      const { id } = req.params;

      // Find the user and their associated couple
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, coupleId: true },
      });
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });

      if (user.coupleId) {
        // Deleting a user who belongs to a couple: wipe the entire couple and both partners
        // so no orphaned couple or partner remains in the DB
        await adminService.deleteCouple(user.coupleId);
      } else {
        // Solo user — delete their own messages then the user record
        await prisma.$transaction(async (tx) => {
          await tx.message.deleteMany({ where: { senderUserId: id } });
          await tx.otpToken.deleteMany({ where: { phone: (await tx.user.findUnique({ where: { id }, select: { phone: true } }))?.phone ?? '' } });
          await tx.user.delete({ where: { id } });
        });
      }

      res.status(200).json({ success: true, message: 'User and all associated data deleted' });
    } catch (err: any) {
      logger.error('❌ Admin deleteUser Error:', err.message);
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

  async adminUnblock(req: Request, res: Response) {
    try {
      const { blockerCoupleId, targetId } = req.body;
      if (!blockerCoupleId || !targetId) {
        return res.status(400).json({ success: false, message: 'blockerCoupleId and targetId are required' });
      }
      // Find the blocker couple by coupleId (UUID)
      const blocker = await prisma.couple.findFirst({ where: { coupleId: blockerCoupleId } });
      if (!blocker) return res.status(404).json({ success: false, message: 'Blocker couple not found' });
      const newBlocked = blocker.blocked.filter((id: string) => id !== targetId);
      await prisma.couple.update({
        where: { id: blocker.id },
        data: { blocked: { set: newBlocked } },
      });
      res.status(200).json({ success: true, message: 'Unblocked successfully' });
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
