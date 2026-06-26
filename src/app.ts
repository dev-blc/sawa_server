import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import { env } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import apiRouter from './routes/index';

export const createApp = (): Application => {
  const app = express();

  // ─── Security ───────────────────────────────────────────────────────────────
  app.set('trust proxy', 1);
  app.use(helmet());

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
  if (env.NODE_ENV !== 'test') {
    app.use(morgan(env.NODE_ENV === 'development' ? 'dev' : 'combined'));
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
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      status: 'healthy',
      service: 'sawa-server',
      environment: env.NODE_ENV,
      db: { type: 'postgresql (prisma)' },
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

  // ─── Share Deep-Link Redirect Pages ─────────────────────────────────────────
  // /share/community/:id — smart link: opens app if installed, store otherwise.
  app.get('/share/community/:id', async (req: Request, res: Response) => {
    const { id } = req.params;
    const appScheme   = `sawa://community/${id}`;
    const androidPkg  = 'com.sawa';
    const iosAppId    = '6745446429'; // App Store numeric ID for SAWA
    const playStore   = `https://play.google.com/store/apps/details?id=${androidPkg}`;
    const appStore    = `https://apps.apple.com/app/id${iosAppId}`;

    // Fetch community name for OG preview (best-effort)
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

    const pageTitle   = `${communityName} — SAWA`;
    const description = `Join ${communityName}${communityCity ? ` in ${communityCity}` : ''} on SAWA, the social circle for couples.`;

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${pageTitle}</title>
  <!-- Open Graph (WhatsApp / iMessage preview) -->
  <meta property="og:title"       content="${pageTitle}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:type"        content="website" />
  <!-- Apple Universal Links / Android App Links (configure AASA / assetlinks later) -->
  <meta name="apple-itunes-app"   content="app-id=${iosAppId}, app-argument=${appScheme}" />
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         background:#FFFDF8;display:flex;flex-direction:column;align-items:center;
         justify-content:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box;text-align:center;}
    h1{color:#1C253B;font-size:22px;margin-bottom:8px;}
    p{color:#7A8094;font-size:15px;margin-bottom:32px;}
    .btn{display:inline-block;background:#1C6B4A;color:#fff;border-radius:24px;
         padding:14px 36px;font-size:17px;font-weight:600;text-decoration:none;margin:8px;}
  </style>
</head>
<body>
  <h1>🌿 ${communityName}</h1>
  <p>${description}</p>
  <a class="btn" href="${appScheme}">Open in SAWA</a>

  <script>
    // Try to open the app. After 2 s, fall back to the store based on platform.
    window.location.href = '${appScheme}';
    var isAndroid = /android/i.test(navigator.userAgent);
    var store = isAndroid ? '${playStore}' : '${appStore}';
    setTimeout(function(){
      window.location.href = store;
    }, 2000);
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
