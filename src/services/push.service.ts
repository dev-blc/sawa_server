import admin from 'firebase-admin';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { renderNotif, hasNotifKey, NotifParams } from '../i18n/notif';
import { mirrorToWhatsAppCouple, mirrorToWhatsAppUser } from './whatsapp.service';

/**
 * The recipient's real unread count for the iOS APNs badge. Mirrors the
 * unread-count endpoint's filter exactly (uncleared + not self-sent), because
 * a badge that disagrees with the in-app bell reads as a bug. Falls back to 1
 * on any error — a wrong-but-present badge beats a crashed push.
 */
const badgeCountFor = async (coupleId: string | null | undefined, userId: string): Promise<number> => {
  if (!coupleId) return 1;
  try {
    const count = await prisma.notification.count({
      where: {
        recipientId: coupleId,
        read: false,
        clearedAt: null,
        NOT: { data: { path: ['senderUserId'], equals: userId } },
      } as any,
    });
    // The push this badge rides on has usually just landed its row, so 0 here
    // means a raced read — never badge 0 alongside a visible alert.
    return Math.max(1, count);
  } catch {
    return 1;
  }
};

/**
 * Build a per-recipient localized copy of a push payload.
 *
 * When the caller attached `data.i18nKey` (+ optional `data.i18nParams`), we
 * re-render the title/body in the recipient's chosen language. Android renders
 * from the `data` fields (client-side), and iOS shows the APNs `title`/`body`,
 * so we localize BOTH. If no i18nKey is present we fall back to the caller's
 * English strings unchanged.
 */
const localizeFor = (
  payload: PushPayload,
  locale?: string | null,
): { title: string; body: string; data: Record<string, string> } => {
  let title = payload.title;
  let body = payload.body;
  const rawData: Record<string, unknown> = payload.data ?? {};

  const i18nKey = typeof rawData.i18nKey === 'string' ? (rawData.i18nKey as string) : undefined;
  if (i18nKey && hasNotifKey(i18nKey)) {
    let params: NotifParams = {};
    const rp = rawData.i18nParams;
    if (typeof rp === 'string') {
      try { params = JSON.parse(rp) as NotifParams; } catch { /* keep {} */ }
    } else if (rp && typeof rp === 'object') {
      params = rp as NotifParams;
    }
    const rendered = renderNotif(locale, i18nKey, params);
    title = rendered.title || title;
    body = rendered.body || body;
  }

  const stringData: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawData)) {
    if (v === null || v === undefined) continue;
    stringData[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return { title, body, data: { title, body, ...stringData } };
};

/**
 * Push Notification Service
 *
 * Bridges in-app notifications (Socket.IO + DB) to OS-level push via Firebase
 * Cloud Messaging (FCM). FCM handles APNs delivery for iOS automatically once
 * the APNs key is uploaded in the Firebase console.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Setup (one-time, by ops):
 *   1. Create a Firebase project for SAWA.
 *   2. Console → Project settings → Service accounts → Generate new private
 *      key. Save the JSON.
 *   3. Set the env var FIREBASE_SERVICE_ACCOUNT_JSON to the *full JSON string*
 *      (single line, no newlines). On Railway you can paste it directly.
 *   4. For iOS: upload your APNs Authentication Key (.p8) under Project
 *      settings → Cloud Messaging → Apple app configuration. Bundle ID:
 *      com.sawa.application. Team ID + Key ID from your Apple Developer
 *      account.
 *
 * Without FIREBASE_SERVICE_ACCOUNT_JSON set, push delivery silently no-ops
 * (in-app notifications continue to work as before).
 * ──────────────────────────────────────────────────────────────────────────
 */

let initialised = false;
let enabled = false;

const init = (): void => {
  if (initialised) return;
  initialised = true;

  // Accept either the full service-account JSON (preferred) or, as a fallback,
  // the three individual fields. This lets us survive Railway's occasional
  // mangling of large multi-line env vars.
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const projectIdEnv = process.env.FIREBASE_PROJECT_ID;
  const clientEmailEnv = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKeyEnv = process.env.FIREBASE_PRIVATE_KEY;

  if (!raw && !(projectIdEnv && clientEmailEnv && privateKeyEnv)) {
    logger.warn(
      '[Push] FIREBASE_SERVICE_ACCOUNT_JSON not set — push notifications disabled. ' +
        'In-app notifications continue to work normally.',
    );
    return;
  }

  try {
    let serviceAccount: Record<string, any>;

    if (raw) {
      serviceAccount = JSON.parse(raw);
    } else {
      serviceAccount = {
        projectId: projectIdEnv,
        clientEmail: clientEmailEnv,
        privateKey: privateKeyEnv,
      };
    }

    // CRITICAL: Railway (and most env-var UIs) store the private key with the
    // newlines escaped as the two characters "\n". Firebase needs REAL newline
    // characters or credential.cert() throws "Invalid PEM formatted message".
    const pk = serviceAccount.private_key ?? serviceAccount.privateKey;
    if (typeof pk === 'string' && pk.includes('\\n')) {
      const fixed = pk.replace(/\\n/g, '\n');
      if ('private_key' in serviceAccount) serviceAccount.private_key = fixed;
      if ('privateKey' in serviceAccount) serviceAccount.privateKey = fixed;
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
    });
    enabled = true;
    logger.info(
      `[Push] Firebase Admin initialised — push delivery ENABLED (project: ${
        serviceAccount.project_id ?? serviceAccount.projectId ?? 'unknown'
      }).`,
    );
  } catch (err: any) {
    logger.error(
      `[Push] Firebase Admin init FAILED — push disabled. Reason: ${err.message}. ` +
        `Check FIREBASE_SERVICE_ACCOUNT_JSON is valid JSON with a correct private_key.`,
    );
  }
};

init();

export interface PushPayload {
  title: string;
  body: string;
  /** Arbitrary key/value pairs delivered with the push. Will be coerced to strings. */
  data?: Record<string, unknown>;
  /** A canonical "topic" string (e.g. "match", "community") for OS grouping. */
  collapseKey?: string;
}

// ─── Quiet hours (IST) for non-urgent event pushes ────────────────────────────
// The cron jobs already keep their sends inside 08:00–21:00 IST, but
// socket/route-driven pushes (a nudge, a mood, a game finishing at 2am) used to
// buzz phones at any hour. Outside 08:00–22:00 IST the FCM push AND the
// WhatsApp mirror are suppressed for the `data.type` values below. The
// Notification row and the socket emit are written by the CALLER before it
// pushes, so every in-app surface stays live — only the phone buzz respects
// the night.
//
// Gated (non-urgent, partner-ambient): nudges (`us_nudge` also carries date
// request/accept/reject kinds), love taps, mood shares, "how are you feeling"
// asks, fridge notes + acks, game challenges and game results.
// Exempt on purpose: chat messages and match events (people expect those at any
// hour), and the job-driven types (us_cycle, us_date_reminder, us_birthday,
// us_anniversary, subscription nudges) whose jobs already gate themselves on
// the 08:00–21:00 IST window.
//
// Known gap: the window is hardcoded to IST exactly like the cron jobs —
// per-user timezones are a future improvement, deliberately not built here.
export const QUIET_HOURS_GATED_TYPES: ReadonlySet<string> = new Set([
  'us_nudge',
  'us_love',
  'us_feeling',
  'us_ask_feeling',
  'us_fridge_note',
  'us_fridge_ack',
  'us_game_challenge',
  'us_game_result',
]);

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** Phone-buzz window for gated types: 08:00 (inclusive) – 22:00 (exclusive) IST. */
const PUSH_ALLOWED_FROM_HOUR_IST = 8;
const PUSH_ALLOWED_UNTIL_HOUR_IST = 22;

const isQuietHoursIST = (): boolean => {
  const istHour = new Date(Date.now() + IST_OFFSET_MS).getUTCHours();
  return istHour < PUSH_ALLOWED_FROM_HOUR_IST || istHour >= PUSH_ALLOWED_UNTIL_HOUR_IST;
};

/** True when this payload's phone buzz (FCM + WhatsApp) must stay silent right now. */
const mutedByQuietHours = (payload: PushPayload): boolean => {
  const type = typeof payload.data?.type === 'string' ? payload.data.type : '';
  return QUIET_HOURS_GATED_TYPES.has(type) && isQuietHoursIST();
};

/**
 * Send a push notification to every registered device of a couple.
 *
 * Looks up both partners' push tokens. Any token that returns
 * UNREGISTERED / INVALID_ARGUMENT from FCM is removed from the DB so we don't
 * keep retrying a stale install.
 */
export const pushToCouple = async (
  coupleId: string,
  payload: PushPayload,
): Promise<{ sent: number; failed: number }> => {
  // Quiet hours: mute the phone buzz for non-urgent types at night. The in-app
  // Notification row + socket emit were already delivered by the caller.
  if (mutedByQuietHours(payload)) {
    logger.info(
      `[Push] quiet hours (IST) — muted '${String(payload.data?.type)}' push to couple ${coupleId}.`,
    );
    return { sent: 0, failed: 0 };
  }

  // Mirror to WhatsApp for BOTH partners (fire-and-forget, independent of FCM so
  // it still works when push is disabled or a device has no token).
  void mirrorToWhatsAppCouple(coupleId, payload);

  if (!enabled) return { sent: 0, failed: 0 };

  const users = await prisma.user.findMany({
    where: { coupleId, pushToken: { not: null } },
    select: { id: true, pushToken: true, pushPlatform: true, preferredLocale: true },
  });

  // Per-recipient badge (partners can differ — own sends don't badge).
  const badges = new Map<string, number>();
  await Promise.all(
    users.map(async (u) => badges.set(u.id, await badgeCountFor(coupleId, u.id))),
  );

  const targets = users.filter((u): u is typeof u & { pushToken: string } => !!u.pushToken && u.pushToken.length > 0);

  if (targets.length === 0) {
    logger.warn(`[Push] pushToCouple(${coupleId}): no tokens found — users have not registered push yet.`);
    return { sent: 0, failed: 0 };
  }

  logger.info(`[Push] pushToCouple(${coupleId}): sending "${payload.title}" to ${targets.length} device(s).`);

  // Send per-recipient so each partner receives the notification in THEIR own
  // selected language (Android renders from data; iOS shows the APNs alert).
  const deadTokens: string[] = [];
  let sent = 0;
  let failed = 0;

  await Promise.all(
    targets.map(async (u) => {
      const { title, body, data } = localizeFor(payload, u.preferredLocale);
      try {
        await admin.messaging().send({
          token: u.pushToken,
          // NO notification field → pure data message on Android (notifee renders).
          data,
          android: { priority: 'high', collapseKey: payload.collapseKey },
          apns: { payload: { aps: { alert: { title, body }, sound: 'default', badge: badges.get(u.id) ?? 1 } } },
        });
        sent += 1;
      } catch (err: any) {
        failed += 1;
        const code = (err?.errorInfo?.code ?? err?.code) as string | undefined;
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/invalid-argument'
        ) {
          deadTokens.push(u.pushToken);
        } else {
          logger.warn(`[Push] pushToCouple token failed: ${code} — ${err?.message}`);
        }
      }
    }),
  );

  if (deadTokens.length > 0) {
    await prisma.user.updateMany({
      where: { pushToken: { in: deadTokens } },
      data: { pushToken: null, pushPlatform: null },
    });
    logger.info(`[Push] Pruned ${deadTokens.length} stale FCM token(s).`);
  }

  logger.info(`[Push] pushToCouple(${coupleId}): sent=${sent} failed=${failed}`);
  return { sent, failed };
};

/**
 * Send a push notification to one specific user (not both partners).
 * Used for private partner-to-partner notifications like US Space nudges so
 * the sender does NOT receive their own notification.
 */
export const pushToUser = async (
  userId: string,
  payload: PushPayload,
): Promise<{ sent: number; failed: number }> => {
  // Quiet hours: mute the phone buzz for non-urgent types at night. The in-app
  // Notification row + socket emit were already delivered by the caller.
  if (mutedByQuietHours(payload)) {
    logger.info(
      `[Push] quiet hours (IST) — muted '${String(payload.data?.type)}' push to user ${userId}.`,
    );
    return { sent: 0, failed: 0 };
  }

  // Mirror to WhatsApp for this one user (fire-and-forget, independent of FCM).
  void mirrorToWhatsAppUser(userId, payload);

  if (!enabled) return { sent: 0, failed: 0 };

  // findUnique only accepts the unique key — extra conditions like
  // pushToken: { not: null } are not valid there. Check null after fetch.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, coupleId: true, pushToken: true, preferredLocale: true },
  });

  const token = user?.pushToken ?? null;
  if (!token) {
    logger.warn(`[Push] pushToUser(${userId}): no token found — user has not registered push yet.`);
    return { sent: 0, failed: 0 };
  }

  // Localize to the recipient's chosen language.
  const { title, body, data: dataWithText } = localizeFor(payload, user?.preferredLocale);
  logger.info(`[Push] pushToUser(${userId}): sending "${title}".`);

  try {
    const response = await admin.messaging().send({
      token,
      // Android: data-only so the app's notifee background handler renders it
      // with the full-color SAWA logo. iOS: APNs alert for system auto-display.
      data: dataWithText,
      android: {
        priority: 'high',
        collapseKey: payload.collapseKey,
      },
      apns: {
        payload: { aps: { alert: { title, body }, sound: 'default', badge: await badgeCountFor(user?.coupleId, userId) } },
      },
    });
    logger.info(`[Push] Sent to user ${userId}: ${response}`);
    return { sent: 1, failed: 0 };
  } catch (err: any) {
    const code = err?.errorInfo?.code as string | undefined;
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token'
    ) {
      await prisma.user.update({
        where: { id: userId },
        data: { pushToken: null, pushPlatform: null },
      });
      logger.info(`[Push] Pruned stale token for user ${userId}.`);
    } else {
      logger.error(`[Push] Send to user ${userId} failed: ${err.message}`);
    }
    return { sent: 0, failed: 1 };
  }
};

/**
 * Convenience: push to many couples. Returns aggregate counts.
 * Chunked: an admin broadcast to N couples used to open ~2N simultaneous FCM
 * calls (each couple fans out to ≤2 devices) — enough to starve the event
 * loop and trip FCM rate limits on a big send. 25 couples at a time keeps
 * peak concurrency ≤50 sockets with no meaningful latency cost.
 */
const PUSH_CHUNK_SIZE = 25;
export const pushToCouples = async (
  coupleIds: string[],
  payload: PushPayload,
): Promise<{ sent: number; failed: number }> => {
  const acc = { sent: 0, failed: 0 };
  for (let i = 0; i < coupleIds.length; i += PUSH_CHUNK_SIZE) {
    const chunk = coupleIds.slice(i, i + PUSH_CHUNK_SIZE);
    const results = await Promise.all(chunk.map((id) => pushToCouple(id, payload)));
    for (const r of results) {
      acc.sent += r.sent;
      acc.failed += r.failed;
    }
  }
  return acc;
};

export const isPushEnabled = (): boolean => enabled;
