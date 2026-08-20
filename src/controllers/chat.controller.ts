import { Request, Response } from 'express';
import { z } from 'zod';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/AppError';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { getCoupleCommunityColor } from '../utils/communityColors';
import { encodeCursor, decodeCursor, clampLimit } from '../utils/cursor';
import {
  createPresignedUpload,
  createPresignedDownload,
  isStorageConfigured,
} from '../lib/storage';

// Default chat history page size when the client sends no `?limit=`. Cursor
// pagination lets the app load older messages on demand (RULES §5).
// Default when the client sends no limit param. 100 = exact parity with the
// pre-pagination behavior (`take: 100`), because the shipped store build sends
// no params and cannot ask for older pages — halving its window was a
// regression. Paginating clients request `limit=50` explicitly for a faster
// first paint and walk older history via `cursor`.
const PRIVATE_MESSAGES_DEFAULT_LIMIT = 100;

/**
 * Allowed upload content types per kind (v3 M6). The presigned PUT streams
 * straight to object storage, bypassing the app's JSON body limit, so the type
 * and size the client declares are the only gate. Verified against the mobile
 * `uploadMedia.ts`: voice notes are recorded as `audio/aac` (.m4a); images are
 * sent as the picker's mime — overwhelmingly `image/jpeg`, plus png/webp. An
 * unlisted type is refused (415); the mobile client then falls back to its
 * legacy base64 path, so the allowlist never hard-breaks a real upload.
 */
const ALLOWED_UPLOAD_CONTENT_TYPES: Record<'voice' | 'image', ReadonlySet<string>> = {
  voice: new Set(['audio/aac', 'audio/mpeg', 'audio/m4a']),
  image: new Set(['image/jpeg', 'image/png', 'image/webp']),
};

// ─── Authorization helpers (prevent chat IDOR) ────────────────────────────────
// A couple may only read/write a private chat if it is one of the two matched
// couples, and a group chat only if it is a member of that community.
async function assertMatchParticipant(matchId: string, coupleId: string): Promise<void> {
  const match = await prisma.match.findFirst({
    where: { id: matchId, OR: [{ couple1Id: coupleId }, { couple2Id: coupleId }] },
    select: { id: true },
  });
  if (!match) throw new AppError('Not authorized for this chat', 403, 'FORBIDDEN');
}

async function assertCommunityMember(communityId: string, coupleId: string): Promise<void> {
  const member = await prisma.communityMember.findFirst({
    where: { communityId, coupleId },
    select: { communityId: true },
  });
  if (!member) throw new AppError('Not authorized for this community', 403, 'FORBIDDEN');
}

export const getUnreadCounts = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const { coupleId } = req.user;
  if (!coupleId) throw new AppError('Couple ID required', 400);

  const matches = await prisma.match.findMany({
    where: {
      OR: [{ couple1Id: coupleId }, { couple2Id: coupleId }],
      status: 'accepted',
    },
    select: { id: true },
  });

  const counts: Record<string, { unreadCount: number; lastMessage: string | null; lastMessageTime: string | null }> = {};

  if (matches.length === 0) {
    sendSuccess({ res, data: { counts } });
    return;
  }

  const matchIds = matches.map((m) => m.id);

  // Was: 2×N queries (count + findFirst per match).
  // Now: 2 bulk queries total regardless of how many matches exist.
  const [unreadRows, lastMsgRows] = await Promise.all([
    // Unread count per matchId in one GROUP BY query.
    prisma.$queryRaw<Array<{ matchId: string; unreadCount: bigint }>>`
      SELECT "matchId", COUNT(*) AS "unreadCount"
      FROM "messages"
      WHERE "matchId" = ANY(${matchIds}::text[])
        AND "chatType" = 'private'
        AND "senderId" != ${coupleId}
        AND NOT (${coupleId} = ANY("readBy"))
      GROUP BY "matchId"
    `,
    // Latest message per matchId using DISTINCT ON (single pass).
    prisma.$queryRaw<Array<{ matchId: string; content: string; contentType: string; createdAt: Date }>>`
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

  sendSuccess({ res, data: { counts } });
};

export const getGroupUnreadCounts = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const { coupleId } = req.user;
  if (!coupleId) throw new AppError('Couple ID required', 400);

  // All communities this couple belongs to
  const memberships = await prisma.communityMember.findMany({
    where: { coupleId },
    select: { communityId: true },
  });

  const counts: Record<
    string,
    { unreadCount: number; lastMessage: string | null; lastMessageTime: string | null }
  > = {};

  if (memberships.length === 0) {
    sendSuccess({ res, data: { counts } });
    return;
  }

  const communityIds = memberships.map((m) => m.communityId);

  // Was: 2×N queries per community.
  // Now: 2 bulk queries total.
  const [unreadRows, lastMsgRows] = await Promise.all([
    prisma.$queryRaw<Array<{ communityId: string; unreadCount: bigint }>>`
      SELECT "communityId", COUNT(*) AS "unreadCount"
      FROM "messages"
      WHERE "communityId" = ANY(${communityIds}::text[])
        AND "chatType" = 'group'
        AND "senderId" != ${coupleId}
        AND NOT (${coupleId} = ANY("readBy"))
      GROUP BY "communityId"
    `,
    prisma.$queryRaw<Array<{ communityId: string; content: string; contentType: string; createdAt: Date; senderName: string }>>`
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
    let lastMessagePreview: string | null = null;
    if (lastMsg) {
      const firstName = (lastMsg.senderName || 'Someone').split(' ')[0];
      const text =
        lastMsg.contentType === 'text'
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

  sendSuccess({ res, data: { counts } });
};

export const getPrivateMessages = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const { matchId } = req.params;
  const { coupleId } = req.user;
  if (!coupleId) throw new AppError('Couple ID required', 400);
  await assertMatchParticipant(matchId, coupleId);

  // Cursor pagination — additive and backward compatible. No params → the most
  // recent PRIVATE_MESSAGES_DEFAULT_LIMIT messages, oldest→newest as before,
  // plus a `nextCursor` for loading OLDER history. `?cursor=<opaque>&limit=<n>`
  // (limit capped at 100) walks backwards in time. The shipped mobile client
  // sends neither and keeps reading `data.messages`; `data.nextCursor` is new.
  const limit = clampLimit(req.query.limit, PRIVATE_MESSAGES_DEFAULT_LIMIT);
  const decoded = decodeCursor(req.query.cursor);

  const rows = await prisma.message.findMany({
    where: {
      chatType: 'private',
      matchId: matchId,
      ...(decoded
        ? {
            OR: [
              { createdAt: { lt: new Date(decoded.key) } },
              { createdAt: new Date(decoded.key), id: { lt: decoded.id } },
            ],
          }
        : {}),
    },
    include: {
      sender: { select: { coupleId: true, profileName: true } },
      senderUser: { select: { role: true, name: true } },
    },
    // Total order (createdAt + id tie-break) so the cursor is stable when two
    // messages share a timestamp.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  // Peek one extra row to know whether an older page exists.
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  // Oldest row in this desc page is the cursor into the next (older) page.
  const oldest = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && oldest ? encodeCursor(oldest.createdAt.toISOString(), oldest.id) : null;

  const finalMessages = pageRows.reverse().map((m: any) => {
    // Derive a human-readable first name. Priority order:
    // 1. Stored senderIndividualName on the message row (set at send time)
    // 2. User.name from the individual user record
    // 3. senderName stored on the message
    // 4. First partner name from couple profileName (e.g. "Kiran & Stella" → "Kiran")
    // 5. Last resort: fallback string
    const coupleFirstName = m.sender?.profileName
      ? m.sender.profileName.split(/\s*&\s*/)[m.senderUser?.role === 'partner' ? 1 : 0]?.trim()
      : undefined;
    const individualName =
      m.senderIndividualName || m.senderUser?.name || m.senderName || coupleFirstName || 'Me';
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

  sendSuccess({ res, data: { matchId, messages: finalMessages, nextCursor } });
};

export const sendPrivateMessage = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const { matchId } = req.params;
  const { content, contentType } = req.body;

  const { userId, coupleId } = req.user!;
  if (!coupleId) throw new AppError('Couple ID required', 400);
  await assertMatchParticipant(matchId, coupleId);

  const senderUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, role: true },
  });
  // Fallback: derive first name from couple profileName when user.name is not set yet
  const coupleProfile = senderUser?.name ? null : await prisma.couple.findUnique({
    where: { coupleId },
    select: { profileName: true },
  });
  const coupleFirstName = coupleProfile?.profileName
    ? coupleProfile.profileName.split(/\s*&\s*/)[senderUser?.role === 'partner' ? 1 : 0]?.trim()
    : undefined;
  const senderName =
    req.body.senderIndividualName ||
    senderUser?.name ||
    req.body.senderName ||
    coupleFirstName ||
    'Me';

  const message = await prisma.message.create({
    data: {
      chatType: 'private',
      matchId: matchId,
      senderId: coupleId,
      senderUserId: userId,
      senderName,
      senderIndividualName: senderName,
      content,
      contentType: (contentType || 'text') as any,
      audioDuration: req.body.audioDuration,
      repliedToId: req.body.repliedToId,
      repliedToText: req.body.repliedToText,
      repliedToName: req.body.repliedToName,
    }
  });

  sendSuccess({ res, data: { message: { ...message, _id: message.id } }, statusCode: 201 });
};

export const getGroupMessages = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const { communityId } = req.params;
  const { coupleId } = req.user;
  if (!coupleId) throw new AppError('Couple ID required', 400);
  await assertCommunityMember(communityId, coupleId);

  const messages = await prisma.message.findMany({
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

  const finalMessages = messages.reverse().map((m: any) => {
    return {
      _id: m.id,
      content: m.content,
      contentType: m.contentType,
      senderCoupleId: m.senderId,
      senderName: m.sender?.profileName || m.senderName || 'Matched Couple', 
      senderIndividualName: m.senderName || 'User', 
      accent: getCoupleCommunityColor(m.senderId),
      timestamp: m.createdAt,
      readBy: m.readBy || [],
      audioDuration: m.audioDuration,
      repliedToId: m.repliedToId,
      repliedToText: m.repliedToText,
      repliedToName: m.repliedToName,
    };
  });

  sendSuccess({ res, data: { communityId, messages: finalMessages } });
};

export const sendGroupMessage = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const { communityId } = req.params;
  const { content, contentType } = req.body;

  const { userId, coupleId } = req.user!;
  if (!coupleId) throw new AppError('Couple ID required', 400);
  await assertCommunityMember(communityId, coupleId);

  const senderUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true },
  });
  const senderName =
    req.body.senderIndividualName ||
    senderUser?.name ||
    req.body.senderName ||
    'User';

  const message = await prisma.message.create({
    data: {
      chatType: 'group',
      communityId: communityId,
      senderId: coupleId,
      senderUserId: userId,
      senderName,
      senderIndividualName: senderName,
      content,
      contentType: (contentType || 'text') as any,
      audioDuration: req.body.audioDuration,
      repliedToId: req.body.repliedToId,
      repliedToText: req.body.repliedToText,
      repliedToName: req.body.repliedToName,
    }
  });

  sendSuccess({ res, data: { message: { ...message, _id: message.id } }, statusCode: 201 });
};

export const editMessage = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const { messageId } = req.params;
  const { content } = req.body;
  const { coupleId } = req.user;

  if (!content?.trim()) throw new AppError('Content is required', 400);

  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) throw new AppError('Message not found', 404);
  if (message.senderId !== coupleId) throw new AppError('Not authorized to edit this message', 403);
  if (message.contentType !== 'text') throw new AppError('Only text messages can be edited', 400);

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { content: content.trim() },
  });

  // Broadcast updated text to everyone in the chat room in real-time
  const io = (global as any).io;
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

  sendSuccess({ res, data: { message: { ...updated, _id: updated.id } } });
};

export const deleteMessage = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const { messageId } = req.params;
  const forEveryone = req.query.forEveryone === 'true';
  const { coupleId } = req.user;

  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) throw new AppError('Message not found', 404);

  if (forEveryone) {
    if (message.senderId !== coupleId) throw new AppError('Not authorized to delete this message for everyone', 403);

    const chatId = message.matchId || message.communityId;
    await prisma.message.delete({ where: { id: messageId } });

    // Broadcast deletion to everyone in the chat room in real-time
    const io = (global as any).io;
    if (io && chatId) {
      io.to(`chat:${chatId}`).emit('chat:messageDeleted', {
        messageId,
        chatId,
      });
    }
  }
  // "Delete for me" is handled client-side only — no DB change needed

  sendSuccess({ res, data: { messageId, forEveryone } });
};

/**
 * POST /api/v1/chats/:chatId/read
 * Marks all messages in a private or group chat as read for the current user.
 * Called by the client when opening any chat thread — more reliable than socket-only approach.
 */
export const markChatRead = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const { coupleId } = req.user;
  if (!coupleId) throw new AppError('Couple ID required', 400);

  const { chatId } = req.params;
  if (!chatId) throw new AppError('Chat ID required', 400);

  // Only allow marking a chat read if the caller participates in it (private
  // match participant or community member) — otherwise it's an IDOR.
  const [matchMembership, communityMembership] = await Promise.all([
    prisma.match.findFirst({
      where: { id: chatId, OR: [{ couple1Id: coupleId }, { couple2Id: coupleId }] },
      select: { id: true },
    }),
    prisma.communityMember.findFirst({
      where: { communityId: chatId, coupleId },
      select: { communityId: true },
    }),
  ]);
  if (!matchMembership && !communityMembership) {
    throw new AppError('Not authorized for this chat', 403, 'FORBIDDEN');
  }

  // Mark all unread messages read in ONE statement using array_append, instead
  // of fetching every row and issuing an UPDATE per message (old N+1 pattern).
  // `array_append(... )` with the NOT(... = ANY) guard is idempotent.
  const markedCount = await prisma.$executeRaw`
    UPDATE "messages"
    SET "readBy" = array_append("readBy", ${coupleId})
    WHERE ("matchId" = ${chatId} OR "communityId" = ${chatId})
      AND "senderId" <> ${coupleId}
      AND NOT (${coupleId} = ANY("readBy"))
  `;

  // Notify the calling user's socket so BottomToggleBar refreshes its badge counts immediately.
  const io = (global as any).io;
  if (io) {
    io.to(`couple:${coupleId}`).emit('chat:markRead', { chatId, coupleId });
  }

  sendSuccess({ res, data: { chatId, read: true, markedCount } });
};

/**
 * POST /api/v1/chats/upload-url
 * Returns a short-lived presigned URL the client uploads chat media (voice
 * notes) directly to object storage with. The client then sends only the small
 * public URL through the socket, keeping large binary payloads out of the
 * socket pipeline and out of Postgres.
 */
export const createChatUploadUrl = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const { coupleId } = req.user;
  if (!coupleId) throw new AppError('Couple ID required', 400);

  if (!isStorageConfigured()) {
    throw new AppError('Media storage is not configured', 503, 'STORAGE_UNAVAILABLE');
  }

  const schema = z.object({
    kind: z.enum(['voice', 'image']).default('voice'),
    contentType: z.string().min(3).max(100).optional(),
    ext: z.string().max(8).optional(),
    // Optional declared upload size (bytes). When present it is validated
    // against the per-kind cap and signed onto the presigned PUT (hard bound).
    contentLength: z.number().int().positive().optional(),
  });
  const { kind, contentType, ext, contentLength } = schema.parse(req.body ?? {});

  const resolvedContentType =
    contentType || (kind === 'voice' ? 'audio/aac' : 'image/jpeg');
  // Normalize before the allowlist check: drop any `; charset=`/`; codecs=`
  // parameter and lowercase. This exact string is what the URL is signed with,
  // so the client must echo it back as the PUT Content-Type header.
  const normalizedContentType = resolvedContentType.split(';')[0].trim().toLowerCase();

  if (!ALLOWED_UPLOAD_CONTENT_TYPES[kind].has(normalizedContentType)) {
    throw new AppError('Unsupported media type', 415, 'UNSUPPORTED_MEDIA_TYPE');
  }

  // Size cap (v3 M6): reject an oversize DECLARED length up front; when declared
  // it is also signed onto the PUT so storage rejects a mismatched body.
  const maxBytes = kind === 'voice' ? env.S3_MAX_VOICE_BYTES : env.S3_MAX_IMAGE_BYTES;
  if (contentLength !== undefined && contentLength > maxBytes) {
    throw new AppError('Media exceeds the maximum allowed size', 413, 'MEDIA_TOO_LARGE');
  }

  const { uploadUrl, publicUrl, key } = await createPresignedUpload({
    folder: kind,
    contentType: normalizedContentType,
    ext,
    coupleId,
    contentLength,
  });

  // The bucket is private; the message stores this stable reference and playback
  // resolves a fresh presigned URL via GET /chats/media-url.
  const ref = `s3:${key}`;

  sendSuccess({
    res,
    data: { uploadUrl, publicUrl, key, ref, contentType: normalizedContentType },
  });
};

/**
 * GET /api/v1/chats/media-url?key=voice/...   (or ?ref=s3:voice/...)
 * Returns a short-lived presigned download URL for a stored media object.
 * Used by the client to play voice notes from the private bucket.
 */
export const getMediaUrl = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const { coupleId } = req.user;

  if (!isStorageConfigured()) {
    throw new AppError('Media storage is not configured', 503, 'STORAGE_UNAVAILABLE');
  }

  const raw = String(req.query.key ?? req.query.ref ?? '');
  const key = raw.startsWith('s3:') ? raw.slice(3) : raw;

  // Only allow our own media prefixes — never sign arbitrary keys.
  if (!key || !/^(voice|image)\//.test(key)) {
    throw new AppError('Invalid media reference', 400, 'INVALID_KEY');
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
      prisma.match.findFirst({
        where: {
          OR: [
            { couple1Id: coupleId, couple2Id: ownerCouple },
            { couple1Id: ownerCouple, couple2Id: coupleId },
          ],
        },
        select: { id: true },
      }),
      prisma.communityMember.findMany({ where: { coupleId }, select: { communityId: true } }),
    ]);
    if (match) {
      allowed = true;
    } else if (myComms.length) {
      const shared = await prisma.communityMember.findFirst({
        where: { coupleId: ownerCouple, communityId: { in: myComms.map((c) => c.communityId) } },
        select: { communityId: true },
      });
      allowed = !!shared;
    }
  }
  if (!allowed) {
    throw new AppError('Not allowed to access this media', 403, 'FORBIDDEN');
  }

  const url = await createPresignedDownload(key);
  sendSuccess({ res, data: { url } });
};
