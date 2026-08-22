import { Server as SocketIOServer, Socket } from 'socket.io';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { pushToUser } from '../services/push.service';
import { clearGameChallengeNotification, clearDateRequestNotification, updateDateRequestNotificationData } from '../services/notification.service';
import { SOCKET_EVENTS } from '../constants/socketEvents';
import { i18nData, renderNotif, NotifParams } from '../i18n/notif';
import { invalidateNotifUnreadCount, cacheSet, cacheGet, cacheSetNX } from '../lib/cache';

/**
 * The push data's `subtype` mirrors the DB row's data.subtype so the app's tap
 * router can key on ONE vocabulary for both a push payload and a stored row.
 * (`type` stays for older clients that switch on it.)
 */
const NUDGE_SUBTYPE_BY_KIND: Record<string, string> = {
  hug: 'us_hug',
  kiss: 'us_kiss',
  date_request: 'us_date_plan',
  date_accept: 'us_date_plan',
  date_reject: 'us_date_plan',
  date_edit: 'us_date_plan',
  date_plan: 'us_date_plan',
  thinking: 'us_thinking',
  missyou: 'us_missyou',
  cheerup: 'us_cheerup',
  here: 'us_here',
  appreciate: 'us_appreciate',
};

/** Redis key for a user's last shared feeling. TTL 7 days. */
const feelingKey = (coupleId: string, userId: string) =>
  `us:feeling:${coupleId}:${userId}`;

/** An empty Tic-Tac-Toe board, encoded as 9 chars ('_' = empty cell). */
const TTT_EMPTY_BOARD = '_________';

/**
 * An empty Dots & Boxes board (3×3 boxes): 12 horizontal edges, 12 vertical
 * edges, 9 box owners, then the turn — matching the client serialization in
 * `SAWA/src/Utils/dotsAndBoxes.ts`. Stored in the same `gameBoard` text column.
 */
const DAB_EMPTY_BOARD = `${'0'.repeat(12)}|${'0'.repeat(12)}|${'-'.repeat(9)}|X`;

/**
 * A fallback Memory Match board (client normally supplies the shuffled layout in
 * the challenge `state`). Format mirrors SAWA/src/Utils/memoryMatch.ts:
 * "<16 emoji ids>|<16 owners>|<flipped>|<turn>".
 */
const MEM_EMPTY_BOARD = `0123456701234567|${'-'.repeat(16)}||X`;

/** Supported couple games. The game type is encoded in the gameId prefix. */
type GameType = 'ttt' | 'dab' | 'mem';

/** Derive the game type from a gameId (client prefixes ids with the type). */
const gameTypeOf = (gameId: string): GameType =>
  typeof gameId === 'string' && gameId.startsWith('dab_')
    ? 'dab'
    : typeof gameId === 'string' && gameId.startsWith('mem_')
    ? 'mem'
    : 'ttt';

/** The starting board string for a given game type. */
const emptyBoardFor = (type: GameType): string =>
  type === 'dab' ? DAB_EMPTY_BOARD : type === 'mem' ? MEM_EMPTY_BOARD : TTT_EMPTY_BOARD;

/** Whether the client owns the serialized board (state-based games). */
const isStateGame = (type: GameType): boolean => type === 'dab' || type === 'mem';

/** The stored session in the same shape GET /us/game/active returns, so a
 *  `us:game:busy` reply can be opened by the client exactly like a resume. */
const sessionSnapshotOf = (st: {
  gameSessionId: string | null;
  gameSessionStatus: string | null;
  gameChallengerId: string | null;
  gameBoard: string | null;
  gameTurn: string | null;
}) => {
  const liveType = gameTypeOf(st.gameSessionId || '');
  return {
    gameId: st.gameSessionId,
    gameType: liveType,
    status: st.gameSessionStatus,
    challengerId: st.gameChallengerId,
    board:
      liveType === 'ttt'
        ? (st.gameBoard || '_________')
            .split('')
            .map((c) => (c === 'X' ? 'X' : c === 'O' ? 'O' : null))
        : null,
    state: liveType === 'ttt' ? null : st.gameBoard || null,
    turn: st.gameTurn || 'X',
  };
};

/** Human-readable game name for notifications. */
const gameNameFor = (type: GameType): string =>
  type === 'dab' ? 'Dots & Boxes' : type === 'mem' ? 'Memory Match' : 'Tic-Tac-Toe';

/**
 * Clear the couple's persisted Tic-Tac-Toe session (challenge withdrawn, quit,
 * or game finished). Leaves the win-streak fields untouched.
 */
async function clearGameSession(coupleId: string, gameId?: string): Promise<void> {
  await prisma.coupleUsState.updateMany({
    where: gameId ? { coupleId, gameSessionId: gameId } : { coupleId },
    data: {
      gameSessionId: null,
      gameSessionStatus: null,
      gameChallengerId: null,
      gameBoard: null,
      gameTurn: null,
      gameSessionAt: null,
    },
  });
}

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
    | 'us_mood'
    | 'us_game_challenge'
    | 'us_game_result';
  title: string;
  message: string;
  extraData?: Record<string, unknown>;
}): Promise<string | null> {
  try {
    const { coupleId, senderUserId, subtype, title, message, extraData } = params;
    const row = await prisma.notification.create({
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
    // The id lets a push deep-link straight to THIS row (e.g. a date request
    // opening its own detail sheet on the Notifications screen).
    return row.id;
  } catch (err: any) {
    logger.warn(`[UsSocket] saveUsNotification failed: ${err.message}`);
    return null;
  }
}

/** Returns just the first word of a name (e.g. "Kiran Bhangay" → "Kiran"). */
function firstName(name: string): string {
  return (name || '').split(/\s+/)[0] || name;
}

/**
 * Gendered pronouns for notification copy. Product convention: the PRIMARY
 * account is the boyfriend/husband (male → he) and the PARTNER account is the
 * girlfriend/wife (female → she). Falls back to male if role is unknown.
 */
type Pronouns = { subj: string; Subj: string; obj: string; poss: string; be: string; Be: string };
function pronounsFor(role?: string): Pronouns {
  const female = role === 'partner';
  return female
    ? { subj: 'she', Subj: 'She', obj: 'her', poss: 'her', be: "she's", Be: "She's" }
    : { subj: 'he', Subj: 'He', obj: 'him', poss: 'his', be: "he's", Be: "He's" };
}

/** Look up the partner's User.id AND the sender's profile photo. */
async function findPartnerIdAndPhoto(
  senderUserId: string,
  coupleId: string,
): Promise<{ partnerId: string | null; senderPhoto: string | null }> {
  try {
    const couple = await prisma.couple.findUnique({
      where: { coupleId },
      select: {
        partner1Id: true,
        partner2Id: true,
        primaryPhoto: true,
        secondaryPhotos: true,
      },
    });
    if (!couple) return { partnerId: null, senderPhoto: null };

    const partnerId =
      couple.partner1Id === senderUserId ? couple.partner2Id :
      couple.partner2Id === senderUserId ? couple.partner1Id : null;

    // Use the couple's primary photo as the sender's avatar in push notifications.
    const senderPhoto: string | null =
      (couple.primaryPhoto as string | null) ??
      ((couple.secondaryPhotos as string[] | null)?.[0] ?? null);

    return { partnerId, senderPhoto };
  } catch (err: any) {
    logger.warn(`[UsSocket] findPartnerIdAndPhoto failed: ${err.message}`);
    return { partnerId: null, senderPhoto: null };
  }
}

/**
 * Is this user holding a live socket in their couple room right now?
 * Cluster-correct: fetchSockets() goes through the Redis adapter and sees
 * every PM2 worker; RemoteSocket exposes only `data`, hence the handshake
 * mirror in sockets/index.ts. Fails OPEN (reports offline) — for someone
 * actively waiting on a game, a redundant buzz beats silence.
 */
async function isUserOnline(
  io: SocketIOServer,
  coupleId: string,
  targetUserId: string,
): Promise<boolean> {
  try {
    const sockets = await io.in(`couple:${coupleId}`).fetchSockets();
    return sockets.some((s) => s.data?.userId === targetUserId);
  } catch (err: any) {
    logger.warn(`[UsSocket] presence check failed (assuming offline): ${err.message}`);
    return false;
  }
}

export const registerUsHandlers = (io: SocketIOServer, socket: Socket): void => {
  const { userId, coupleId, userName, userRole } = socket;
  // Pronouns for the SENDER (the socket user) — used in all "from partner" copy.
  const p = pronounsFor(userRole);
  // Gender token for the SENDER (notifications describe the sender's action):
  // primary = male ('m'), partner = female ('f'). Used to localize gendered copy.
  const g: 'm' | 'f' = userRole === 'partner' ? 'f' : 'm';

  // ── us:nudge ──────────────────────────────────────────────────────────
  socket.on(
    'us:nudge',
    async (payload: { kind: string; message: string; at: string; id?: string; date?: string; rawDate?: string; activity?: string; time?: string; note?: string; planBy?: string }) => {
      if (!userId || !coupleId) return;

      logger.info(`[UsSocket] nudge(${payload.kind}) from ${userId} (${userName}) in couple ${coupleId}`);

      const senderName = firstName(userName || 'Your partner');

      // 1. Real-time relay — partner's socket only (exclude sender).
      io.to(`couple:${coupleId}`).except(socket.id).emit('us:nudge', {
        kind: payload.kind,
        message: payload.message,
        at: payload.at,
        from: senderName,
        senderUserId: userId,
        // Unique id survives the relay so both partners converge on the same entry
        // (enables multiple plans per day + independent delete).
        id: payload.id,
        // Name of whoever originally PLANNED the date — survives the relay so the
        // partner's calendar always shows "Planned by <real name>", not "Partner".
        planBy: payload.planBy,
        date: payload.date,
        rawDate: payload.rawDate,
        activity: payload.activity,
        time: payload.time,
        note: payload.note,
      });

      // 2. Save in-app notification & set push title based on kind.
      const { partnerId, senderPhoto } = await findPartnerIdAndPhoto(userId, coupleId);
      let pushTitle = `${senderName} sent you a nudge 💛`;
      // i18n key/params used for BOTH the in-app row (client re-renders) and push.
      let i18nKey = 'us.nudge.generic';
      let i18nParams: NotifParams = { name: senderName };
      // Set by branches whose PUSH should deep-link to its own row (a date
      // request opens its detail sheet on the Notifications screen by id).
      let savedNotifId: string | null = null;

      if (payload.kind === 'hug') {
        i18nKey = 'us.nudge.hug'; i18nParams = { name: senderName };
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_hug',
          title: `${senderName} sent you a hug`,
          message: 'Warm hug heading your way',
          extraData: i18nData(i18nKey, i18nParams),
        });
        pushTitle = `${senderName} sent you a hug 🤗`;

      } else if (payload.kind === 'kiss') {
        i18nKey = 'us.nudge.kiss'; i18nParams = { name: senderName };
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_kiss',
          title: `${senderName} sent you a kiss`,
          message: 'A sweet kiss from your partner',
          extraData: i18nData(i18nKey, i18nParams),
        });
        pushTitle = `${senderName} sent you a kiss 💋`;

      } else if (payload.kind === 'date_request') {
        const actLabel = payload.activity ? payload.activity : 'a date';
        const timeLabel = payload.time ? ` at ${payload.time}` : '';
        const dateMsg = payload.date ? `Want to go out on ${payload.date}${timeLabel} ✨` : 'Want to plan something special ✨';
        i18nKey = 'us.date.request'; i18nParams = { name: senderName, actLabel };
        savedNotifId = await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_date_plan',
          title: `Date request · ${actLabel}`,
          message: payload.note ? `${dateMsg.replace(' ✨', '')} — "${payload.note}"` : dateMsg.replace(' ✨', ''),
          extraData: { id: payload.id, date: payload.date, rawDate: payload.rawDate, activity: payload.activity, time: payload.time, note: payload.note, kind: 'date_request', planBy: payload.planBy || senderName, ...i18nData(i18nKey, i18nParams) },
        });
        pushTitle = `${senderName} wants to plan ${actLabel} 📅`;

      } else if (payload.kind === 'date_accept') {
        // The request is answered — retire its row so the couple's OTHER
        // device (or a reinstall) can't accept it again and resurrect a
        // second "Date confirmed!".
        if (payload.id) {
          await clearDateRequestNotification(coupleId, payload.id);
          io.to(`couple:${coupleId}`).emit('notification:new', { type: 'us_date_plan_cleared' });
        }
        i18nKey = 'us.date.accept'; i18nParams = { name: senderName };
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_date_plan',
          title: '🎉 Date confirmed!',
          message: `It's on the calendar 🗓️`,
          extraData: { id: payload.id, date: payload.date, rawDate: payload.rawDate, activity: payload.activity, kind: 'date_accept', ...i18nData(i18nKey, i18nParams) },
        });
        pushTitle = `${senderName} confirmed the date! 🎉`;

      } else if (payload.kind === 'date_reject') {
        i18nKey = 'us.date.reject'; i18nParams = { name: senderName };
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_date_plan',
          // Same warm register as the push — "😔 Date declined" read like a
          // rejected form between two people who live together.
          title: `${senderName} couldn't make it this time`,
          message: 'Maybe another time 🤍',
          // `id` is what lets the requester's device remove the refused plan
          // from the calendar EVEN IF it was offline for the live relay —
          // date_accept and date_edit already carried it; this branch dropped
          // it, leaving a declined date sitting there looking confirmed.
          extraData: { id: payload.id, kind: 'date_reject', ...i18nData(i18nKey, i18nParams) },
        });
        pushTitle = `${senderName} couldn't make it this time`;

      } else if (payload.kind === 'date_edit') {
        // Keep the ORIGINAL request row in sync — accept reads ITS data, so an
        // edit that only wrote a new row let a later accept resurrect the
        // pre-edit date/time on both calendars.
        if (payload.id) {
          await updateDateRequestNotificationData(coupleId, payload.id, {
            date: payload.date,
            rawDate: payload.rawDate,
            activity: payload.activity,
            time: payload.time,
            note: payload.note,
          });
        }
        const actLabel = payload.activity ? payload.activity : 'the plan';
        const timeLabel = payload.time ? ` at ${payload.time}` : '';
        i18nKey = 'us.date.edit'; i18nParams = { name: senderName, actLabel };
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_date_plan',
          title: `${senderName} updated ${actLabel}`,
          message: payload.date ? `Now on ${payload.date}${timeLabel}` : 'Tap to see the update',
          extraData: { id: payload.id, date: payload.date, rawDate: payload.rawDate, activity: payload.activity, time: payload.time, note: payload.note, kind: 'date_edit', planBy: payload.planBy || senderName, ...i18nData(i18nKey, i18nParams) },
        });
        pushTitle = `${senderName} updated ${actLabel} ✏️`;

      } else if (payload.kind === 'date_delete') {
        // Deletion is housekeeping, not a moment: no new notification row and
        // no push — but the ORIGINAL request row must die with the plan, or the
        // partner's Accept button outlives the cancellation and accepting it
        // resurrects the deleted date on both calendars.
        if (payload.id) {
          await clearDateRequestNotification(coupleId, payload.id);
          io.to(`couple:${coupleId}`).emit('notification:new', { type: 'us_date_plan_cleared' });
        }
        return;

      } else if (payload.kind === 'date_plan') {
        // Legacy fallback
        i18nKey = 'us.nudge.generic'; i18nParams = { name: senderName };
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_date_plan',
          title: `${senderName} planned a date`,
          message: payload.message || 'A date has been planned for you two!',
          extraData: { date: payload.date, rawDate: payload.rawDate, activity: payload.activity, ...i18nData(i18nKey, i18nParams) },
        });

      } else if (payload.kind === 'thinking') {
        i18nKey = 'us.nudge.thinking'; i18nParams = { name: senderName, g };
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_thinking',
          title: `${senderName} is thinking of you`,
          message: `You crossed ${p.poss} mind right now`,
          extraData: i18nData(i18nKey, i18nParams),
        });
        pushTitle = `${senderName} is thinking of you`;

      } else if (payload.kind === 'missyou') {
        i18nKey = 'us.nudge.missyou'; i18nParams = { name: senderName, g };
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_missyou',
          title: `${senderName} misses you`,
          message: `${p.Subj} wishes you were here`,
          extraData: i18nData(i18nKey, i18nParams),
        });
        pushTitle = `${senderName} misses you`;

      } else if (payload.kind === 'cheerup') {
        i18nKey = 'us.nudge.cheerup'; i18nParams = { name: senderName };
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_cheerup',
          title: `${senderName} is cheering you up`,
          message: 'A little boost from your partner',
          extraData: i18nData(i18nKey, i18nParams),
        });
        pushTitle = `${senderName} is cheering you up`;

      } else if (payload.kind === 'here') {
        i18nKey = 'us.nudge.here'; i18nParams = { name: senderName, g };
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_here',
          title: `${senderName} is here for you`,
          message: `You have ${p.poss} full support`,
          extraData: i18nData(i18nKey, i18nParams),
        });
        pushTitle = `${senderName} is here for you`;

      } else if (payload.kind === 'appreciate') {
        i18nKey = 'us.nudge.appreciate'; i18nParams = { name: senderName, g };
        await saveUsNotification({
          coupleId,
          senderUserId: userId,
          subtype: 'us_appreciate',
          title: `${senderName} appreciates you`,
          message: `${p.Subj} is grateful to have you`,
          extraData: i18nData(i18nKey, i18nParams),
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
            subtype: NUDGE_SUBTYPE_BY_KIND[payload.kind] || 'us_nudge',
            kind: payload.kind,
            navigate: 'Notifications',
            ...(savedNotifId ? { notificationId: savedNotifId } : {}),
            ...(senderPhoto ? { senderPhoto } : {}),  // couple profile photo for largeIcon
            ...i18nData(i18nKey, i18nParams),
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
      senderUserId: userId,
    });

    // Save in-app notification (partner sees it; sender is filtered client-side).
    await saveUsNotification({
      coupleId,
      senderUserId: userId,
      subtype: 'us_love',
      title: `${senderName} sent you love ❤️`,
      message: 'Thinking of you 💛',
      extraData: i18nData('us.nudge.love', { name: senderName }),
    });

    // Tell the partner's Notifications screen to refresh right away.
    io.to(`couple:${coupleId}`).except(socket.id).emit('notification:new', {
      type: 'us_love',
    });

    const { partnerId: lovePartnerId, senderPhoto: loveSenderPhoto } = await findPartnerIdAndPhoto(userId, coupleId);
    if (lovePartnerId) {
      pushToUser(lovePartnerId, {
        title: `${senderName} sent you love ❤️`,
        body: 'Tap to see it',
        data: { type: 'us_love', subtype: 'us_love', navigate: 'Notifications', ...(loveSenderPhoto ? { senderPhoto: loveSenderPhoto } : {}), ...i18nData('us.nudge.love', { name: senderName }) },
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
        // Lets the sender's OTHER devices ignore the echo — .except(socket.id)
        // only excludes the emitting socket, not the same user's second device,
        // which used to render your own mood as your partner's.
        senderUserId: userId,
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
        title: `${senderFirstName} updated ${p.poss} mood`,
        message: payload.note?.trim()
          ? `Feeling ${feelingLabel} — "${payload.note.trim()}"`
          : `${p.Be} feeling ${feelingLabel} right now`,
        extraData: { feeling: payload.feeling, ...i18nData('us.mood', { name: senderFirstName, feeling: feelingLabel, g }) },
      });

      // Tell the partner's Notifications screen to refresh right away.
      io.to(`couple:${coupleId}`).except(socket.id).emit('notification:new', {
        type: 'us_mood',
        feeling: payload.feeling,
      });

      const { partnerId: feelPartnerId, senderPhoto: feelSenderPhoto } = await findPartnerIdAndPhoto(userId, coupleId);
      if (feelPartnerId) {
        pushToUser(feelPartnerId, {
          title: `${senderFirstName} shared how ${p.subj} feels`,
          body: payload.note?.trim()
            ? `"${payload.note.trim()}"`
            : `${p.Be} feeling ${feelingLabel} right now`,
          data: {
            type: 'us_feeling',
            // The row's subtype is us_mood while this push always said
            // us_feeling — third name for the same event. subtype unifies it.
            subtype: 'us_mood',
            feeling: payload.feeling,
            navigate: 'UsSpace',
            ...(feelSenderPhoto ? { senderPhoto: feelSenderPhoto } : {}),
            ...i18nData('us.mood', { name: senderFirstName, feeling: feelingLabel, g }),
          },
          collapseKey: 'us_feeling',
        }).catch(() => null);
      }
    },
  );

  // ── us:chat:send — the partner thread ("Just us two") ─────────────────────
  // Intra-couple messages, stored as Message rows with chatType='partner' and
  // senderId = the couple's own coupleId (no match, no community — the couple
  // IS the room). Room-wide emit doubles as the sender's delivery ack.
  // Idempotent per clientMessageId (reconnect replays re-emit the saved id).
  socket.on(SOCKET_EVENTS.US_CHAT_SEND, async (payload: { clientMessageId?: string; text?: string }) => {
    if (!userId || !coupleId) return;
    const text = (payload?.text ?? '').trim();
    if (!text || text.length > 1000) return;
    const clientMessageId =
      typeof payload?.clientMessageId === 'string' && payload.clientMessageId
        ? payload.clientMessageId.slice(0, 64)
        : null;

    const dedupeKey = clientMessageId ? `us:pchat:${coupleId}:${clientMessageId}` : null;
    if (dedupeKey) {
      const claimed = await cacheSetNX(dedupeKey, 'pending', 24 * 60 * 60).catch(() => true);
      if (!claimed) {
        const existingId = await cacheGet(dedupeKey).catch(() => null);
        if (existingId && existingId !== 'pending') {
          socket.emit(SOCKET_EVENTS.US_CHAT_MESSAGE, {
            id: existingId,
            clientMessageId,
            coupleId,
            senderUserId: userId,
            senderName: firstName(userName || ''),
            text,
            createdAt: new Date().toISOString(),
          });
        }
        return;
      }
    }

    let saved: { id: string; createdAt: Date } | null = null;
    try {
      saved = await prisma.message.create({
        data: {
          chatType: 'partner',
          senderId: coupleId,
          senderUserId: userId,
          senderName: firstName(userName || ''),
          content: text,
          contentType: 'text',
        },
        select: { id: true, createdAt: true },
      });
    } catch (err: any) {
      logger.warn(`[UsSocket] partner chat persist failed: ${err.message}`);
      if (dedupeKey) await cacheSet(dedupeKey, '', 1).catch(() => {});
      socket.emit(SOCKET_EVENTS.US_CHAT_FAILED, { clientMessageId });
      return;
    }
    if (dedupeKey) await cacheSet(dedupeKey, saved.id, 24 * 60 * 60).catch(() => {});

    io.to(`couple:${coupleId}`).emit(SOCKET_EVENTS.US_CHAT_MESSAGE, {
      id: saved.id,
      clientMessageId,
      coupleId,
      senderUserId: userId,
      senderName: firstName(userName || ''),
      text,
      createdAt: saved.createdAt.toISOString(),
    });

    // Offline partner: one collapsing push per thread — the newest message
    // replaces the last (never a pile), gated on real presence.
    try {
      const { partnerId } = await findPartnerIdAndPhoto(userId, coupleId);
      if (partnerId) {
        const online = await isUserOnline(io, coupleId, partnerId);
        if (!online) {
          const senderName = firstName(userName || 'Your partner');
          pushToUser(partnerId, {
            title: senderName,
            body: text.length > 120 ? `${text.slice(0, 117)}…` : text,
            data: {
              type: 'us_partner_message',
              subtype: 'us_partner_message',
              navigate: 'PartnerChat',
              ...i18nData('us.chat.message', { name: senderName }),
            },
            collapseKey: 'us_partner_chat',
          }).catch(() => null);
        }
      }
    } catch {}
  });

  // ── us:presence:sync — on-demand partner presence snapshot ───────────────
  // The connection-time broadcast only fires on TRANSITIONS, so the partner who
  // connects (or refocuses the Us tab) second was never told the first is
  // online — the presence glow was effectively unreachable. The client emits
  // this on Us-tab focus; the reply reuses US_PARTNER_PRESENCE, which the
  // client already consumes (and ignores for its own userId).
  // fetchSockets() goes through the Redis adapter, so it sees every PM2
  // worker; RemoteSocket exposes only `data`, hence the handshake mirror.
  socket.on('us:presence:sync', async () => {
    if (!userId || !coupleId) return;
    try {
      const sockets = await io.in(`couple:${coupleId}`).fetchSockets();
      const partnerSocket = sockets.find(
        (s) => s.data?.userId && s.data.userId !== userId,
      );
      if (partnerSocket) {
        socket.emit(SOCKET_EVENTS.US_PARTNER_PRESENCE, {
          userId: partnerSocket.data.userId,
          online: true,
        });
      }
    } catch (err: any) {
      logger.warn(`[UsSocket] presence sync failed: ${err.message}`);
    }
  });

  // ═══ Tic-Tac-Toe — real-time couple game ═════════════════════════════════
  // The server is a thin, fast relay: moves are forwarded to the partner's
  // socket immediately. It also owns the persistent scoreboard in Redis and
  // the challenge notification (in-app + push) so an offline partner can join
  // from their notification tray.

  // ── us:game:challenge — invite the partner to a match ──────────────────
  socket.on(SOCKET_EVENTS.US_GAME_CHALLENGE, async (payload: { gameId: string; gameType?: GameType; state?: string }) => {
    if (!userId || !coupleId || !payload?.gameId) return;
    const senderName = firstName(userName || 'Your partner');
    const gameType: GameType = payload.gameType || gameTypeOf(payload.gameId);
    const gameName = gameNameFor(gameType);
    // For state-based games (Dots & Boxes, Memory Match) the challenger supplies
    // the initial board so both devices share it (memory shuffle must match).
    const emptyBoard =
      isStateGame(gameType) && typeof payload.state === 'string' && payload.state.includes('|')
        ? payload.state
        : emptyBoardFor(gameType);
    logger.info(`[UsSocket] game challenge ${payload.gameId} (${gameType}) from ${userId} in couple ${coupleId}`);

    // 0a. Single-session lock. The couple has exactly ONE shared game session;
    //     letting a second challenge overwrite a live one is how the "both
    //     players are X" corruption happened: two crossed challenges forked
    //     the phones into parallel sessions, each partner the challenger of
    //     their own. A challenge that collides with a live round is refused
    //     and the sender gets the live session back (`us:game:busy`) so their
    //     client can join it instead — the crossing becomes an accept.
    //     Re-issuing MY OWN pending invite (or retrying the same gameId after
    //     a reconnect) stays allowed; a DB error fails open like before.
    try {
      const existing = await prisma.coupleUsState.findUnique({ where: { coupleId } });
      const ageMs = existing?.gameSessionAt
        ? Date.now() - new Date(existing.gameSessionAt).getTime()
        : Number.MAX_SAFE_INTEGER;
      const live =
        !!existing?.gameSessionId &&
        !!existing.gameSessionStatus &&
        ageMs < 3 * 60 * 60 * 1000;
      const sameGame = live && existing!.gameSessionId === payload.gameId;
      const myPendingReinvite =
        live &&
        existing!.gameSessionStatus === 'pending' &&
        existing!.gameChallengerId === userId;
      if (live && !sameGame && !myPendingReinvite) {
        socket.emit('us:game:busy', { session: sessionSnapshotOf(existing!) });
        return;
      }
    } catch (err: any) {
      logger.warn(`[UsSocket] session lock check failed (open): ${err.message}`);
    }

    // 0b. Persist a shared PENDING session so both partners can (re)join the same
    //    challenge even after leaving the screen — this is what prevents the
    //    "stale challenge" where the requester left and the partner got stuck.
    try {
      await prisma.coupleUsState.upsert({
        where: { coupleId },
        create: {
          coupleId,
          gameSessionId: payload.gameId,
          gameSessionStatus: 'pending',
          gameChallengerId: userId,
          gameBoard: emptyBoard,
          gameTurn: 'X',
          gameSessionAt: new Date(),
        },
        update: {
          gameSessionId: payload.gameId,
          gameSessionStatus: 'pending',
          gameChallengerId: userId,
          gameBoard: emptyBoard,
          gameTurn: 'X',
          gameSessionAt: new Date(),
        },
      });
    } catch (err: any) {
      logger.warn(`[UsSocket] persist challenge failed: ${err.message}`);
    }

    // 1. Instant relay so an online partner sees the invite immediately. The
    //    board `state` is included so state-based games render the shared layout.
    io.to(`couple:${coupleId}`).except(socket.id).emit(SOCKET_EVENTS.US_GAME_CHALLENGE, {
      gameId: payload.gameId,
      gameType,
      state: isStateGame(gameType) ? emptyBoard : undefined,
      from: senderName,
      fromUserId: userId,
      at: new Date().toISOString(),
    });

    // 2. In-app notification — tapping it deep-links into the game.
    await saveUsNotification({
      coupleId,
      senderUserId: userId,
      subtype: 'us_game_challenge',
      title: `${senderName} challenged you to ${gameName} 🎮`,
      message: 'Tap to accept and play!',
      extraData: { gameId: payload.gameId, gameType, ...i18nData('us.game.challenge', { name: senderName, game: gameName }) },
    });
    io.to(`couple:${coupleId}`).except(socket.id).emit('notification:new', { type: 'us_game_challenge' });

    // 3. Push — only to the partner's device.
    const { partnerId, senderPhoto } = await findPartnerIdAndPhoto(userId, coupleId);
    if (partnerId) {
      pushToUser(partnerId, {
        title: `${senderName} challenged you 🎮`,
        body: `${gameName}! Tap to accept and play`,
        data: {
          type: 'us_game_challenge',
          subtype: 'us_game_challenge',
          gameId: payload.gameId,
          gameType,
          // The whole point of this push is the game — land the tap on the Us
          // space so the accept sheet opens, not on the notification list.
          navigate: 'UsSpace',
          ...(senderPhoto ? { senderPhoto } : {}),
          ...i18nData('us.game.challenge', { name: senderName, game: gameName }),
        },
        collapseKey: 'us_game',
      }).catch(() => null);
    }
  });

  // ── us:game:accept — partner accepts; the whole room gets the start signal
  socket.on('us:game:accept', async (payload: { gameId: string }) => {
    if (!userId || !coupleId || !payload?.gameId) return;
    const gameType = gameTypeOf(payload.gameId);
    // Flip the shared session to ACTIVE so a rejoining partner resumes the match.
    let board: string | null = null;
    // Fail open on a DB error (start still emitted, as before); only a POSITIVE
    // zero-row match suppresses the start.
    let sessionLive = true;
    let challengerIdForStart: string | null = null;
    try {
      const updated = await prisma.coupleUsState.updateMany({
        where: { coupleId, gameSessionId: payload.gameId },
        data: { gameSessionStatus: 'active', gameSessionAt: new Date() },
      });
      if (updated.count === 0) sessionLive = false;
      const st = await prisma.coupleUsState.findUnique({ where: { coupleId } });
      if (st?.gameSessionId === payload.gameId) {
        board = st.gameBoard || null;
        challengerIdForStart = st.gameChallengerId || null;
      }
    } catch (err: any) {
      logger.warn(`[UsSocket] persist accept failed: ${err.message}`);
    }
    // The challenge is answered — retire its "Tap to accept and play!" row so
    // a stale invite can't outlive the session and dead-end a later tap.
    await clearGameChallengeNotification(coupleId, payload.gameId);
    io.to(`couple:${coupleId}`).emit('notification:new', { type: 'us_game_challenge_cleared' });
    if (!sessionLive) {
      // Accepting a dead session (quit/expired/superseded) used to emit
      // us:game:start anyway — both clients then believed a game was live
      // while the server row was empty and every move silently no-oped.
      // If a NEWER round is live, hand it back (`us:game:busy`) so a client
      // holding a stale invite popup joins the real round instead of hanging;
      // clients without the handler simply ignore the event.
      try {
        const cur = await prisma.coupleUsState.findUnique({ where: { coupleId } });
        if (cur?.gameSessionId && cur.gameSessionStatus) {
          socket.emit('us:game:busy', { session: sessionSnapshotOf(cur) });
        }
      } catch {}
      return;
    }
    io.to(`couple:${coupleId}`).emit(SOCKET_EVENTS.US_GAME_START, {
      gameId: payload.gameId,
      gameType,
      // Share the stored board so state-based games start from the same layout.
      state: isStateGame(gameType) ? board ?? undefined : undefined,
      accepterUserId: userId,
      // Authoritative role assignment. Clients that key X/O off "did *I* send
      // the accept" desync whenever starts race or arrive out of order across
      // workers — the stored challenger is the one fact both phones agree on.
      challengerId: challengerIdForStart,
      accepterName: firstName(userName || ''),
      at: new Date().toISOString(),
    });

    // The challenger asked and then waited. us:game:start only reaches a live
    // socket — lock the phone and they never learn the game began, which is
    // how an accepted challenge died for long-distance couples. Push ONLY when
    // they're genuinely offline so someone staring at the board isn't buzzed.
    try {
      const st2 = await prisma.coupleUsState.findUnique({ where: { coupleId } });
      const challengerId = st2?.gameChallengerId || null;
      if (challengerId && challengerId !== userId) {
        const online = await isUserOnline(io, coupleId, challengerId);
        if (!online) {
          const accepterName = firstName(userName || 'Your partner');
          const gameName = gameNameFor(gameType);
          pushToUser(challengerId, {
            title: `${accepterName} accepted 🎮`,
            body: `Your ${gameName} game is on. Tap to play`,
            data: {
              type: 'us_game_challenge',
              subtype: 'us_game_challenge',
              gameId: payload.gameId,
              gameType,
              navigate: 'UsSpace',
              ...i18nData('us.game.accepted', { name: accepterName, game: gameName }),
            },
            collapseKey: 'us_game',
          }).catch(() => null);
        }
      }
    } catch {}
  });

  // ── us:game:move — relay a board move to the partner (fast path) ───────
  // Tic-Tac-Toe sends { cell, symbol }; Dots & Boxes sends { edge, symbol,
  // state, turn } where `state` is the full serialized board (client-authoritative,
  // mirroring how TTT win detection lives on the client). The server relays the
  // move verbatim and persists the resulting board for resume.
  socket.on(
    SOCKET_EVENTS.US_GAME_MOVE,
    async (payload: {
      gameId: string;
      cell?: number;
      symbol: string;
      edge?: { o: 'h' | 'v'; r: number; c: number };
      state?: string;
      turn?: string;
    }) => {
      if (!userId || !coupleId || !payload?.gameId) return;
      const gameType = gameTypeOf(payload.gameId);

      // Relay first (fast path), then persist the board so both can resume.
      io.to(`couple:${coupleId}`).except(socket.id).emit(SOCKET_EVENTS.US_GAME_MOVE, {
        gameId: payload.gameId,
        gameType,
        cell: payload.cell,
        symbol: payload.symbol,
        edge: payload.edge,
        state: payload.state,
        turn: payload.turn,
        byUserId: userId,
      });

      // Long-distance turn: the relay above only reaches a live socket. When
      // the partner is backgrounded, nudge their phone — capped to one buzz
      // per game per 45s so a fast exchange never floods, and skipped entirely
      // while they're actually looking at the board.
      (async () => {
        try {
          const { partnerId } = await findPartnerIdAndPhoto(userId, coupleId);
          if (!partnerId) return;
          if (await isUserOnline(io, coupleId, partnerId)) return;
          const throttleKey = `us:gameturn:${payload.gameId}:${partnerId}`;
          const fresh = await cacheSetNX(throttleKey, '1', 45).catch(() => false);
          if (!fresh) return;
          const moverName = firstName(userName || 'Your partner');
          const gameName = gameNameFor(gameType);
          pushToUser(partnerId, {
            title: `Your move 🎮`,
            body: `${moverName} played — your turn at ${gameName}`,
            data: {
              type: 'us_game_challenge',
              subtype: 'us_game_challenge',
              gameId: payload.gameId,
              gameType,
              navigate: 'UsSpace',
              ...i18nData('us.game.turn', { name: moverName, game: gameName }),
            },
            collapseKey: 'us_game',
          }).catch(() => null);
        } catch {}
      })();

      try {
        const st = await prisma.coupleUsState.findUnique({ where: { coupleId } });
        if (st?.gameSessionId !== payload.gameId) return;

        if (isStateGame(gameType)) {
          // Client is authoritative for Dots & Boxes / Memory Match — persist the
          // serialized state verbatim so both partners can resume.
          if (typeof payload.state === 'string' && payload.state.includes('|')) {
            await prisma.coupleUsState.update({
              where: { coupleId },
              data: {
                gameBoard: payload.state,
                gameTurn: payload.turn === 'O' ? 'O' : 'X',
                gameSessionAt: new Date(),
              },
            });
          }
        } else if (
          typeof payload.cell === 'number' &&
          payload.cell >= 0 &&
          payload.cell < 9
        ) {
          const arr = (st.gameBoard || TTT_EMPTY_BOARD).split('');
          arr[payload.cell] = payload.symbol === 'O' ? 'O' : 'X';
          await prisma.coupleUsState.update({
            where: { coupleId },
            data: {
              gameBoard: arr.join(''),
              gameTurn: payload.symbol === 'X' ? 'O' : 'X',
              gameSessionAt: new Date(),
            },
          });
        }
      } catch (err: any) {
        logger.warn(`[UsSocket] persist move failed: ${err.message}`);
      }
    },
  );

  // ── us:game:leave — SOFT exit: board closed, session kept ──────────────
  // Blur/background during a live game lands here (the client used to send
  // quit, which nulled the shared session the moment the FIRST partner
  // backgrounded — the "we can't resume our game" bug). Stamp activity so the
  // idle expiry counts from the walk-away, and tell the partner quietly.
  socket.on(SOCKET_EVENTS.US_GAME_LEAVE, async (payload: { gameId: string }) => {
    if (!userId || !coupleId || !payload?.gameId) return;
    io.to(`couple:${coupleId}`).except(socket.id).emit(SOCKET_EVENTS.US_GAME_PARTNER_LEFT, {
      gameId: payload.gameId,
      byUserId: userId,
      byName: firstName(userName || ''),
    });
    try {
      await prisma.coupleUsState.updateMany({
        where: { coupleId, gameSessionId: payload.gameId },
        data: { gameSessionAt: new Date() },
      });
    } catch (err: any) {
      logger.warn(`[UsSocket] stamp leave failed: ${err.message}`);
    }
  });

  // ── us:game:quit — HARD exit: one player abandons; the session dies ────
  socket.on(SOCKET_EVENTS.US_GAME_QUIT, async (payload: { gameId: string }) => {
    if (!userId || !coupleId || !payload?.gameId) return;
    io.to(`couple:${coupleId}`).except(socket.id).emit(SOCKET_EVENTS.US_GAME_QUIT, {
      gameId: payload.gameId,
      byUserId: userId,
      byName: firstName(userName || ''),
    });
    try {
      await clearGameSession(coupleId, payload.gameId);
    } catch (err: any) {
      logger.warn(`[UsSocket] clear session on quit failed: ${err.message}`);
    }
    // A quit round's invite is dead too — clear it and nudge open lists to refresh.
    await clearGameChallengeNotification(coupleId, payload.gameId);
    io.to(`couple:${coupleId}`).emit('notification:new', { type: 'us_game_challenge_cleared' });
  });

  // ── us:game:result — winner's client reports; server scores it once ────
  socket.on(SOCKET_EVENTS.US_GAME_RESULT, async (payload: { gameId: string; winnerUserId?: string; draw?: boolean }) => {
    if (!userId || !coupleId || !payload?.gameId) return;
    try {
      // The round is over — always clear the shared session (win, loss, or draw)
      // so the button returns to "Challenge" for both partners.
      await clearGameSession(coupleId, payload.gameId).catch(() => null);

      // Idempotency guard: score each gameId exactly once even if both
      // clients happen to report the same result.
      const scoredKey = `us:game_scored:${coupleId}:${payload.gameId}`;
      const already = await cacheGet(scoredKey);
      if (already) return;
      await cacheSet(scoredKey, '1', 24 * 60 * 60);

      // The winner's live streak after this game (0 on a draw) — used below so
      // the result notification can celebrate a streak that is still alive.
      let streakCount = 0;

      if (!payload.draw && payload.winnerUserId) {
        const winnerId = payload.winnerUserId;

        // Durable win increment (source of truth: Postgres).
        await prisma.usGameScore.upsert({
          where: { coupleId_userId: { coupleId, userId: winnerId } },
          create: { coupleId, userId: winnerId, wins: 1 },
          update: { wins: { increment: 1 } },
        });

        // Win streak — consecutive wins by the same partner. A win by the
        // other partner resets the streak to 1 for them.
        const state = await prisma.coupleUsState.findUnique({ where: { coupleId } });
        const nextCount =
          state?.gameStreakUserId === winnerId ? (state.gameStreakCount ?? 0) + 1 : 1;
        await prisma.coupleUsState.upsert({
          where: { coupleId },
          create: { coupleId, gameStreakUserId: winnerId, gameStreakCount: nextCount },
          update: { gameStreakUserId: winnerId, gameStreakCount: nextCount },
        });
        streakCount = nextCount;

        // Read back the full scoreboard and broadcast to BOTH partners.
        const scores = await prisma.usGameScore.findMany({ where: { coupleId } });
        const pts: Record<string, number> = {};
        for (const s of scores) pts[s.userId] = s.wins;
        const streak = { userId: winnerId, count: nextCount };

        io.to(`couple:${coupleId}`).emit(SOCKET_EVENTS.US_GAME_POINTS, { points: pts, streak });
      }

      // ── Close the loop: tell the partner who did NOT report the result ────
      // The reporter's client just rendered the ending locally; an offline
      // partner otherwise never learns the game ended. Same Notification-row +
      // notification:new + localized-push pattern as us:feeling / us:nudge
      // above (idempotent: we are inside the scored-once guard). Copy is
      // written from the RECIPIENT's perspective, "Rematch?" tone.
      const gameType = gameTypeOf(payload.gameId);
      const gameName = gameNameFor(gameType);
      const senderName = firstName(userName || 'Your partner');
      const { partnerId, senderPhoto } = await findPartnerIdAndPhoto(userId, coupleId);

      const recipientWon =
        !payload.draw && !!payload.winnerUserId && payload.winnerUserId === partnerId;
      // A single win is not a streak yet — mention it from 2 consecutive wins.
      const showStreak = !payload.draw && streakCount >= 2;
      const resultKey = payload.draw
        ? 'us.game.draw'
        : recipientWon
        ? (showStreak ? 'us.game.winStreak' : 'us.game.win')
        : (showStreak ? 'us.game.lossStreak' : 'us.game.loss');
      const resultParams: NotifParams = {
        name: senderName,
        game: gameName,
        ...(showStreak ? { count: String(streakCount) } : {}),
      };
      const { title: resultTitle, body: resultBody } = renderNotif('en', resultKey, resultParams);

      await saveUsNotification({
        coupleId,
        senderUserId: userId,
        subtype: 'us_game_result',
        title: resultTitle,
        message: resultBody,
        extraData: {
          gameId: payload.gameId,
          gameType,
          draw: !!payload.draw,
          ...(payload.winnerUserId ? { winnerUserId: payload.winnerUserId } : {}),
          ...(showStreak ? { streakCount } : {}),
          ...i18nData(resultKey, resultParams),
        },
      });
      io.to(`couple:${coupleId}`).except(socket.id).emit('notification:new', { type: 'us_game_result' });

      if (partnerId) {
        pushToUser(partnerId, {
          title: resultTitle,
          body: resultBody,
          data: {
            type: 'us_game_result',
            subtype: 'us_game_result',
            gameId: payload.gameId,
            gameType,
            navigate: 'UsSpace',
            ...(senderPhoto ? { senderPhoto } : {}),
            ...i18nData(resultKey, resultParams),
          },
          collapseKey: 'us_game',
        }).catch(() => null);
      }
    } catch (err: any) {
      logger.warn(`[UsSocket] game result failed: ${err.message}`);
    }
  });
};
