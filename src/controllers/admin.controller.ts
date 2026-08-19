import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { AdminService } from '../services/admin.service';
import { signAccessToken, verifyAccessToken } from '../utils/jwt';
import { logger } from '../utils/logger';
import { materializeImageLoose } from '../lib/storage';
import { env } from '../config/env';
import { sendSuccess, sendError } from '../utils/response';

/**
 * Admin error responses go through the shared envelope, plus the transition
 * `message` mirror: this controller hand-rolled `{ success:false, message }`
 * for years and the DEPLOYED admin panel may predate the migration, so both
 * `error` (canonical) and `message` (legacy) carry the human text for now.
 * The repo's AdminDataProvider reads only `res.ok` / `success` / `data`.
 */
const adminError = (res: Response, error: string, statusCode: number, code: string): void =>
  sendError({ res, error, statusCode, code, message: error });

/**
 * Log the real error server-side, return a generic 500. Raw driver/Prisma
 * messages disclose schema and internals; even admin-only responses end up
 * in browser consoles, proxies, and screenshots.
 */
const failInternal = (res: Response, context: string, err: any): void => {
  logger.error(`❌ Admin ${context} failed:`, err?.message || err);
  adminError(res, 'Internal server error', 500, 'INTERNAL_ERROR');
};

const adminService = new AdminService();

/**
 * Typed-confirmation phrase required to run POST /admin/flush-database. The
 * caller must pass it verbatim as `?confirm=<phrase>`. In production the flush
 * ALSO requires env `ALLOW_PROD_DB_FLUSH=true`; default posture is REFUSE.
 * A leaked admin token or a fat-finger cannot wipe the database without this
 * exact string (and, in prod, the deploy-level flag). URL-safe on purpose
 * (no spaces) so it needs no encoding.
 */
const FLUSH_CONFIRM_PHRASE = 'FLUSH-ENTIRE-SAWA-DATABASE';

function hostOf(u?: string | null): string | null {
  if (!u) return null;
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return null;
  }
}

// Object-storage / CDN suffixes we host media on. A redirect target outside this
// set (plus our own configured hosts) is refused so a user-supplied photo/cover
// URL can't turn the admin media proxy into an open redirect.
const TRUSTED_MEDIA_HOST_SUFFIXES = [
  'amazonaws.com',
  'backblazeb2.com',
  'r2.cloudflarestorage.com',
  'cloudfront.net',
  'digitaloceanspaces.com',
  'storage.googleapis.com',
];

function isTrustedMediaUrl(rawUrl: string): boolean {
  let host: string;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    host = u.host.toLowerCase();
  } catch {
    return false;
  }
  const configured = [hostOf(env.APP_URL), hostOf(env.S3_PUBLIC_BASE_URL), hostOf(env.S3_ENDPOINT)].filter(
    Boolean,
  ) as string[];
  if (configured.includes(host)) return true;
  return TRUSTED_MEDIA_HOST_SUFFIXES.some((suf) => host === suf || host.endsWith(`.${suf}`));
}

export class AdminController {
  async adminLogin(req: Request, res: Response) {
    try {
      const { email, password } = req.body;
      const user = await prisma.user.findFirst({ 
        where: { email, role: 'admin' }
      });
      
      if (!user || !user.password) {
        return adminError(res, 'Invalid credentials or not an admin', 401, 'INVALID_CREDENTIALS');
      }

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return adminError(res, 'Invalid credentials', 401, 'INVALID_CREDENTIALS');
      }

      const token = signAccessToken({
        userId: user.id,
        coupleId: user.coupleId || undefined
      });

      sendSuccess({
        res,
        data: { token, user: { id: user.id, _id: user.id, name: user.name, role: user.role } },
      });
    } catch (err: any) {
      logger.error('❌ Admin Login Error:', err.message);
      adminError(res, 'Internal server error', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Lazily serve a couple photo / community cover image. Authenticated via a
   * `?token=` query param (an <img> tag cannot send an Authorization header).
   * Keeps the big /admin/data payload free of multi-MB base64 blobs.
   *
   * NOT a JSON endpoint: responses are image bytes / redirects, and error
   * paths are plain-text statuses for <img> loaders that never parse a body —
   * deliberately outside the JSON envelope.
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

      // Already an external URL — redirect only to trusted media hosts so a
      // user-supplied photo/cover URL can't turn this into an open redirect.
      if (raw.startsWith('http')) {
        if (isTrustedMediaUrl(raw)) {
          return res.redirect(raw);
        }
        logger.warn(`⚠️ Admin getMedia refused redirect to untrusted host: ${raw}`);
        return res.status(400).send('Untrusted media URL');
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

      sendSuccess({
        res,
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
      adminError(res, 'Internal server error', 500, 'INTERNAL_ERROR');
    }
  }

  async deleteCouple(req: Request, res: Response) {
    try {
      const { id } = req.params;
      await adminService.deleteCouple(id);
      sendSuccess({ res, message: 'Couple and associated users deleted' });
    } catch (err: any) {
      failInternal(res, req.path, err);
    }
  }

  async addCommunity(req: Request, res: Response) {
    try {
      const data = req.body;
      const c = await adminService.createCommunity(data);
      sendSuccess({ res, statusCode: 201, data: c });
    } catch (err: any) {
      failInternal(res, req.path, err);
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
      sendSuccess({ res, data: c });
    } catch (err: any) {
      failInternal(res, req.path, err);
    }
  }

  async banCouple(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { reason } = req.body || {};
      const couple = await adminService.banCouple(id, reason);
      sendSuccess({ res, data: couple });
    } catch (err: any) {
      failInternal(res, req.path, err);
    }
  }

  async unbanCouple(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const couple = await adminService.unbanCouple(id);
      sendSuccess({ res, data: couple });
    } catch (err: any) {
      failInternal(res, req.path, err);
    }
  }

  async processJoinRequestAsAdmin(req: Request, res: Response) {
    try {
      const { communityId, requestId, decision } = req.params;
      if (decision !== 'accept' && decision !== 'reject') {
        return adminError(res, 'Invalid decision', 400, 'INVALID_DECISION');
      }
      const result = await adminService.processJoinRequestAsAdmin(
        communityId,
        requestId,
        decision as 'accept' | 'reject',
      );
      sendSuccess({ res, data: result });
    } catch (err: any) {
      failInternal(res, req.path, err);
    }
  }

  async addPrompt(req: Request, res: Response) {
    try {
      const { title, category } = req.body;
      const p = await adminService.addPrompt(title, category);
      sendSuccess({ res, statusCode: 201, data: p });
    } catch (err: any) {
      failInternal(res, req.path, err);
    }
  }

  async togglePrompt(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const p = await adminService.togglePrompt(id);
      sendSuccess({ res, data: p });
    } catch (err: any) {
      failInternal(res, req.path, err);
    }
  }

  async editPrompt(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { title } = req.body;
      if (!title || !title.trim()) {
        return adminError(res, 'title is required', 400, 'TITLE_REQUIRED');
      }
      const p = await adminService.editPrompt(id, title.trim());
      sendSuccess({ res, data: p });
    } catch (err: any) {
      failInternal(res, req.path, err);
    }
  }

  async reorderPrompts(req: Request, res: Response) {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return adminError(res, 'ids array is required', 400, 'IDS_REQUIRED');
      }
      await adminService.reorderPrompts(ids);
      sendSuccess({ res });
    } catch (err: any) {
      failInternal(res, req.path, err);
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
      if (!user) return adminError(res, 'User not found', 404, 'USER_NOT_FOUND');

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

      sendSuccess({ res, message: 'User and all associated data deleted' });
    } catch (err: any) {
      logger.error('❌ Admin deleteUser Error:', err.message);
      failInternal(res, req.path, err);
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
      sendSuccess({ res, message: 'Community deleted' });
    } catch (err: any) {
      failInternal(res, req.path, err);
    }
  }

  async deletePrompt(req: Request, res: Response) {
    try {
      const { id } = req.params;
      await adminService.deletePrompt(id);
      sendSuccess({ res, message: 'Prompt deleted' });
    } catch (err: any) {
      failInternal(res, req.path, err);
    }
  }

  async sendNotification(req: Request, res: Response) {
    try {
      const { title, message, recipientIds } = req.body;
      const result = await adminService.sendNotification(title, message, recipientIds);
      sendSuccess({ res, data: result });
    } catch (err: any) {
      failInternal(res, req.path, err);
    }
  }

  async flushDatabase(req: Request, res: Response) {
    // ── Destructive-operation guard (v3 B3/H2) ───────────────────────────────
    // This TRUNCATEs every table. Before touching the DB we require a typed
    // ?confirm=<phrase>; in production we additionally hard-refuse unless the
    // deploy-level ALLOW_PROD_DB_FLUSH flag is set. Default posture: REFUSE.
    const adminId = req.user?.userId ?? 'unknown';
    const confirm = String(req.query.confirm ?? '');
    const confirmed = confirm === FLUSH_CONFIRM_PHRASE;

    if (env.NODE_ENV === 'production') {
      if (!env.ALLOW_PROD_DB_FLUSH) {
        logger.error('ADMIN: flush-database REFUSED in production (ALLOW_PROD_DB_FLUSH not set)', {
          adminId,
        });
        return adminError(
          res,
          'Database flush is disabled in production',
          403,
          'FLUSH_DISABLED_IN_PROD',
        );
      }
      if (!confirmed) {
        logger.error(
          'ADMIN: flush-database REFUSED in production (missing/incorrect confirmation phrase)',
          { adminId },
        );
        return adminError(
          res,
          'Confirmation phrase required to flush the production database',
          403,
          'FLUSH_CONFIRM_REQUIRED',
        );
      }
    } else if (!confirmed) {
      logger.error('ADMIN: flush-database refused (missing/incorrect confirmation phrase)', {
        adminId,
        env: env.NODE_ENV,
      });
      return adminError(
        res,
        'Confirmation phrase required to flush the database',
        403,
        'FLUSH_CONFIRM_REQUIRED',
      );
    }

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

      logger.warn('ADMIN: Full database flush EXECUTED', {
        adminId,
        env: env.NODE_ENV,
        tables: [...tables],
      });
      // `cleared` moved from the response top level into `data` for the shared
      // envelope. Verified consumer-free: nothing in the admin panel calls
      // flush-database (manual/curl-only endpoint).
      sendSuccess({ res, data: { cleared: [...tables] }, message: 'Database flushed successfully' });
    } catch (err: any) {
      logger.error('ADMIN: Database flush failed', { error: err.message });
      failInternal(res, req.path, err);
    }
  }

  async getBlocks(req: Request, res: Response) {
    try {
      const blocks = await adminService.getBlocks();
      sendSuccess({ res, data: { blocks } });
    } catch (err: any) {
      failInternal(res, req.path, err);
    }
  }

  async adminUnblock(req: Request, res: Response) {
    try {
      const { blockerCoupleId, targetId } = req.body;
      if (!blockerCoupleId || !targetId) {
        return adminError(res, 'blockerCoupleId and targetId are required', 400, 'MISSING_FIELDS');
      }
      // Find the blocker couple by coupleId (UUID)
      const blocker = await prisma.couple.findFirst({ where: { coupleId: blockerCoupleId } });
      if (!blocker) return adminError(res, 'Blocker couple not found', 404, 'BLOCKER_NOT_FOUND');
      const newBlocked = blocker.blocked.filter((id: string) => id !== targetId);
      await prisma.couple.update({
        where: { id: blocker.id },
        data: { blocked: { set: newBlocked } },
      });
      sendSuccess({ res, message: 'Unblocked successfully' });
    } catch (err: any) {
      failInternal(res, req.path, err);
    }
  }

  async resolveReport(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { status } = req.body; // 'resolved' | 'dismissed'
      if (!['resolved', 'dismissed'].includes(status)) {
        return adminError(res, 'status must be resolved or dismissed', 400, 'INVALID_STATUS');
      }
      const report = await prisma.report.update({
        where: { id },
        data: { status },
      });
      sendSuccess({ res, data: report });
    } catch (err: any) {
      failInternal(res, req.path, err);
    }
  }
}
