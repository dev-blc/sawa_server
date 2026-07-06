import admin from 'firebase-admin';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

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
  if (!enabled) return { sent: 0, failed: 0 };

  const users = await prisma.user.findMany({
    where: { coupleId, pushToken: { not: null } },
    select: { id: true, pushToken: true, pushPlatform: true },
  });

  const tokens = users
    .map((u) => u.pushToken)
    .filter((t): t is string => !!t && t.length > 0);

  if (tokens.length === 0) {
    logger.warn(`[Push] pushToCouple(${coupleId}): no tokens found — users have not registered push yet.`);
    return { sent: 0, failed: 0 };
  }

  logger.info(`[Push] pushToCouple(${coupleId}): sending "${payload.title}" to ${tokens.length} token(s).`);

  const stringData: Record<string, string> = {};
  if (payload.data) {
    for (const [k, v] of Object.entries(payload.data)) {
      if (v === null || v === undefined) continue;
      stringData[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
  }

  try {
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: stringData,
      android: {
        priority: 'high',
        collapseKey: payload.collapseKey,
        notification: {
          sound: 'default',
          channelId: 'sawa_default',
          icon: 'ic_notification',
          color: '#5DBE8B',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    });

    // Prune dead tokens so this couple doesn't keep failing forever.
    if (response.failureCount > 0) {
      const deadTokens: string[] = [];
      response.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = r.error?.code;
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/invalid-argument'
          ) {
            deadTokens.push(tokens[idx]);
          }
        }
      });
      if (deadTokens.length > 0) {
        await prisma.user.updateMany({
          where: { pushToken: { in: deadTokens } },
          data: { pushToken: null, pushPlatform: null },
        });
        logger.info(`[Push] Pruned ${deadTokens.length} stale FCM token(s).`);
      }
    }

    logger.info(`[Push] pushToCouple(${coupleId}): sent=${response.successCount} failed=${response.failureCount}`);
    if (response.failureCount > 0) {
      response.responses.forEach((r, idx) => {
        if (!r.success) logger.warn(`[Push] Token[${idx}] failed: ${r.error?.code} — ${r.error?.message}`);
      });
    }
    return { sent: response.successCount, failed: response.failureCount };
  } catch (err: any) {
    logger.error(`[Push] Send failed for couple ${coupleId}: ${err.message}`);
    return { sent: 0, failed: tokens.length };
  }
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
  if (!enabled) return { sent: 0, failed: 0 };

  // findUnique only accepts the unique key — extra conditions like
  // pushToken: { not: null } are not valid there. Check null after fetch.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, pushToken: true },
  });

  const token = user?.pushToken ?? null;
  if (!token) {
    logger.warn(`[Push] pushToUser(${userId}): no token found — user has not registered push yet.`);
    return { sent: 0, failed: 0 };
  }
  logger.info(`[Push] pushToUser(${userId}): sending "${payload.title}".`);

  const stringData: Record<string, string> = {};
  if (payload.data) {
    for (const [k, v] of Object.entries(payload.data)) {
      if (v === null || v === undefined) continue;
      stringData[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
  }

  try {
    const response = await admin.messaging().send({
      token,
      notification: { title: payload.title, body: payload.body },
      data: stringData,
      android: {
        priority: 'high',
        collapseKey: payload.collapseKey,
        notification: { sound: 'default', channelId: 'sawa_default', icon: 'ic_notification', color: '#5DBE8B' },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1 } },
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
 * Convenience: push to many couples in parallel. Returns aggregate counts.
 */
export const pushToCouples = async (
  coupleIds: string[],
  payload: PushPayload,
): Promise<{ sent: number; failed: number }> => {
  const results = await Promise.all(
    coupleIds.map((id) => pushToCouple(id, payload)),
  );
  return results.reduce(
    (acc, r) => ({ sent: acc.sent + r.sent, failed: acc.failed + r.failed }),
    { sent: 0, failed: 0 },
  );
};

export const isPushEnabled = (): boolean => enabled;
