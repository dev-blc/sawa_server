import { Server as SocketIOServer, Socket } from 'socket.io';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { pushToUser } from '../services/push.service';
import { invalidateNotifUnreadCount, cacheSet } from '../lib/cache';

/** Redis key for a user's last shared feeling. TTL 7 days. */
const feelingKey = (coupleId: string, userId: string) =>
  `us:feeling:${coupleId}:${userId}`;

/**
 * US Space Socket Handlers
 * ─────────────────────────────────────────────────────────────────────────
 * Handles real-time events between the two individual users of a couple:
 *   • us:nudge   — one partner sends a nudge (love, water reminder, etc.)
 *   • us:love    — quick love tap
 *   • us:feeling — partner shares how they feel
 *
 * PRIVACY RULE: These events are strictly private between the two partners.
 *   - The server relays each event to the couple room EXCLUDING the sender's
 *     socket so the sender never receives their own event.
 *   - Push notifications are sent ONLY to the partner (by userId), never to
 *     the sender, so the sender's notification tray stays clean.
 *   - Community/match notifications remain unchanged and go to both partners
 *     as before.
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * Persist a couple-internal notification (love / hug / date plan) so it
 * shows up in the partner's in-app Notifications screen.
 *
 * Both partners share the same coupleId so `recipientId = coupleId`.
 * We store `senderUserId` inside `data` so the client can suppress the
 * notification for the person who sent it (sender sees nothing, only
 * the partner sees it).
 */
async function saveUsNotification(params: {
  coupleId: string;
  senderUserId: string;
  subtype:
    | 'us_love'
    | 'us_hug'
    | 'us_kiss'
    | 'us_date_plan'
    | 'us_thinking'
    | 'us_missyou'
    | 'us_cheerup'
    | 'us_here'
    | 'us_appreciate'
    | 'us_mood';
  title: string;
  message: string;
  extraData?: Record<string, unknown>;
}): Promise<void> {
  try {
    const { coupleId, senderUserId, subtype, title, message, extraData } = params;
    await prisma.notification.create({
      data: {
        recipientId: coupleId,
        senderId: coupleId,
        type: 'system',
        title,
        message,
        data: { subtype, senderUserId, navigate: 'UsSpace', ...extraData },
        read: false,
      },
    });
    // Bust cached unread count so the bell badge updates immediately.
    await invalidateNotifUnreadCount(coupleId);
  } catch (err: any) {
    logger.warn(`[UsSocket] saveUsNotification failed: ${err.message}`);
  }
}

/** Returns just the first word of a name (e.g. "Kiran Bhangay" → "Kiran"). */
function firstName(name: string): string {
  return (name || '').split(/\s+/)[0] || name;
}

/** Look up the partner's User.id given the sender's userId + coupleId. */
async function findPartnerId(
  senderUserId: string,
  coupleId: string,
): Promise<string | null> {
  try {
    const couple = await prisma.couple.findUnique({
      where: { coupleId },
      select: { partner1Id: true, partner2Id: true },
    });
    if (!couple) return null;
    if (couple.partner1Id === senderUserId) return couple.partner2Id;
    if (couple.partner2Id === senderUserId) return couple.partner1Id;
    return null;
  } catch (err: any) {
    logger.warn(`[UsSocket] findPartnerId failed: ${err.message}`);
    return null;
  }
}

export const registerUsHandlers = (io: SocketIOServer, socket: Socket): void => {
  const { userId, coupleId, userName } = socket;

  // ── us:nudge ──────────────────────────────────────────────────────────
  socket.on(
    'us:nudge',
    async (payload: { kind: string; message: string; at: string; date?: string; rawDate?: string; activity?: string; time?: string; note?: string }) => {
      if (!userId || !coupleId) return;

      logger.info(`[UsSocket] nudge(${payload.kind}) from ${userId} (${userName}) in couple ${coupleId}`);

      const senderName = firstName(userName || 'Your partner');

      // 1. Real-time relay — partner's socket only (exclude sender).
      io.to(`couple:${coupleId}`).except(socket.id).emit('us:nudge', {
        kind: payload.kind,
        message: payload.message,
        at: payload.at,
        from: senderName,
        date: payload.date,
        rawDate: payload.rawDate,
        activity: payload.activity,
        time: payload.time,
        note: payload.note,
      });

      // 2. Save in-app notification & set push title based on kind.
      const partnerId = await findPartnerId(userId, coupleId);
      let pushTitle = `${senderName} sent you a nudge 💛`;

      if (payload.kind === 'hug') {
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_hug',
          title: `${senderName} sent you a hug`,
          message: 'Warm hug heading your way',
        });
        pushTitle = `${senderName} sent you a hug 🤗`;

      } else if (payload.kind === 'kiss') {
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_kiss',
          title: `${senderName} sent you a kiss`,
          message: 'A sweet kiss from your partner',
        });
        pushTitle = `${senderName} sent you a kiss 💋`;

      } else if (payload.kind === 'date_request') {
        const actLabel = payload.activity ? payload.activity : 'a date';
        const timeLabel = payload.time ? ` at ${payload.time}` : '';
        const dateMsg = payload.date ? `Wants to go out on ${payload.date}${timeLabel} ✨` : 'Wants to plan something special ✨';
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_date_plan',
          title: `Date request · ${actLabel}`,
          message: payload.note ? `${dateMsg.replace(' ✨', '')} — "${payload.note}"` : dateMsg.replace(' ✨', ''),
          extraData: { date: payload.date, rawDate: payload.rawDate, activity: payload.activity, time: payload.time, note: payload.note, kind: 'date_request' },
        });
        pushTitle = `${senderName} wants to plan ${actLabel} 📅`;

      } else if (payload.kind === 'date_accept') {
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_date_plan',
          title: '🎉 Date confirmed!',
          message: `It's on the calendar 🗓️`,
          extraData: { date: payload.date, rawDate: payload.rawDate, activity: payload.activity, kind: 'date_accept' },
        });
        pushTitle = `${senderName} confirmed the date! 🎉`;

      } else if (payload.kind === 'date_reject') {
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_date_plan',
          title: '😔 Date declined',
          message: 'Maybe next time 🙏',
          extraData: { kind: 'date_reject' },
        });
        pushTitle = `${senderName} couldn't make it this time`;

      } else if (payload.kind === 'date_plan') {
        // Legacy fallback
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_date_plan',
          title: `${senderName} planned a date`,
          message: payload.message || 'A date has been planned for you two!',
          extraData: { date: payload.date, rawDate: payload.rawDate, activity: payload.activity },
        });

      } else if (payload.kind === 'thinking') {
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_thinking',
          title: `${senderName} is thinking of you`,
          message: 'You crossed their mind right now',
        });
        pushTitle = `${senderName} is thinking of you`;

      } else if (payload.kind === 'missyou') {
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_missyou',
          title: `${senderName} misses you`,
          message: 'They wish you were here',
        });
        pushTitle = `${senderName} misses you`;

      } else if (payload.kind === 'cheerup') {
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_cheerup',
          title: `${senderName} is cheering you up`,
          message: 'A little boost from your partner',
        });
        pushTitle = `${senderName} is cheering you up`;

      } else if (payload.kind === 'here') {
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_here',
          title: `${senderName} is here for you`,
          message: 'You have their full support',
        });
        pushTitle = `${senderName} is here for you`;

      } else if (payload.kind === 'appreciate') {
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_appreciate',
          title: `${senderName} appreciates you`,
          message: 'They are grateful to have you',
        });
        pushTitle = `${senderName} appreciates you`;
      }

      // 3. In-app notification badge: tell the partner's Notifications screen to
      //    re-fetch immediately. Without this the date request sits in the DB but
      //    the partner's list never refreshes on its own (no socket push is sent
      //    by saveUsNotification itself).
      io.to(`couple:${coupleId}`).except(socket.id).emit('notification:new', {
        type: 'us_nudge',
        kind: payload.kind,
      });

      // 4. Push notification — only to the partner device.
      if (partnerId) {
        pushToUser(partnerId, {
          title: pushTitle,
          body: payload.message,
          data: {
            type: 'us_nudge',
            kind: payload.kind,
            navigate: 'UsSpace',
          },
          collapseKey: 'us_nudge',
        }).catch(() => null);
      }
    },
  );

  // ── us:love ───────────────────────────────────────────────────────────
  socket.on('us:love', async (payload: { from: string; at: string }) => {
    if (!userId || !coupleId) return;

    logger.info(`[UsSocket] love from ${userId} (${userName}) in couple ${coupleId}`);

    const senderName = firstName(payload.from || userName || 'Your partner');

    io.to(`couple:${coupleId}`).except(socket.id).emit('us:love', {
      from: senderName,
      at: payload.at,
    });

    // Save in-app notification (partner sees it; sender is filtered client-side).
    await saveUsNotification({
      coupleId,
      senderUserId: userId,
      subtype: 'us_love',
      title: `${senderName} sent you love ❤️`,
      message: 'Thinking of you 💛',
    });

    // Tell the partner's Notifications screen to refresh right away.
    io.to(`couple:${coupleId}`).except(socket.id).emit('notification:new', {
      type: 'us_love',
    });

    const partnerId = await findPartnerId(userId, coupleId);
    if (partnerId) {
      pushToUser(partnerId, {
        title: `${senderName} sent you love ❤️`,
        body: 'Open the US space to see it',
        data: { type: 'us_love', navigate: 'UsSpace' },
        collapseKey: 'us_love',
      }).catch(() => null);
    }
  });

  // ── us:feeling ────────────────────────────────────────────────────────
  socket.on(
    'us:feeling',
    async (payload: { feeling: string; note: string; at: string }) => {
      if (!userId || !coupleId) return;

      logger.info(`[UsSocket] feeling from ${userId} (${userName}) in couple ${coupleId}`);

      const senderFirstName = firstName(userName || 'Your partner');

      const feelingPayload = {
        feeling: payload.feeling,
        note: payload.note,
        at: payload.at,
        from: senderFirstName,
      };

      // Persist so the partner can fetch it on any fresh login (7-day TTL)
      cacheSet(
        feelingKey(coupleId, userId),
        JSON.stringify(feelingPayload),
        7 * 24 * 60 * 60,
      ).catch(() => {});

      io.to(`couple:${coupleId}`).except(socket.id).emit('us:feeling', feelingPayload);

      const feelingLabel = payload.feeling || 'something';

      // Persist an in-app notification so the mood change shows up in the
      // partner's Notifications screen (sender is filtered out client-side).
      await saveUsNotification({
        coupleId,
        senderUserId: userId,
        subtype: 'us_mood',
        title: `${senderFirstName} updated their mood`,
        message: payload.note?.trim()
          ? `Feeling ${feelingLabel} — "${payload.note.trim()}"`
          : `They're feeling ${feelingLabel} right now`,
        extraData: { feeling: payload.feeling },
      });

      // Tell the partner's Notifications screen to refresh right away.
      io.to(`couple:${coupleId}`).except(socket.id).emit('notification:new', {
        type: 'us_mood',
        feeling: payload.feeling,
      });

      const partnerId = await findPartnerId(userId, coupleId);
      if (partnerId) {
        pushToUser(partnerId, {
          title: `${senderFirstName} shared how they feel`,
          body: payload.note?.trim()
            ? `"${payload.note.trim()}"`
            : `They're feeling ${feelingLabel} right now`,
          data: { type: 'us_feeling', feeling: payload.feeling, navigate: 'UsSpace' },
          collapseKey: 'us_feeling',
        }).catch(() => null);
      }
    },
  );
};
