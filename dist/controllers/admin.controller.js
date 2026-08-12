"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminController = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const prisma_1 = require("../lib/prisma");
const admin_service_1 = require("../services/admin.service");
const jwt_1 = require("../utils/jwt");
const logger_1 = require("../utils/logger");
const storage_1 = require("../lib/storage");
const env_1 = require("../config/env");
const adminService = new admin_service_1.AdminService();
function hostOf(u) {
    if (!u)
        return null;
    try {
        return new URL(u).host.toLowerCase();
    }
    catch {
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
function isTrustedMediaUrl(rawUrl) {
    let host;
    try {
        const u = new URL(rawUrl);
        if (u.protocol !== 'https:' && u.protocol !== 'http:')
            return false;
        host = u.host.toLowerCase();
    }
    catch {
        return false;
    }
    const configured = [hostOf(env_1.env.APP_URL), hostOf(env_1.env.S3_PUBLIC_BASE_URL), hostOf(env_1.env.S3_ENDPOINT)].filter(Boolean);
    if (configured.includes(host))
        return true;
    return TRUSTED_MEDIA_HOST_SUFFIXES.some((suf) => host === suf || host.endsWith(`.${suf}`));
}
class AdminController {
    async adminLogin(req, res) {
        try {
            const { email, password } = req.body;
            const user = await prisma_1.prisma.user.findFirst({
                where: { email, role: 'admin' }
            });
            if (!user || !user.password) {
                return res.status(401).json({ success: false, message: 'Invalid credentials or not an admin' });
            }
            const isMatch = await bcryptjs_1.default.compare(password, user.password);
            if (!isMatch) {
                return res.status(401).json({ success: false, message: 'Invalid credentials' });
            }
            const token = (0, jwt_1.signAccessToken)({
                userId: user.id,
                coupleId: user.coupleId || undefined
            });
            res.status(200).json({
                success: true,
                data: { token, user: { id: user.id, _id: user.id, name: user.name, role: user.role } }
            });
        }
        catch (err) {
            logger_1.logger.error('❌ Admin Login Error:', err.message);
            res.status(500).json({ success: false, message: 'Internal server error' });
        }
    }
    /**
     * Lazily serve a couple photo / community cover image. Authenticated via a
     * `?token=` query param (an <img> tag cannot send an Authorization header).
     * Keeps the big /admin/data payload free of multi-MB base64 blobs.
     */
    async getMedia(req, res) {
        try {
            const { kind, id } = req.params;
            const token = String(req.query.token || '');
            if (kind !== 'couple' && kind !== 'community') {
                return res.status(400).send('Invalid media kind');
            }
            if (!token)
                return res.status(401).send('Missing token');
            let payload;
            try {
                payload = (0, jwt_1.verifyAccessToken)(token);
            }
            catch {
                return res.status(401).send('Invalid token');
            }
            const requester = await prisma_1.prisma.user.findUnique({
                where: { id: payload.userId },
                select: { role: true },
            });
            if (!requester || requester.role !== 'admin') {
                return res.status(403).send('Forbidden');
            }
            const raw = await adminService.getRawImage(kind, id);
            if (!raw)
                return res.status(404).send('Not found');
            // Already an external URL — redirect only to trusted media hosts so a
            // user-supplied photo/cover URL can't turn this into an open redirect.
            if (raw.startsWith('http')) {
                if (isTrustedMediaUrl(raw)) {
                    return res.redirect(raw);
                }
                logger_1.logger.warn(`⚠️ Admin getMedia refused redirect to untrusted host: ${raw}`);
                return res.status(400).send('Untrusted media URL');
            }
            const match = raw.match(/^data:([^;]+);base64,(.*)$/s);
            if (!match)
                return res.status(415).send('Unsupported image format');
            const buffer = Buffer.from(match[2], 'base64');
            res.setHeader('Content-Type', match[1]);
            res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
            return res.end(buffer);
        }
        catch (err) {
            logger_1.logger.error('❌ Admin getMedia Error:', err.message);
            return res.status(500).send('Media error');
        }
    }
    async getDashboardData(req, res) {
        try {
            logger_1.logger.info('🛰️ Admin fetching dashboard data...');
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
        }
        catch (err) {
            logger_1.logger.error('❌ Admin Fetch Error:', err.message);
            res.status(500).json({ success: false, message: 'Internal server error' });
        }
    }
    async deleteCouple(req, res) {
        try {
            const { id } = req.params;
            await adminService.deleteCouple(id);
            res.status(200).json({ success: true, message: 'Couple and associated users deleted' });
        }
        catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    }
    async addCommunity(req, res) {
        try {
            const data = req.body;
            const c = await adminService.createCommunity(data);
            res.status(201).json({ success: true, data: c });
        }
        catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    }
    async editCommunity(req, res) {
        try {
            const { id } = req.params;
            const { name, description, city, coverImageUrl, coverImageBase64, tags } = req.body;
            const updateData = {};
            if (name?.trim())
                updateData.name = name.trim();
            if (description !== undefined)
                updateData.description = description;
            if (city?.trim())
                updateData.city = city.trim();
            if (tags !== undefined)
                updateData.tags = Array.isArray(tags) ? tags : tags.split(',').map((t) => t.trim()).filter(Boolean);
            if (coverImageBase64 && coverImageBase64.length > 10) {
                updateData.coverImageUrl = await (0, storage_1.materializeImageLoose)(coverImageBase64);
            }
            else if (coverImageUrl !== undefined) {
                updateData.coverImageUrl = await (0, storage_1.materializeImageLoose)(coverImageUrl);
            }
            const c = await prisma_1.prisma.community.update({ where: { id }, data: updateData });
            res.status(200).json({ success: true, data: c });
        }
        catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    }
    async banCouple(req, res) {
        try {
            const { id } = req.params;
            const { reason } = req.body || {};
            const couple = await adminService.banCouple(id, reason);
            res.status(200).json({ success: true, data: couple });
        }
        catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    }
    async unbanCouple(req, res) {
        try {
            const { id } = req.params;
            const couple = await adminService.unbanCouple(id);
            res.status(200).json({ success: true, data: couple });
        }
        catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    }
    async processJoinRequestAsAdmin(req, res) {
        try {
            const { communityId, requestId, decision } = req.params;
            if (decision !== 'accept' && decision !== 'reject') {
                return res.status(400).json({ success: false, message: 'Invalid decision' });
            }
            const result = await adminService.processJoinRequestAsAdmin(communityId, requestId, decision);
            res.status(200).json({ success: true, data: result });
        }
        catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    }
    async addPrompt(req, res) {
        try {
            const { title, category } = req.body;
            const p = await adminService.addPrompt(title, category);
            res.status(201).json({ success: true, data: p });
        }
        catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    }
    async togglePrompt(req, res) {
        try {
            const { id } = req.params;
            const p = await adminService.togglePrompt(id);
            res.status(200).json({ success: true, data: p });
        }
        catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    }
    async editPrompt(req, res) {
        try {
            const { id } = req.params;
            const { title } = req.body;
            if (!title || !title.trim()) {
                return res.status(400).json({ success: false, message: 'title is required' });
            }
            const p = await adminService.editPrompt(id, title.trim());
            res.status(200).json({ success: true, data: p });
        }
        catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    }
    async reorderPrompts(req, res) {
        try {
            const { ids } = req.body;
            if (!Array.isArray(ids) || ids.length === 0) {
                return res.status(400).json({ success: false, message: 'ids array is required' });
            }
            await adminService.reorderPrompts(ids);
            res.status(200).json({ success: true });
        }
        catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    }
    async deleteUser(req, res) {
        try {
            const { id } = req.params;
            // Find the user and their associated couple
            const user = await prisma_1.prisma.user.findUnique({
                where: { id },
                select: { id: true, coupleId: true },
            });
            if (!user)
                return res.status(404).json({ success: false, message: 'User not found' });
            if (user.coupleId) {
                // Deleting a user who belongs to a couple: wipe the entire couple and both partners
                // so no orphaned couple or partner remains in the DB
                await adminService.deleteCouple(user.coupleId);
            }
            else {
                // Solo user — delete their own messages then the user record
                await prisma_1.prisma.$transaction(async (tx) => {
                    await tx.message.deleteMany({ where: { senderUserId: id } });
                    await tx.otpToken.deleteMany({ where: { phone: (await tx.user.findUnique({ where: { id }, select: { phone: true } }))?.phone ?? '' } });
                    await tx.user.delete({ where: { id } });
                });
            }
            res.status(200).json({ success: true, message: 'User and all associated data deleted' });
        }
        catch (err) {
            logger_1.logger.error('❌ Admin deleteUser Error:', err.message);
            res.status(500).json({ success: false, message: err.message });
        }
    }
    async deleteCommunity(req, res) {
        try {
            const { id } = req.params;
            // Delete in order to satisfy all FK constraints
            await prisma_1.prisma.$transaction([
                prisma_1.prisma.message.deleteMany({ where: { communityId: id } }),
                prisma_1.prisma.communityMember.deleteMany({ where: { communityId: id } }),
                prisma_1.prisma.communityAdmin.deleteMany({ where: { communityId: id } }),
                prisma_1.prisma.communityJoinRequest.deleteMany({ where: { communityId: id } }),
                prisma_1.prisma.community.delete({ where: { id } }),
            ]);
            res.status(200).json({ success: true, message: 'Community deleted' });
        }
        catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    }
    async deletePrompt(req, res) {
        try {
            const { id } = req.params;
            await adminService.deletePrompt(id);
            res.status(200).json({ success: true, message: 'Prompt deleted' });
        }
        catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    }
    async sendNotification(req, res) {
        try {
            const { title, message, recipientIds } = req.body;
            const result = await adminService.sendNotification(title, message, recipientIds);
            res.status(200).json({ success: true, data: result });
        }
        catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    }
    async flushDatabase(req, res) {
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
            ];
            const list = tables.map((t) => `"${t}"`).join(', ');
            await prisma_1.prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
            logger_1.logger.warn('ADMIN: Full database flush', { tables: [...tables] });
            res.status(200).json({
                success: true,
                message: 'Database flushed successfully',
                cleared: [...tables],
            });
        }
        catch (err) {
            logger_1.logger.error('ADMIN: Database flush failed', { error: err.message });
            res.status(500).json({ success: false, message: err.message });
        }
    }
    async getBlocks(req, res) {
        try {
            const blocks = await adminService.getBlocks();
            res.status(200).json({ success: true, data: { blocks } });
        }
        catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    }
    async adminUnblock(req, res) {
        try {
            const { blockerCoupleId, targetId } = req.body;
            if (!blockerCoupleId || !targetId) {
                return res.status(400).json({ success: false, message: 'blockerCoupleId and targetId are required' });
            }
            // Find the blocker couple by coupleId (UUID)
            const blocker = await prisma_1.prisma.couple.findFirst({ where: { coupleId: blockerCoupleId } });
            if (!blocker)
                return res.status(404).json({ success: false, message: 'Blocker couple not found' });
            const newBlocked = blocker.blocked.filter((id) => id !== targetId);
            await prisma_1.prisma.couple.update({
                where: { id: blocker.id },
                data: { blocked: { set: newBlocked } },
            });
            res.status(200).json({ success: true, message: 'Unblocked successfully' });
        }
        catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    }
    async resolveReport(req, res) {
        try {
            const { id } = req.params;
            const { status } = req.body; // 'resolved' | 'dismissed'
            if (!['resolved', 'dismissed'].includes(status)) {
                return res.status(400).json({ success: false, message: 'status must be resolved or dismissed' });
            }
            const report = await prisma_1.prisma.report.update({
                where: { id },
                data: { status },
            });
            res.status(200).json({ success: true, data: report });
        }
        catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    }
}
exports.AdminController = AdminController;
//# sourceMappingURL=admin.controller.js.map