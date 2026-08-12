import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('5000').transform(Number),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('7d'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('90d'),
  CORS_ORIGINS: z.string().default('http://localhost:8081'),
  RATE_LIMIT_WINDOW_MS: z.string().default('900000').transform(Number),
  RATE_LIMIT_MAX: z.string().default('10').transform(Number),
  // Optional — only required if features are enabled
  REDIS_URL: z.string().optional(),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  // S3-compatible object storage (Tigris) — chat voice messages & media.
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.string().optional(),
  // Dedicated PUBLIC bucket for images (profile photos, community covers).
  // Kept separate from the private voice bucket so images can be served via
  // stable public URLs without exposing private chat audio. Falls back to
  // S3_BUCKET when unset (dev), but production should set a public bucket.
  S3_IMAGE_BUCKET: z.string().optional(),
  S3_IMAGE_PUBLIC_BASE_URL: z.string().optional(),
  RENDER_EXTERNAL_URL: z.string().optional(),
  APP_URL: z.string().optional(),
  RAILWAY_PUBLIC_DOMAIN: z.string().optional(),
  // Comma-separated phone numbers (with country code, e.g. 916369758396,917305410425)
  // that can log in without OTP for testing / demo purposes.
  BYPASS_PHONES: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),

  // ─── WhatsApp notifications (Twilio) ─────────────────────────────────────────
  // Master switch. Keep 'false' until a WhatsApp sender + template are approved,
  // otherwise every notification attempts a (failing) WhatsApp send.
  WHATSAPP_NOTIFICATIONS_ENABLED: z.string().default('false').transform((v) => v === 'true'),
  // The WhatsApp-enabled sender in Twilio, e.g. 'whatsapp:+14155238886' (sandbox)
  // or 'whatsapp:+<your approved business number>'.
  TWILIO_WHATSAPP_FROM: z.string().optional(),
  // Approved Content Template SID (starts with 'HX...'). REQUIRED for production
  // business-initiated messages. When set, notifications are sent as this
  // template with the notification text as variable {{1}}. When unset, the
  // server sends free-form text (only delivers in the Twilio Sandbox or inside a
  // live 24h session window).
  TWILIO_WHATSAPP_CONTENT_SID: z.string().optional(),
  // Notification `type`s to NOT mirror to WhatsApp (comma-separated). Defaults to
  // 'message' so high-frequency chat messages don't spam WhatsApp / rack up cost.
  WHATSAPP_EXCLUDE_TYPES: z.string().default('message'),
  GROQ_API_KEY: z.string().min(1, 'GROQ_API_KEY is required'),
  // Admin portal bootstrap. On startup the server upserts an admin user with
  // these credentials so the admin dashboard login always works after a deploy.
  // No committed defaults: if unset, admin bootstrap is skipped (see
  // bootstrapAdmin.ts). Set both in Railway env vars to enable admin login.
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),

  // ─── Subscriptions ──────────────────────────────────────────────────────────
  // Master switch for entitlement ENFORCEMENT. Keep 'false' until the paywall +
  // store products are live, otherwise every existing user (who has no
  // subscription) would be locked out. When 'false' the whole app behaves exactly
  // as today; entitlement is still tracked so we can flip this on cleanly later.
  SUBSCRIPTIONS_ENFORCED: z.string().default('false').transform((v) => v === 'true'),

  // Apple App Store server-to-server config (App Store Connect → Users & Access
  // → Integrations → In-App Purchase key). Optional so the server still boots
  // before the client sets these up; Apple verification no-ops until present.
  APPLE_BUNDLE_ID: z.string().default('com.sawa.application'),
  APPLE_ISSUER_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  // The .p8 private key contents (with real newlines or \n-escaped — both handled).
  APPLE_PRIVATE_KEY: z.string().optional(),
  // Numeric App Store app id (apps.apple.com/app/id...). Improves verifier checks.
  APPLE_APP_APPLE_ID: z.string().optional().transform((v) => (v ? Number(v) : undefined)),
  // 'Sandbox' | 'Production'. Sandbox for TestFlight/dev, Production for live.
  APPLE_ENVIRONMENT: z.enum(['Sandbox', 'Production']).default('Sandbox'),
  // Store product identifiers. Must match what you create in App Store Connect.
  // One tier (Sawa Prime), two billing periods.
  APPLE_PRODUCT_PRIME_MONTHLY: z.string().default('sawa_prime_monthly'),
  APPLE_PRODUCT_PRIME_YEARLY: z.string().default('sawa_prime_yearly'),

  // ─── Google Play Billing ─────────────────────────────────────────────────────
  // Android applicationId (Play Console package name).
  GOOGLE_PLAY_PACKAGE_NAME: z.string().default('com.sawa.couplesapp'),
  // Service-account JSON with the Google Play Android Developer API enabled and
  // access granted in Play Console. Optional so the server boots before setup;
  // Google verification no-ops until present. (Real newlines or \n both handled.)
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: z.string().optional(),
  // Play subscription (base plan / product) ids. Must match Play Console.
  // One tier (Sawa Prime), two billing periods.
  GOOGLE_PRODUCT_PRIME_MONTHLY: z.string().default('sawa_prime_monthly'),
  GOOGLE_PRODUCT_PRIME_YEARLY: z.string().default('sawa_prime_yearly'),
  // Optional shared secret appended as ?secret=... to the RTDN Pub/Sub push URL,
  // so only Google's configured push can reach the webhook. (Defense in depth —
  // authenticity is already guaranteed by re-fetching the purchase from Google.)
  GOOGLE_RTDN_SECRET: z.string().optional(),
});

const _parsed = envSchema.safeParse(process.env);

if (!_parsed.success) {
  console.error('❌  Invalid environment variables:');
  console.error(JSON.stringify(_parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const env = _parsed.data;
