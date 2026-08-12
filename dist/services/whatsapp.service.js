"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mirrorToWhatsAppUser = exports.mirrorToWhatsAppCouple = exports.isWhatsAppEnabled = void 0;
const twilio_1 = __importDefault(require("twilio"));
const prisma_1 = require("../lib/prisma");
const logger_1 = require("../utils/logger");
const env_1 = require("../config/env");
const notif_1 = require("../i18n/notif");
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const READY = env_1.env.WHATSAPP_NOTIFICATIONS_ENABLED &&
    !!ACCOUNT_SID &&
    !!AUTH_TOKEN &&
    !!env_1.env.TWILIO_WHATSAPP_FROM;
const client = READY ? (0, twilio_1.default)(ACCOUNT_SID, AUTH_TOKEN) : null;
const excludedTypes = new Set(env_1.env.WHATSAPP_EXCLUDE_TYPES.split(',').map((t) => t.trim()).filter(Boolean));
if (env_1.env.WHATSAPP_NOTIFICATIONS_ENABLED && !READY) {
    logger_1.logger.warn('[WhatsApp] WHATSAPP_NOTIFICATIONS_ENABLED=true but Twilio WhatsApp is not fully configured ' +
        '(need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM). WhatsApp mirror disabled.');
}
const isWhatsAppEnabled = () => READY;
exports.isWhatsAppEnabled = isWhatsAppEnabled;
/** Format a stored phone into WhatsApp E.164 form: 'whatsapp:+<digits>'. */
function toWhatsAppAddress(phone) {
    const digits = phone.replace(/\D/g, '');
    if (!digits)
        return null;
    let e164;
    if (phone.trim().startsWith('+'))
        e164 = `+${digits}`;
    else if (digits.length === 12 && digits.startsWith('91'))
        e164 = `+${digits}`;
    else if (digits.length === 10)
        e164 = `+91${digits}`;
    else
        e164 = `+${digits}`;
    return `whatsapp:${e164}`;
}
/** Resolve the notification `type` used for the exclude-list check. */
function notifType(payload) {
    const t = payload.data?.type;
    return typeof t === 'string' ? t : '';
}
/** Localize the notification text to the recipient's language, as a single line. */
function renderText(payload, locale) {
    let title = payload.title;
    let body = payload.body;
    const rawData = payload.data ?? {};
    const i18nKey = typeof rawData.i18nKey === 'string' ? rawData.i18nKey : undefined;
    if (i18nKey && (0, notif_1.hasNotifKey)(i18nKey)) {
        let params = {};
        const rp = rawData.i18nParams;
        if (typeof rp === 'string') {
            try {
                params = JSON.parse(rp);
            }
            catch { /* keep {} */ }
        }
        else if (rp && typeof rp === 'object') {
            params = rp;
        }
        const rendered = (0, notif_1.renderNotif)(locale, i18nKey, params);
        title = rendered.title || title;
        body = rendered.body || body;
    }
    const parts = [title?.trim(), body?.trim()].filter(Boolean);
    // WhatsApp body cap is 1600 chars; notifications are short but stay safe.
    return parts.join('\n').slice(0, 1500);
}
/** Send one WhatsApp message. Never throws. */
async function sendOne(phone, payload, locale) {
    if (!client || !phone)
        return;
    const to = toWhatsAppAddress(phone);
    if (!to)
        return;
    const text = renderText(payload, locale);
    if (!text)
        return;
    try {
        if (env_1.env.TWILIO_WHATSAPP_CONTENT_SID) {
            // Production path: approved template with the text as variable {{1}}.
            await client.messages.create({
                from: env_1.env.TWILIO_WHATSAPP_FROM,
                to,
                contentSid: env_1.env.TWILIO_WHATSAPP_CONTENT_SID,
                contentVariables: JSON.stringify({ '1': text }),
            });
        }
        else {
            // Sandbox / in-session path: free-form text.
            await client.messages.create({
                from: env_1.env.TWILIO_WHATSAPP_FROM,
                to,
                body: text,
            });
        }
    }
    catch (err) {
        // Non-fatal: a WhatsApp failure must never affect push or the request.
        logger_1.logger.warn(`[WhatsApp] send failed to ${to}: ${err?.message ?? err}`);
    }
}
/**
 * Mirror a notification to BOTH partners of a couple over WhatsApp.
 * Fire-and-forget — safe to call without awaiting.
 */
const mirrorToWhatsAppCouple = async (coupleId, payload) => {
    if (!READY)
        return;
    if (excludedTypes.has(notifType(payload)))
        return;
    try {
        const users = await prisma_1.prisma.user.findMany({
            where: { coupleId, phone: { not: null } },
            select: { phone: true, preferredLocale: true },
        });
        await Promise.all(users.map((u) => sendOne(u.phone, payload, u.preferredLocale)));
    }
    catch (err) {
        logger_1.logger.warn(`[WhatsApp] mirrorToWhatsAppCouple(${coupleId}) failed: ${err?.message ?? err}`);
    }
};
exports.mirrorToWhatsAppCouple = mirrorToWhatsAppCouple;
/**
 * Mirror a notification to ONE specific user over WhatsApp (e.g. US-space nudges
 * that should reach only the partner, not the sender). Fire-and-forget.
 */
const mirrorToWhatsAppUser = async (userId, payload) => {
    if (!READY)
        return;
    if (excludedTypes.has(notifType(payload)))
        return;
    try {
        const user = await prisma_1.prisma.user.findUnique({
            where: { id: userId },
            select: { phone: true, preferredLocale: true },
        });
        if (user)
            await sendOne(user.phone, payload, user.preferredLocale);
    }
    catch (err) {
        logger_1.logger.warn(`[WhatsApp] mirrorToWhatsAppUser(${userId}) failed: ${err?.message ?? err}`);
    }
};
exports.mirrorToWhatsAppUser = mirrorToWhatsAppUser;
//# sourceMappingURL=whatsapp.service.js.map