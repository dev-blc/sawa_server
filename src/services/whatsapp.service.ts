import twilio from 'twilio';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { renderNotif, hasNotifKey, NotifParams } from '../i18n/notif';

/**
 * WhatsApp notification mirror (Twilio).
 *
 * Sends a WhatsApp copy of every in-app / push notification so users are reached
 * even when the app is closed and push is missed. This runs ALONGSIDE FCM push —
 * it never blocks or affects push delivery (fire-and-forget, all errors caught).
 *
 * ── IMPORTANT WhatsApp policy ────────────────────────────────────────────────
 * WhatsApp only allows businesses to send FREE-FORM text within 24h of the user
 * last messaging you. All other (proactive) messages MUST use a pre-approved
 * "Content Template". Therefore in PRODUCTION you must set
 * TWILIO_WHATSAPP_CONTENT_SID to an approved template whose body has a single
 * variable, e.g.  "🔔 SAWA: {{1}}".  We pass the notification text as {{1}}.
 * Without a template SID we fall back to free-form text, which only delivers in
 * the Twilio WhatsApp Sandbox (for testing) or inside a live 24h session.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Enable by setting:
 *   WHATSAPP_NOTIFICATIONS_ENABLED=true
 *   TWILIO_WHATSAPP_FROM=whatsapp:+14155238886        (sandbox or your sender)
 *   TWILIO_WHATSAPP_CONTENT_SID=HX...                 (required for production)
 * Reuses TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN (same account as OTP SMS).
 */

/** Minimal payload shape (kept local to avoid a circular import with push.service). */
export interface WhatsAppNotif {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const READY =
  env.WHATSAPP_NOTIFICATIONS_ENABLED &&
  !!ACCOUNT_SID &&
  !!AUTH_TOKEN &&
  !!env.TWILIO_WHATSAPP_FROM;

const client = READY ? twilio(ACCOUNT_SID!, AUTH_TOKEN!) : null;

const excludedTypes = new Set(
  env.WHATSAPP_EXCLUDE_TYPES.split(',').map((t) => t.trim()).filter(Boolean),
);

if (env.WHATSAPP_NOTIFICATIONS_ENABLED && !READY) {
  logger.warn(
    '[WhatsApp] WHATSAPP_NOTIFICATIONS_ENABLED=true but Twilio WhatsApp is not fully configured ' +
      '(need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM). WhatsApp mirror disabled.',
  );
}

export const isWhatsAppEnabled = (): boolean => READY;

/** Format a stored phone into WhatsApp E.164 form: 'whatsapp:+<digits>'. */
function toWhatsAppAddress(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;
  let e164: string;
  if (phone.trim().startsWith('+')) e164 = `+${digits}`;
  else if (digits.length === 12 && digits.startsWith('91')) e164 = `+${digits}`;
  else if (digits.length === 10) e164 = `+91${digits}`;
  else e164 = `+${digits}`;
  return `whatsapp:${e164}`;
}

/** Resolve the notification `type` used for the exclude-list check. */
function notifType(payload: WhatsAppNotif): string {
  const t = payload.data?.type;
  return typeof t === 'string' ? t : '';
}

/** Localize the notification text to the recipient's language, as a single line. */
function renderText(payload: WhatsAppNotif, locale?: string | null): string {
  let title = payload.title;
  let body = payload.body;

  const rawData = payload.data ?? {};
  const i18nKey = typeof rawData.i18nKey === 'string' ? rawData.i18nKey : undefined;
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

  const parts = [title?.trim(), body?.trim()].filter(Boolean);
  // WhatsApp body cap is 1600 chars; notifications are short but stay safe.
  return parts.join('\n').slice(0, 1500);
}

/** Send one WhatsApp message. Never throws. */
async function sendOne(
  phone: string | null | undefined,
  payload: WhatsAppNotif,
  locale?: string | null,
): Promise<void> {
  if (!client || !phone) return;
  const to = toWhatsAppAddress(phone);
  if (!to) return;

  const text = renderText(payload, locale);
  if (!text) return;

  try {
    if (env.TWILIO_WHATSAPP_CONTENT_SID) {
      // Production path: approved template with the text as variable {{1}}.
      await client.messages.create({
        from: env.TWILIO_WHATSAPP_FROM!,
        to,
        contentSid: env.TWILIO_WHATSAPP_CONTENT_SID,
        contentVariables: JSON.stringify({ '1': text }),
      });
    } else {
      // Sandbox / in-session path: free-form text.
      await client.messages.create({
        from: env.TWILIO_WHATSAPP_FROM!,
        to,
        body: text,
      });
    }
  } catch (err: any) {
    // Non-fatal: a WhatsApp failure must never affect push or the request.
    logger.warn(`[WhatsApp] send failed to ${to}: ${err?.message ?? err}`);
  }
}

/**
 * Mirror a notification to BOTH partners of a couple over WhatsApp.
 * Fire-and-forget — safe to call without awaiting.
 */
export const mirrorToWhatsAppCouple = async (
  coupleId: string,
  payload: WhatsAppNotif,
): Promise<void> => {
  if (!READY) return;
  if (excludedTypes.has(notifType(payload))) return;

  try {
    const users = await prisma.user.findMany({
      where: { coupleId, phone: { not: null } },
      select: { phone: true, preferredLocale: true },
    });
    await Promise.all(users.map((u) => sendOne(u.phone, payload, u.preferredLocale)));
  } catch (err: any) {
    logger.warn(`[WhatsApp] mirrorToWhatsAppCouple(${coupleId}) failed: ${err?.message ?? err}`);
  }
};

/**
 * Mirror a notification to ONE specific user over WhatsApp (e.g. US-space nudges
 * that should reach only the partner, not the sender). Fire-and-forget.
 */
export const mirrorToWhatsAppUser = async (
  userId: string,
  payload: WhatsAppNotif,
): Promise<void> => {
  if (!READY) return;
  if (excludedTypes.has(notifType(payload))) return;

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, preferredLocale: true },
    });
    if (user) await sendOne(user.phone, payload, user.preferredLocale);
  } catch (err: any) {
    logger.warn(`[WhatsApp] mirrorToWhatsAppUser(${userId}) failed: ${err?.message ?? err}`);
  }
};
