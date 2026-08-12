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
export declare const isWhatsAppEnabled: () => boolean;
/**
 * Mirror a notification to BOTH partners of a couple over WhatsApp.
 * Fire-and-forget — safe to call without awaiting.
 */
export declare const mirrorToWhatsAppCouple: (coupleId: string, payload: WhatsAppNotif) => Promise<void>;
/**
 * Mirror a notification to ONE specific user over WhatsApp (e.g. US-space nudges
 * that should reach only the partner, not the sender). Fire-and-forget.
 */
export declare const mirrorToWhatsAppUser: (userId: string, payload: WhatsAppNotif) => Promise<void>;
//# sourceMappingURL=whatsapp.service.d.ts.map