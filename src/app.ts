import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import { env } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import apiRouter from './routes/index';

// ─── Deep-Link / Store Configuration ──────────────────────────────────────────
// These identifiers power the /share/* redirect pages and the App Links /
// Universal Links association files (/.well-known/*). Keep them in sync with the
// mobile app (android applicationId, iOS bundle id / team id / App Store id).
const APP_SCHEME = 'sawa';
const ANDROID_PKG = 'com.sawa.couplesapp';
const IOS_APP_ID = '6760969098'; // numeric App Store id (apps.apple.com/app/id...)
const IOS_BUNDLE_ID = 'com.sawa.application';
const IOS_TEAM_ID = '8D95PWJ95R';
const PLAY_STORE_URL = `https://play.google.com/store/apps/details?id=${ANDROID_PKG}`;
const APP_STORE_URL = `https://apps.apple.com/app/id${IOS_APP_ID}`;

// SHA-256 signing certificate fingerprints that are allowed to open App Links.
// - debug: the local debug.keystore (dev / adb installs)
// - release: sawa-release.keystore (the upload/APK-distributed build)
// NOTE: if the app is distributed via the Play Store, Google re-signs it with the
// "Play App Signing" key — add that SHA-256 (Play Console → App integrity) here too.
const ANDROID_SHA256_FINGERPRINTS = [
  'FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C',
  '65:6D:E0:45:54:C0:0B:F7:26:3F:0A:16:A9:1B:C3:4A:C6:ED:CD:DF:C6:88:FE:AE:B9:FA:36:D8:D4:F5:59:BD',
];

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Deep-link ids are cuid()/uuid-style. Express keeps URL-encoded slashes (%2F)
// inside a single :id param, so without this a value like
// `</script><script>…</script>` would survive into the inline share-page script
// (whose CSP allows 'unsafe-inline') and execute — a reflected XSS. Restrict the
// id to a safe charset before it's ever embedded in HTML/JS.
const safeLinkId = (raw: unknown): string => String(raw ?? '').replace(/[^A-Za-z0-9_-]/g, '');

// These are public redirect/marketing pages that must run a small inline script
// to bounce the visitor to the app or store. Helmet's default CSP blocks inline
// scripts, so relax it to allow inline execution on these routes only.
const sendRedirectHtml = (res: Response, html: string): void => {
  res.removeHeader('Content-Security-Policy');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:",
  );
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
};

/**
 * Builds a "smart" redirect HTML page. When the app is installed AND the platform
 * verified the App Link / Universal Link, the OS opens the app directly and this
 * page never renders. When it does render (app not installed, or link pasted into
 * a browser) it tries the custom scheme, then falls back to the correct store.
 */
const renderSharePage = (opts: {
  title: string;
  description: string;
  scheme: string; // e.g. sawa://community/123
  emoji?: string;
}): string => {
  const { title, description, scheme } = opts;
  const emoji = opts.emoji || '💛';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta property="og:title"       content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:type"        content="website" />
  <!-- iOS Smart App Banner + Universal Link hint -->
  <meta name="apple-itunes-app"   content="app-id=${IOS_APP_ID}, app-argument=${escapeHtml(scheme)}" />
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
         background:#FFFDF8;display:flex;flex-direction:column;align-items:center;
         justify-content:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box;text-align:center;}
    h1{color:#1C253B;font-size:22px;margin-bottom:8px;}
    p{color:#7A8094;font-size:15px;margin-bottom:28px;max-width:340px;}
    .btn{display:inline-block;background:#1C6B4A;color:#fff;border-radius:24px;
         padding:14px 36px;font-size:17px;font-weight:600;text-decoration:none;margin:8px;}
    .store{color:#1C6B4A;font-size:14px;margin-top:16px;text-decoration:none;}
  </style>
</head>
<body>
  <h1>${emoji} ${escapeHtml(title)}</h1>
  <p>${escapeHtml(description)}</p>
  <a class="btn" id="openBtn" href="${escapeHtml(scheme)}">Open in SAWA</a>
  <a class="store" id="storeLink" href="${APP_STORE_URL}">Don't have the app? Get SAWA</a>

  <script>
    (function () {
      var scheme = ${JSON.stringify(scheme)};
      var playStore = ${JSON.stringify(PLAY_STORE_URL)};
      var appStore = ${JSON.stringify(APP_STORE_URL)};
      var ua = navigator.userAgent || navigator.vendor || '';
      var isAndroid = /android/i.test(ua);
      var isIOS = /iPad|iPhone|iPod/.test(ua) ||
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      var store = isAndroid ? playStore : (isIOS ? appStore : null);
      if (store) { document.getElementById('storeLink').href = store; }

      // Try to open the installed app via the custom scheme.
      var now = Date.now();
      window.location.href = scheme;

      // If we're still here after 1.5s, the app isn't installed → go to the store.
      // (If the app opened, the page is backgrounded and this timer is throttled.)
      if (store) {
        setTimeout(function () {
          if (Date.now() - now < 2500 && !document.hidden) {
            window.location.href = store;
          }
        }, 1500);
      }
    })();
  </script>
</body>
</html>`;
};

export const createApp = (): Application => {
  const app = express();

  // ─── Security ───────────────────────────────────────────────────────────────
  app.set('trust proxy', 1);
  app.use(
    helmet({
      // Force HTTPS for one year (browsers only; the mobile API is already
      // HTTPS-only). TLS is terminated at the platform proxy in front of us.
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
    }),
  );

  const allowedOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim());
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (e.g. mobile apps, curl)
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error(`CORS policy: origin ${origin} not allowed`));
        }
      },
      credentials: true,
    }),
  );

  // ─── Body Parsing ────────────────────────────────────────────────────────────
  // 10mb covers onboarding photo uploads (base64); most API calls are <1mb.
  // Voice audio is sent as base64 via sockets (not HTTP), so 10mb is safe.
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // ─── Compression ────────────────────────────────────────────────────────────
  app.use(compression());

  // ─── Logging ─────────────────────────────────────────────────────────────────
  // Skip the high-frequency infra probes (/health, /wakeup) so production logs
  // aren't drowned by the healthcheck + self-wakeup traffic.
  //
  // Redact credential-bearing query params from logged URLs. Some endpoints (e.g.
  // admin media) accept a `?token=` for <img>/loaders that can't send headers;
  // `morgan('combined')` would otherwise write the full JWT to disk / Railway.
  morgan.token('safeurl', (req: any) => {
    const url: string = req.originalUrl || req.url || '';
    return url.replace(/([?&](?:token|secret|otp|password|refreshtoken)=)[^&]*/gi, '$1REDACTED');
  });
  const combinedSafe =
    ':remote-addr - :remote-user [:date[clf]] ":method :safeurl HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"';
  const devSafe = ':method :safeurl :status :response-time ms - :res[content-length]';
  if (env.NODE_ENV !== 'test') {
    app.use(
      morgan(env.NODE_ENV === 'development' ? devSafe : combinedSafe, {
        skip: (req) => req.url === '/health' || req.url === '/wakeup',
      }),
    );
  }

  // ─── Performance Monitoring ──────────────────────────────────────────────────
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (duration > 1000) {
        console.warn(`🐢 Slow Request: ${req.method} ${req.url} - ${duration}ms`);
      }
    });
    next();
  });

  // ─── Health Check ────────────────────────────────────────────────────────────
  // Deep check: verifies the process can actually reach Postgres (and reports
  // Redis) so the orchestrator restarts a worker that is up but can't serve
  // traffic. Returns 503 only when the DB is unreachable — Redis is optional
  // and never fails the check on its own.
  app.get('/health', async (_req: Request, res: Response) => {
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
      ]);

    let dbStatus: 'ok' | 'down' = 'ok';
    try {
      const { prisma } = await import('./lib/prisma');
      await withTimeout(prisma.$queryRaw`SELECT 1`, 3000);
    } catch {
      dbStatus = 'down';
    }

    let redisStatus: 'ok' | 'down' | 'disabled' = 'disabled';
    try {
      const { cachePing } = await import('./lib/cache');
      redisStatus = await withTimeout(cachePing(), 2000);
    } catch {
      redisStatus = 'down';
    }

    const healthy = dbStatus === 'ok';
    // Public payload is intentionally minimal — enough for the orchestrator to
    // decide healthy/unhealthy, without disclosing NODE_ENV, pid/worker layout,
    // CPU count or feature flags to anonymous callers. Verbose diagnostics are
    // available in-process via logs.
    res.status(healthy ? 200 : 503).json({
      success: healthy,
      status: healthy ? 'healthy' : 'unhealthy',
      service: 'sawa-server',
      db: { status: dbStatus },
      redis: { status: redisStatus },
      timestamp: new Date().toISOString(),
    });
  });

  // ─── Wakeup Ping ─────────────────────────────────────────────────────────────
  app.get('/wakeup', (_req: Request, res: Response) => {
    res.status(200).json({ 
      success: true, 
      message: 'Server is awake',
      timestamp: new Date().toISOString()
    });
  });

  // ─── Image Proxy ─────────────────────────────────────────────────────────────
  // Public, unauthenticated (image loaders can't send auth headers). Streams an
  // object from the PRIVATE bucket so profile photos / community covers can be
  // served by stable URLs without a public bucket. Keys are unguessable UUIDs
  // and restricted to the image/ prefix (voice notes can never be proxied).
  // Objects are immutable (unique key per upload) → cache aggressively.
  app.get('/img/*', async (req: Request, res: Response) => {
    const key = (req.params as any)[0] as string;
    if (!key || !/^image\//.test(key) || key.includes('..')) {
      res.status(400).json({ success: false, error: 'Invalid image key' });
      return;
    }
    try {
      const { getObjectStream } = await import('./lib/storage');
      const obj = await getObjectStream(key);
      if (!obj) {
        res.status(404).json({ success: false, error: 'Image not found' });
        return;
      }
      res.setHeader('Content-Type', obj.contentType || 'image/jpeg');
      if (obj.contentLength) res.setHeader('Content-Length', String(obj.contentLength));
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      // Allow the image to be embedded cross-origin (web admin, share pages).
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      obj.body.on('error', () => {
        if (!res.headersSent) res.status(502).end();
        else res.destroy();
      });
      obj.body.pipe(res);
    } catch {
      res.status(500).json({ success: false, error: 'Image fetch failed' });
    }
  });

  // ─── App Links / Universal Links Association Files ──────────────────────────
  // Android App Links: proves this domain is owned by the app, so verified
  // https://<host>/share/* links open the app directly (no browser bounce).
  app.get('/.well-known/assetlinks.json', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.json([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: ANDROID_PKG,
          sha256_cert_fingerprints: ANDROID_SHA256_FINGERPRINTS,
        },
      },
    ]);
  });

  // iOS Universal Links: must be served at the site root with no file extension
  // and Content-Type application/json. Requires the Associated Domains
  // capability (applinks:sawaserver-backend.up.railway.app) in the iOS app.
  const appleAppSiteAssociation = {
    applinks: {
      apps: [],
      details: [
        {
          appID: `${IOS_TEAM_ID}.${IOS_BUNDLE_ID}`,
          paths: ['/share/*', '/app'],
        },
      ],
    },
  };
  const sendAASA = (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(appleAppSiteAssociation);
  };
  app.get('/.well-known/apple-app-site-association', sendAASA);
  app.get('/apple-app-site-association', sendAASA);

  // ─── Share Deep-Link Redirect Pages ─────────────────────────────────────────
  // /share/community/:id — opens app if installed, store otherwise.
  app.get('/share/community/:id', async (req: Request, res: Response) => {
    const id = safeLinkId(req.params.id);

    let communityName = 'a community';
    let communityCity = '';
    try {
      const { prisma } = await import('./lib/prisma');
      const community = await prisma.community.findUnique({
        where: { id },
        select: { name: true, city: true },
      });
      if (community) {
        communityName = community.name;
        communityCity = community.city || '';
      }
    } catch { /* non-fatal */ }

    sendRedirectHtml(
      res,
      renderSharePage({
        title: `${communityName} — SAWA`,
        description: `Join ${communityName}${communityCity ? ` in ${communityCity}` : ''} on SAWA — everything, built around couples.`,
        scheme: `${APP_SCHEME}://community/${id}`,
        emoji: '🌿',
      }),
    );
  });

  // /share/couple/:id — opens the couple's profile in the app, store otherwise.
  app.get('/share/couple/:id', async (req: Request, res: Response) => {
    const id = safeLinkId(req.params.id);

    let coupleName = 'a couple';
    try {
      const { prisma } = await import('./lib/prisma');
      // The shared link carries the business `coupleId`, but fall back to the
      // primary `id` just in case an internal id was used.
      const couple = await prisma.couple.findFirst({
        where: { OR: [{ coupleId: id }, { id }] },
        select: { profileName: true },
      });
      if (couple?.profileName) coupleName = couple.profileName;
    } catch { /* non-fatal */ }

    sendRedirectHtml(
      res,
      renderSharePage({
        title: `${coupleName} on SAWA`,
        description: `Check out ${coupleName} on SAWA — everything, built around couples.`,
        scheme: `${APP_SCHEME}://couple/${id}`,
        emoji: '💛',
      }),
    );
  });

  // /app — plain "get the app" smart link (used by Settings → Share Sawa).
  // Detects the visitor's platform and forwards to the correct store.
  app.get('/app', (_req: Request, res: Response) => {
    sendRedirectHtml(res, `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Get SAWA</title>
  <meta property="og:title"       content="SAWA — Everything, Built Around Couples" />
  <meta property="og:description" content="A warm, family-friendly space for couples to connect with other couples." />
  <meta property="og:type"        content="website" />
  <meta name="apple-itunes-app"   content="app-id=${IOS_APP_ID}" />
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
         background:#FFFDF8;display:flex;flex-direction:column;align-items:center;
         justify-content:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box;text-align:center;}
    h1{color:#1C253B;font-size:24px;margin-bottom:8px;}
    p{color:#7A8094;font-size:15px;margin-bottom:28px;max-width:340px;}
    .btn{display:inline-block;background:#1C6B4A;color:#fff;border-radius:24px;
         padding:14px 36px;font-size:17px;font-weight:600;text-decoration:none;margin:8px;}
  </style>
</head>
<body>
  <h1>💛 Get SAWA</h1>
  <p>A warm, family-friendly space for couples to connect with other couples.</p>
  <a class="btn" id="storeBtn" href="${APP_STORE_URL}">Download SAWA</a>
  <script>
    (function () {
      var playStore = ${JSON.stringify(PLAY_STORE_URL)};
      var appStore = ${JSON.stringify(APP_STORE_URL)};
      var ua = navigator.userAgent || navigator.vendor || '';
      var isAndroid = /android/i.test(ua);
      var isIOS = /iPad|iPhone|iPod/.test(ua) ||
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (isAndroid) { window.location.href = playStore; }
      else if (isIOS) { window.location.href = appStore; }
      else { document.getElementById('storeBtn').setAttribute('href', appStore); }
    })();
  </script>
</body>
</html>`);
  });

  // ─── Privacy Policy Page ─────────────────────────────────────────────────────
  app.get('/privacy-policy', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Privacy Policy — SAWA</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
         background:#FFFDF8;color:#1C253B;padding:32px 24px;max-width:720px;margin:0 auto;line-height:1.7;}
    h1{font-size:28px;font-weight:700;color:#1C6B4A;margin-bottom:8px;}
    .subtitle{color:#7A8094;font-size:14px;margin-bottom:36px;}
    h2{font-size:18px;font-weight:600;color:#1C253B;margin:28px 0 10px;}
    p,li{font-size:15px;color:#3A4258;margin-bottom:10px;}
    ul{padding-left:20px;margin-bottom:10px;}
    a{color:#1C6B4A;}
    footer{margin-top:48px;font-size:13px;color:#9AA0B2;border-top:1px solid #E8EAF0;padding-top:20px;}
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p class="subtitle">Last updated: June 2026</p>

  <p>SAWA ("we", "our", or "us") is committed to protecting the privacy of our users. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our mobile application SAWA.</p>

  <h2>1. Information We Collect</h2>
  <ul>
    <li><strong>Account Information:</strong> Name, phone number, and couple profile details you provide during registration.</li>
    <li><strong>Profile Content:</strong> Photos, bios, and other content you upload to your profile.</li>
    <li><strong>Location Data:</strong> Approximate location to help you discover couples nearby (only when you grant permission).</li>
    <li><strong>Messages:</strong> Private messages and community chat content shared within the app.</li>
    <li><strong>Usage Data:</strong> How you interact with the app, including screens visited and features used.</li>
    <li><strong>Device Information:</strong> Device type, operating system, and push notification tokens.</li>
  </ul>

  <h2>2. How We Use Your Information</h2>
  <ul>
    <li>To create and manage your account and couple profile.</li>
    <li>To enable discovery, matching, and connection features between couples.</li>
    <li>To facilitate private and community messaging.</li>
    <li>To send push notifications about connections, messages, and activity.</li>
    <li>To improve the app's features, performance, and user experience.</li>
    <li>To ensure safety and enforce our community guidelines.</li>
  </ul>

  <h2>3. Sharing of Information</h2>
  <p>We do not sell your personal information. We may share information with:</p>
  <ul>
    <li><strong>Other Users:</strong> Profile information (name, photos, bio) is visible to other couples on the platform as intended by the app's social features.</li>
    <li><strong>Service Providers:</strong> Third-party providers who help operate our infrastructure (e.g. cloud hosting, push notifications).</li>
    <li><strong>Legal Requirements:</strong> When required by law or to protect the rights and safety of our users.</li>
  </ul>

  <h2>4. Data Retention</h2>
  <p>We retain your information for as long as your account is active. You may request deletion of your account and data by contacting us at the email below.</p>

  <h2>5. Security</h2>
  <p>We implement industry-standard security measures to protect your data. However, no method of transmission over the internet is 100% secure.</p>

  <h2>6. Children's Privacy</h2>
  <p>SAWA is intended for adults (18+) in committed relationships. We do not knowingly collect information from anyone under 18.</p>

  <h2>7. Your Rights</h2>
  <ul>
    <li>Access, update, or delete your personal information through the app settings.</li>
    <li>Opt out of push notifications through your device settings.</li>
    <li>Request a copy of your data by contacting us.</li>
  </ul>

  <h2>8. Zero Tolerance for Objectionable Content</h2>
  <p>SAWA maintains a strict <strong>zero-tolerance policy</strong> toward any objectionable content or abusive behaviour on the Platform. This includes sexually explicit material, hate speech, harassment, threats, bullying, violence, or any content a reasonable person would find offensive or harmful.</p>
  <p>Any content or conduct that falls within these categories will result in immediate removal and may result in permanent account termination. Violations may also be reported to relevant authorities.</p>

  <h2>9. How to Report Objectionable Content</h2>
  <p>SAWA provides an in-app reporting mechanism so that any user can flag objectionable content or behaviour at any time:</p>
  <ul>
    <li>Navigate to the offending user's profile and tap the <strong>"Report"</strong> button.</li>
    <li>Select a reason for the report — all reports are reviewed by SAWA's moderation team.</li>
    <li>You may also report via email: <a href="mailto:support@gosawa.com">support@gosawa.com</a>.</li>
  </ul>
  <p>All reports are handled confidentially and appropriate action will be taken, including removal of content, warnings, or account termination.</p>

  <h2>10. How to Block Abusive Users</h2>
  <p>SAWA provides an in-app blocking feature that allows users to immediately stop all interactions with another user:</p>
  <ul>
    <li>Navigate to the user's profile and tap the <strong>"Block"</strong> button.</li>
    <li>Once blocked, that user can no longer view your profile, message you, or interact with you on the Platform.</li>
    <li>Blocking is immediate, private, and reversible through your account settings.</li>
  </ul>

  <h2>11. Changes to This Policy</h2>
  <p>We may update this Privacy Policy from time to time. We will notify you of significant changes through the app or via push notification.</p>

  <h2>12. Contact Us</h2>
  <p>If you have any questions about this Privacy Policy, please contact us at:<br/>
  <a href="mailto:support@gosawa.com">support@gosawa.com</a></p>

  <footer>© 2026 SAWA. All rights reserved.</footer>
</body>
</html>`);
  });

  // ─── Support Page ─────────────────────────────────────────────────────────────
  app.get('/support', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Support — SAWA</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
         background:#FFFDF8;color:#1C253B;padding:32px 24px;max-width:720px;margin:0 auto;line-height:1.7;}
    h1{font-size:28px;font-weight:700;color:#1C6B4A;margin-bottom:8px;}
    .subtitle{color:#7A8094;font-size:14px;margin-bottom:36px;}
    h2{font-size:18px;font-weight:600;margin:28px 0 10px;}
    p,li{font-size:15px;color:#3A4258;margin-bottom:10px;}
    ul{padding-left:20px;margin-bottom:10px;}
    a{color:#1C6B4A;}
    .email-box{background:#F0F7F3;border-radius:12px;padding:20px 24px;margin-top:16px;}
    footer{margin-top:48px;font-size:13px;color:#9AA0B2;border-top:1px solid #E8EAF0;padding-top:20px;}
  </style>
</head>
<body>
  <h1>Support</h1>
  <p class="subtitle">We're here to help.</p>

  <p>If you're experiencing any issues with SAWA or have questions about your account, please reach out to us.</p>

  <h2>Contact Us</h2>
  <div class="email-box">
    <p>📧 Email us at: <a href="mailto:support@gosawa.com"><strong>support@gosawa.com</strong></a></p>
    <p>We typically respond within 24–48 hours.</p>
  </div>

  <h2>Frequently Asked Questions</h2>
  <ul>
    <li><strong>How do I delete my account?</strong> Go to Profile → Settings → Delete Account.</li>
    <li><strong>How do I connect with another couple?</strong> Tap "Say Hello" on their profile in the Couples discovery tab.</li>
    <li><strong>How do I report a user?</strong> Open their profile and tap the report icon.</li>
    <li><strong>I'm not receiving OTP.</strong> Check your network connection and try again. Make sure your number is correct.</li>
  </ul>

  <footer>© 2026 SAWA. All rights reserved.</footer>
</body>
</html>`);
  });

  // ─── API Routes ──────────────────────────────────────────────────────────────
  app.use('/api/v1', apiRouter);

  // ─── 404 Catch-all ───────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: 'Route not found',
      code: 404,
    });
  });

  // ─── Global Error Handler ────────────────────────────────────────────────────
  app.use(errorHandler);

  return app;
};
