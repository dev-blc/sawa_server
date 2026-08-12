"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMediaUrl = exports.createChatUploadUrl = exports.markChatRead = exports.deleteMessage = exports.editMessage = exports.sendGroupMessage = exports.getGroupMessages = exports.sendPrivateMessage = exports.getPrivateMessages = exports.getGroupUnreadCounts = exports.getUnreadCounts = void 0;
const zod_1 = require("zod");
const response_1 = require("../utils/response");
const AppError_1 = require("../utils/AppError");
const prisma_1 = require("../lib/prisma");
const communityColors_1 = require("../utils/communityColors");
const storage_1 = require("../lib/storage");
// ─── Authorization helpers (prevent chat IDOR) ────────────────────────────────
// A couple may only read/write a private chat if it is one of the two matched
// couples, and a group chat only if it is a member of that community.
async function assertMatchParticipant(matchId, coupleId) {
    const match = await prisma_1.prisma.match.findFirst({
        where: { id: matchId, OR: [{ couple1Id: coupleId }, { couple2Id: coupleId }] },
        select: { id: true },
    });
    if (!match)
        throw new AppError_1.AppError('Not authorized for this chat', 403, 'FORBIDDEN');
}
async function assertCommunityMember(communityId, coupleId) {
    const member = await prisma_1.prisma.communityMember.findFirst({
        where: { communityId, coupleId },
        select: { communityId: true },
    });
    if (!member)
        throw new AppError_1.AppError('Not authorized for this community', 403, 'FORBIDDEN');
}
const getUnreadCounts = async (req, res) => {
    if (!req.user)
        throw new AppError_1.AppError('Unauthorized', 401);
    const { coupleId } = req.user;
    if (!coupleId)
        throw new AppError_1.AppError('Couple ID required', 400);
    const matches = await prisma_1.prisma.match.findMany({
        where: {
            OR: [{ couple1Id: coupleId }, { couple2Id: coupleId }],
            status: 'accepted',
        },
        select: { id: true },
    });
    const counts = {};
    if (matches.length === 0) {
        (0, response_1.sendSuccess)({ res, data: { counts } });
        return;
    }
    const matchIds = matches.map((m) => m.id);
    // Was: 2×N queries (count + findFirst per match).
    // Now: 2 bulk queries total regardless of how many matches exist.
    const [unreadRows, lastMsgRows] = await Promise.all([
        // Unread count per matchId in one GROUP BY query.
        prisma_1.prisma.$queryRaw `
      SELECT "matchId", COUNT(*) AS "unreadCount"
      FROM "messages"
      WHERE "matchId" = ANY(${matchIds}::text[])
        AND "chatType" = 'private'
        AND "senderId" != ${coupleId}
        AND NOT (${coupleId} = ANY("readBy"))
      GROUP BY "matchId"
    `,
        // Latest message per matchId using DISTINCT ON (single pass).
        prisma_1.prisma.$queryRaw `
      SELECT DISTINCT ON ("matchId") "matchId", content, "contentType", "createdAt"
      FROM "messages"
      WHERE "matchId" = ANY(${matchIds}::text[])
        AND "chatType" = 'private'
      ORDER BY "matchId", "createdAt" DESC
    `,
    ]);
    const unreadByMatch = new Map(unreadRows.map((r) => [r.matchId, Number(r.unreadCount)]));
    const lastMsgByMatch = new Map(lastMsgRows.map((r) => [r.matchId, r]));
    for (const { id: matchId } of matches) {
        const lastMsg = lastMsgByMatch.get(matchId);
        counts[matchId] = {
            unreadCount: unreadByMatch.get(matchId) ?? 0,
            lastMessage: lastMsg
                ? lastMsg.contentType === 'text'
                    ? lastMsg.content
                    : lastMsg.contentType === 'audio'
                        ? 'Voice message'
                        : lastMsg.contentType === 'image'
                            ? 'Photo'
                            : lastMsg.content
                : null,
            lastMessageTime: lastMsg?.createdAt?.toISOString() ?? null,
        };
    }
    (0, response_1.sendSuccess)({ res, data: { counts } });
};
exports.getUnreadCounts = getUnreadCounts;
const getGroupUnreadCounts = async (req, res) => {
    if (!req.user)
        throw new AppError_1.AppError('Unauthorized', 401);
    const { coupleId } = req.user;
    if (!coupleId)
        throw new AppError_1.AppError('Couple ID required', 400);
    // All communities this couple belongs to
    const memberships = await prisma_1.prisma.communityMember.findMany({
        where: { coupleId },
        select: { communityId: true },
    });
    const counts = {};
    if (memberships.length === 0) {
        (0, response_1.sendSuccess)({ res, data: { counts } });
        return;
    }
    const communityIds = memberships.map((m) => m.communityId);
    // Was: 2×N queries per community.
    // Now: 2 bulk queries total.
    const [unreadRows, lastMsgRows] = await Promise.all([
        prisma_1.prisma.$queryRaw `
      SELECT "communityId", COUNT(*) AS "unreadCount"
      FROM "messages"
      WHERE "communityId" = ANY(${communityIds}::text[])
        AND "chatType" = 'group'
        AND "senderId" != ${coupleId}
        AND NOT (${coupleId} = ANY("readBy"))
      GROUP BY "communityId"
    `,
        prisma_1.prisma.$queryRaw `
      SELECT DISTINCT ON ("communityId") "communityId", content, "contentType", "createdAt", "senderName"
      FROM "messages"
      WHERE "communityId" = ANY(${communityIds}::text[])
        AND "chatType" = 'group'
      ORDER BY "communityId", "createdAt" DESC
    `,
    ]);
    const unreadByCommunity = new Map(unreadRows.map((r) => [r.communityId, Number(r.unreadCount)]));
    const lastMsgByCommunity = new Map(lastMsgRows.map((r) => [r.communityId, r]));
    for (const { communityId } of memberships) {
        const lastMsg = lastMsgByCommunity.get(communityId);
        let lastMessagePreview = null;
        if (lastMsg) {
            const firstName = (lastMsg.senderName || 'Someone').split(' ')[0];
            const text = lastMsg.contentType === 'text'
                ? lastMsg.content
                : lastMsg.contentType === 'audio'
                    ? 'Voice message'
                    : lastMsg.contentType === 'image'
                        ? 'Photo'
                        : lastMsg.content;
            lastMessagePreview = `${firstName}: ${text}`;
        }
        counts[communityId] = {
            unreadCount: unreadByCommunity.get(communityId) ?? 0,
            lastMessage: lastMessagePreview,
            lastMessageTime: lastMsg?.createdAt?.toISOString() ?? null,
        };
    }
    (0, response_1.sendSuccess)({ res, data: { counts } });
};
exports.getGroupUnreadCounts = getGroupUnreadCounts;
const getPrivateMessages = async (req, res) => {
    if (!req.user)
        throw new AppError_1.AppError('Unauthorized', 401);
    const { matchId } = req.params;
    const { coupleId } = req.user;
    if (!coupleId)
        throw new AppError_1.AppError('Couple ID required', 400);
    await assertMatchParticipant(matchId, coupleId);
    const messages = await prisma_1.prisma.message.findMany({
        where: {
            chatType: 'private',
            matchId: matchId,
        },
        include: {
            sender: { select: { coupleId: true, profileName: true } },
            senderUser: { select: { role: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
    });
    const finalMessages = messages.reverse().map((m) => {
        // Derive a human-readable first name. Priority order:
        // 1. Stored senderIndividualName on the message row (set at send time)
        // 2. User.name from the individual user record
        // 3. senderName stored on the message
        // 4. First partner name from couple profileName (e.g. "Kiran & Stella" → "Kiran")
        // 5. Last resort: fallback string
        const coupleFirstName = m.sender?.profileName
            ? m.sender.profileName.split(/\s*&\s*/)[m.senderUser?.role === 'partner' ? 1 : 0]?.trim()
            : undefined;
        const individualName = m.senderIndividualName || m.senderUser?.name || m.senderName || coupleFirstName || 'Me';
        return {
            _id: m.id,
            content: m.content,
            contentType: m.contentType,
            senderName: individualName,
            senderUserId: m.senderUserId,
            senderRole: m.senderUser?.role,
            senderCoupleId: m.sender?.coupleId,
            senderIndividualName: individualName,
            timestamp: m.createdAt,
            readBy: m.readBy || [],
            audioDuration: m.audioDuration,
            repliedToId: m.repliedToId,
            repliedToText: m.repliedToText,
            repliedToName: m.repliedToName,
            senderImage: undefined
        };
    });
    (0, response_1.sendSuccess)({ res, data: { matchId, messages: finalMessages } });
};
exports.getPrivateMessages = getPrivateMessages;
const sendPrivateMessage = async (req, res) => {
    if (!req.user)
        throw new AppError_1.AppError('Unauthorized', 401);
    const { matchId } = req.params;
    const { content, contentType } = req.body;
    const { userId, coupleId } = req.user;
    if (!coupleId)
        throw new AppError_1.AppError('Couple ID required', 400);
    await assertMatchParticipant(matchId, coupleId);
    const senderUser = await prisma_1.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, role: true },
    });
    // Fallback: derive first name from couple profileName when user.name is not set yet
    const coupleProfile = senderUser?.name ? null : await prisma_1.prisma.couple.findUnique({
        where: { coupleId },
        select: { profileName: true },
    });
    const coupleFirstName = coupleProfile?.profileName
        ? coupleProfile.profileName.split(/\s*&\s*/)[senderUser?.role === 'partner' ? 1 : 0]?.trim()
        : undefined;
    const senderName = req.body.senderIndividualName ||
        senderUser?.name ||
        req.body.senderName ||
        coupleFirstName ||
        'Me';
    const message = await prisma_1.prisma.message.create({
        data: {
            chatType: 'private',
            matchId: matchId,
            senderId: coupleId,
            senderUserId: userId,
            senderName,
            senderIndividualName: senderName,
            content,
            contentType: (contentType || 'text'),
            audioDuration: req.body.audioDuration,
            repliedToId: req.body.repliedToId,
            repliedToText: req.body.repliedToText,
            repliedToName: req.body.repliedToName,
        }
    });
    (0, response_1.sendSuccess)({ res, data: { message: { ...message, _id: message.id } }, statusCode: 201 });
};
exports.sendPrivateMessage = sendPrivateMessage;
const getGroupMessages = async (req, res) => {
    if (!req.user)
        throw new AppError_1.AppError('Unauthorized', 401);
    const { communityId } = req.params;
    const { coupleId } = req.user;
    if (!coupleId)
        throw new AppError_1.AppError('Couple ID required', 400);
    await assertCommunityMember(communityId, coupleId);
    const messages = await prisma_1.prisma.message.findMany({
        where: {
            chatType: 'group',
            communityId: communityId,
        },
        include: {
            sender: { select: { coupleId: true, profileName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
    });
    const finalMessages = messages.reverse().map((m) => {
        return {
            _id: m.id,
            content: m.content,
            contentType: m.contentType,
            senderCoupleId: m.senderId,
            senderName: m.sender?.profileName || m.senderName || 'Matched Couple',
            senderIndividualName: m.senderName || 'User',
            accent: (0, communityColors_1.getCoupleCommunityColor)(m.senderId),
            timestamp: m.createdAt,
            readBy: m.readBy || [],
            audioDuration: m.audioDuration,
            repliedToId: m.repliedToId,
            repliedToText: m.repliedToText,
            repliedToName: m.repliedToName,
        };
    });
    (0, response_1.sendSuccess)({ res, data: { communityId, messages: finalMessages } });
};
exports.getGroupMessages = getGroupMessages;
const sendGroupMessage = async (req, res) => {
    if (!req.user)
        throw new AppError_1.AppError('Unauthorized', 401);
    const { communityId } = req.params;
    const { content, contentType } = req.body;
    const { userId, coupleId } = req.user;
    if (!coupleId)
        throw new AppError_1.AppError('Couple ID required', 400);
    await assertCommunityMember(communityId, coupleId);
    const senderUser = await prisma_1.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
    });
    const senderName = req.body.senderIndividualName ||
        senderUser?.name ||
        req.body.senderName ||
        'User';
    const message = await prisma_1.prisma.message.create({
        data: {
            chatType: 'group',
            communityId: communityId,
            senderId: coupleId,
            senderUserId: userId,
            senderName,
            senderIndividualName: senderName,
            content,
            contentType: (contentType || 'text'),
            audioDuration: req.body.audioDuration,
            repliedToId: req.body.repliedToId,
            repliedToText: req.body.repliedToText,
            repliedToName: req.body.repliedToName,
        }
    });
    (0, response_1.sendSuccess)({ res, data: { message: { ...message, _id: message.id } }, statusCode: 201 });
};
exports.sendGroupMessage = sendGroupMessage;
const editMessage = async (req, res) => {
    if (!req.user)
        throw new AppError_1.AppError('Unauthorized', 401);
    const { messageId } = req.params;
    const { content } = req.body;
    const { coupleId } = req.user;
    if (!content?.trim())
        throw new AppError_1.AppError('Content is required', 400);
    const message = await prisma_1.prisma.message.findUnique({ where: { id: messageId } });
    if (!message)
        throw new AppError_1.AppError('Message not found', 404);
    if (message.senderId !== coupleId)
        throw new AppError_1.AppError('Not authorized to edit this message', 403);
    if (message.contentType !== 'text')
        throw new AppError_1.AppError('Only text messages can be edited', 400);
    const updated = await prisma_1.prisma.message.update({
        where: { id: messageId },
        data: { content: content.trim() },
    });
    // Broadcast updated text to everyone in the chat room in real-time
    const io = global.io;
    if (io) {
        const chatId = updated.matchId || updated.communityId;
        if (chatId) {
            io.to(`chat:${chatId}`).emit('chat:messageEdited', {
                messageId: updated.id,
                newContent: updated.content,
                chatId,
            });
        }
    }
    (0, response_1.sendSuccess)({ res, data: { message: { ...updated, _id: updated.id } } });
};
exports.editMessage = editMessage;
const deleteMessage = async (req, res) => {
    if (!req.user)
        throw new AppError_1.AppError('Unauthorized', 401);
    const { messageId } = req.params;
    const forEveryone = req.query.forEveryone === 'true';
    const { coupleId } = req.user;
    const message = await prisma_1.prisma.message.findUnique({ where: { id: messageId } });
    if (!message)
        throw new AppError_1.AppError('Message not found', 404);
    if (forEveryone) {
        if (message.senderId !== coupleId)
            throw new AppError_1.AppError('Not authorized to delete this message for everyone', 403);
        const chatId = message.matchId || message.communityId;
        await prisma_1.prisma.message.delete({ where: { id: messageId } });
        // Broadcast deletion to everyone in the chat room in real-time
        const io = global.io;
        if (io && chatId) {
            io.to(`chat:${chatId}`).emit('chat:messageDeleted', {
                messageId,
                chatId,
            });
        }
    }
    // "Delete for me" is handled client-side only — no DB change needed
    (0, response_1.sendSuccess)({ res, data: { messageId, forEveryone } });
};
exports.deleteMessage = deleteMessage;
/**
 * POST /api/v1/chats/:chatId/read
 * Marks all messages in a private or group chat as read for the current user.
 * Called by the client when opening any chat thread — more reliable than socket-only approach.
 */
const markChatRead = async (req, res) => {
    if (!req.user)
        throw new AppError_1.AppError('Unauthorized', 401);
    const { coupleId } = req.user;
    if (!coupleId)
        throw new AppError_1.AppError('Couple ID required', 400);
    const { chatId } = req.params;
    if (!chatId)
        throw new AppError_1.AppError('Chat ID required', 400);
    // Only allow marking a chat read if the caller participates in it (private
    // match participant or community member) — otherwise it's an IDOR.
    const [matchMembership, communityMembership] = await Promise.all([
        prisma_1.prisma.match.findFirst({
            where: { id: chatId, OR: [{ couple1Id: coupleId }, { couple2Id: coupleId }] },
            select: { id: true },
        }),
        prisma_1.prisma.communityMember.findFirst({
            where: { communityId: chatId, coupleId },
            select: { communityId: true },
        }),
    ]);
    if (!matchMembership && !communityMembership) {
        throw new AppError_1.AppError('Not authorized for this chat', 403, 'FORBIDDEN');
    }
    // Mark all unread messages read in ONE statement using array_append, instead
    // of fetching every row and issuing an UPDATE per message (old N+1 pattern).
    // `array_append(... )` with the NOT(... = ANY) guard is idempotent.
    const markedCount = await prisma_1.prisma.$executeRaw `
    UPDATE "messages"
    SET "readBy" = array_append("readBy", ${coupleId})
    WHERE ("matchId" = ${chatId} OR "communityId" = ${chatId})
      AND "senderId" <> ${coupleId}
      AND NOT (${coupleId} = ANY("readBy"))
  `;
    // Notify the calling user's socket so BottomToggleBar refreshes its badge counts immediately.
    const io = global.io;
    if (io) {
        io.to(`couple:${coupleId}`).emit('chat:markRead', { chatId, coupleId });
    }
    (0, response_1.sendSuccess)({ res, data: { chatId, read: true, markedCount } });
};
exports.markChatRead = markChatRead;
/**
 * POST /api/v1/chats/upload-url
 * Returns a short-lived presigned URL the client uploads chat media (voice
 * notes) directly to object storage with. The client then sends only the small
 * public URL through the socket, keeping large binary payloads out of the
 * socket pipeline and out of Postgres.
 */
const createChatUploadUrl = async (req, res) => {
    if (!req.user)
        throw new AppError_1.AppError('Unauthorized', 401);
    const { coupleId } = req.user;
    if (!coupleId)
        throw new AppError_1.AppError('Couple ID required', 400);
    if (!(0, storage_1.isStorageConfigured)()) {
        throw new AppError_1.AppError('Media storage is not configured', 503, 'STORAGE_UNAVAILABLE');
    }
    const schema = zod_1.z.object({
        kind: zod_1.z.enum(['voice', 'image']).default('voice'),
        contentType: zod_1.z.string().min(3).max(100).optional(),
        ext: zod_1.z.string().max(8).optional(),
    });
    const { kind, contentType, ext } = schema.parse(req.body ?? {});
    const resolvedContentType = contentType || (kind === 'voice' ? 'audio/aac' : 'image/jpeg');
    const { uploadUrl, publicUrl, key } = await (0, storage_1.createPresignedUpload)({
        folder: kind,
        contentType: resolvedContentType,
        ext,
        coupleId,
    });
    // The bucket is private; the message stores this stable reference and playback
    // resolves a fresh presigned URL via GET /chats/media-url.
    const ref = `s3:${key}`;
    (0, response_1.sendSuccess)({
        res,
        data: { uploadUrl, publicUrl, key, ref, contentType: resolvedContentType },
    });
};
exports.createChatUploadUrl = createChatUploadUrl;
/**
 * GET /api/v1/chats/media-url?key=voice/...   (or ?ref=s3:voice/...)
 * Returns a short-lived presigned download URL for a stored media object.
 * Used by the client to play voice notes from the private bucket.
 */
const getMediaUrl = async (req, res) => {
    if (!req.user)
        throw new AppError_1.AppError('Unauthorized', 401);
    const { coupleId } = req.user;
    if (!(0, storage_1.isStorageConfigured)()) {
        throw new AppError_1.AppError('Media storage is not configured', 503, 'STORAGE_UNAVAILABLE');
    }
    const raw = String(req.query.key ?? req.query.ref ?? '');
    const key = raw.startsWith('s3:') ? raw.slice(3) : raw;
    // Only allow our own media prefixes — never sign arbitrary keys.
    if (!key || !/^(voice|image)\//.test(key)) {
        throw new AppError_1.AppError('Invalid media reference', 400, 'INVALID_KEY');
    }
    // Authorization: keys are shaped `<folder>/<ownerCoupleId>/<uuid>.<ext>`. Only
    // the owning couple, or a couple that shares a chat with them (a private match
    // or a common community), may mint a download URL — otherwise any authed user
    // could sign a URL for any object. (Legacy `anon/` uploads have no owner to
    // check and rely on their unguessable UUID.)
    const ownerCouple = key.split('/')[1] || '';
    let allowed = ownerCouple === 'anon' || (!!coupleId && ownerCouple === coupleId);
    if (!allowed && coupleId && ownerCouple) {
        const [match, myComms] = await Promise.all([
            prisma_1.prisma.match.findFirst({
                where: {
                    OR: [
                        { couple1Id: coupleId, couple2Id: ownerCouple },
                        { couple1Id: ownerCouple, couple2Id: coupleId },
                    ],
                },
                select: { id: true },
            }),
            prisma_1.prisma.communityMember.findMany({ where: { coupleId }, select: { communityId: true } }),
        ]);
        if (match) {
            allowed = true;
        }
        else if (myComms.length) {
            const shared = await prisma_1.prisma.communityMember.findFirst({
                where: { coupleId: ownerCouple, communityId: { in: myComms.map((c) => c.communityId) } },
                select: { communityId: true },
            });
            allowed = !!shared;
        }
    }
    if (!allowed) {
        throw new AppError_1.AppError('Not allowed to access this media', 403, 'FORBIDDEN');
    }
    const url = await (0, storage_1.createPresignedDownload)(key);
    (0, response_1.sendSuccess)({ res, data: { url } });
};
exports.getMediaUrl = getMediaUrl;
//# sourceMappingURL=chat.controller.js.map