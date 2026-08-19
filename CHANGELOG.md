# SAWA Server — Change Log

> **Every change must be recorded here.** Format: `## [YYYY-MM-DD] — Description`

---

## [2026-08-19] — Audit cleanup: reliability & security fixes across middleware, chat, admin, jobs

**Why**: re-verification of the v2 platform audit against current main showed 91e8eea fixed
most security findings but left the reliability class open. These are the items fixable
without a DB migration or API-contract change.

**Fixed**
- `authenticate.ts`: the per-request `banStatusCache`/`lastActivityWriteAt` Maps are now
  bounded (50k cap, expired-sweep then FIFO eviction) — was an unbounded leak, one entry per
  distinct user forever.
- `chat.socket.ts`: messages are **persisted before broadcast** and the broadcast carries the
  real DB id (clientMessageId kept for optimistic reconciliation). The old emit-then-save in a
  detached block could show everyone a message that a failed insert then erased. On persist
  failure the sender now gets `chat:messageFailed`. `chat:messageId` still emitted for
  compatibility.
- `chat.socket.ts` CHAT_READ: clears only THIS chat's message notifications (data.matchId /
  data.communityId JSON filter) — reading one thread no longer wipes every chat's badge.
- `couple.service.ts`: block/unblock now atomic in-DB (`array_append` with ANY-guard,
  `array_remove`) — the read-modify-write `set:` lost concurrent blocks, unacceptable for a
  safety feature.
- `match.service.ts` say-hello: P2002 from the `@@unique([couple1Id,couple2Id])` constraint is
  caught and resolved to the existing row instead of surfacing a 500 on concurrent duplicates.
- `admin.service.ts`: `getCityDistribution` selects only city strings (was full rows + join);
  `getCommunities` bounded (take 500) with narrow member/admin/request selects (was every full
  couple row per member); `getReports` bounded + target names resolved in 2 batched queries
  (was 1-2 per report); `getBlocks` resolved in 2 batched queries (was serial per block);
  `getPrompts` bounded.
- `admin.controller.ts`: all 18 raw `err.message` 500 responses replaced by a `failInternal`
  helper — logs the real error, returns a generic message (schema/internals disclosure).
- `rateLimiter.ts` + `cache.ts`: Redis-backed rate-limit store (new atomic `cacheIncrExpire`)
  shared across PM2 workers when REDIS_URL is set — MemoryStore counted per process, making
  the real limit N× the configured one under cluster mode. Fail-open per request on Redis
  errors; without Redis, ecosystem pins instances=1 so MemoryStore remains correct.
- `push.service.ts` `pushToCouples`: chunked 25 couples at a time — an admin broadcast used to
  open ~2N simultaneous FCM calls.
- `cycleNotifier.ts`: cursor-batched scan (500/page) instead of materializing every cycle row.
- `otp.service.ts`: verified-OTP replay window 600s → 90s (covers double-submit/retry; a
  one-time code no longer lives 10 extra minutes).

**Deferred (need a decision / DB access / client coordination)**
- Schema `onDelete` rules + a unique constraint for grouped notifications: require Prisma
  migrations against the real database.
- Pagination (`page`/`limit`/cursor) on chat & notification endpoints: API contract change,
  needs the mobile client updated in step.
- Profile-photo base64-in-JSON path → presigned PUTs (chat media already uses them).
- Admin media-route JWT-in-query: mitigated (role re-check + morgan redaction); a short-lived
  media token is the proper fix and touches the admin panel too.
- `GOOGLE_RTDN_SECRET` has no production-startup assertion — unset means RTDNs are silently
  dropped (fail-closed but invisible).
- **Committed `dist/` is stale vs src** (predates 1ca9dd9): if deploys run the committed dist
  without a build step, production is running old code. Flagged for the team.

## [2026-08-19] — Docs: RULES.md corrected to the real stack; living-document contract added

**Why**: RULES.md §2 described a Mongoose/MongoDB architecture the codebase does not
use (53 files import Prisma, zero import Mongoose), §5 said refresh tokens live in
MongoDB, and a "§11 Frontend UI Rules" section described the mobile app (src/Service/Api.ts,
Redux) — bled in from another repo's rules. Agents and new developers following the file
verbatim would have written Mongoose code against a Prisma/PostgreSQL codebase.

**Changed**
- `RULES.md` §2: layered shape now ends at **Prisma (PostgreSQL)**; documents
  `prisma/schema.prisma` as schema source of truth, the single client in `src/lib/prisma.ts`,
  and `src/models/` as Prisma re-export shims (no Mongoose, no logic).
- `RULES.md` §5: refresh tokens hashed in PostgreSQL; billing webhooks/receipt validation
  flagged as review-sensitive surfaces.
- `RULES.md`: removed §11 (mobile-app rules — now live in the mobile repo's AGENTS.md);
  section numbering fixed (Documentation is §10); added a living-document contract
  ("Last verified" stamp; any commit falsifying a line updates it in the same commit) and
  a history note recording what was removed.
- `README.md` tech stack: MongoDB (Mongoose) → PostgreSQL via Prisma 6; added PM2.

## [2026-03-19] — Phase 0: Initial Scaffold

**Added**
- `server/` directory created as backend root
- `RULES.md` — comprehensive backend rules & conventions (architecture, security, naming, logging)
- `PLAN.md` — master architecture plan with folder structure, data models, full API reference, socket events, and phased implementation roadmap
- `CHANGELOG.md` — this file; tracks all changes

**Express App**
- `src/app.ts` — Express app factory with CORS, helmet, morgan, json parsing, master API router, health check, and global error handler
- `src/server.ts` — HTTP + Socket.io server entry point; graceful shutdown on SIGTERM/SIGINT

**Configuration**
- `src/config/env.ts` — Zod-validated environment variables; app refuses to start if required vars are missing
- `src/config/db.ts` — MongoDB connection with retry logic and connection event logging

**Utilities**
- `src/utils/AppError.ts` — Custom error class with status code, operational flag, and error code support
- `src/utils/asyncHandler.ts` — Wraps async controller functions; catches errors and forwards to Express error handler
- `src/utils/logger.ts` — Winston logger with console (dev) and file (prod) transports; log rotation
- `src/utils/response.ts` — Standardized `sendSuccess()` and `sendError()` response helpers
- `src/utils/jwt.ts` — JWT sign/verify helpers for access and refresh tokens

**Middleware**
- `src/middleware/errorHandler.ts` — Global Express error handler; formats AppError and unexpected errors
- `src/middleware/authenticate.ts` — JWT Bearer token validation; attaches `req.user` to request
- `src/middleware/rateLimiter.ts` — Auth route rate limiter (10 req/15 min per IP)
- `src/middleware/validate.ts` — Zod-based request validation factory

**Models (schemas only — ready for Phase 1)**
- `src/models/User.model.ts` — User schema with phone, email, passwordHash, isPhoneVerified
- `src/models/Couple.model.ts` — Couple schema with partners, profile, answers, preferences
- `src/models/Match.model.ts` — Match schema with status, score, timestamps
- `src/models/Community.model.ts` — Community schema with members, admins, tags
- `src/models/Message.model.ts` — Message schema supporting private and group chat
- `src/models/OtpToken.model.ts` — OTP token schema with TTL index for auto-expiry

**Constants**
- `src/constants/index.ts` — Pagination defaults, limits, OTP config
- `src/constants/socketEvents.ts` — All Socket.io event name constants

**Sockets**
- `src/sockets/index.ts` — Socket.io server factory with JWT auth middleware; delegates to domain handlers
- `src/sockets/chat.socket.ts` — Stub for private/group chat socket events
- `src/sockets/match.socket.ts` — Stub for match notification socket events

**Routes**
- `src/routes/index.ts` — Master API router; mounts all sub-routers
- `src/routes/auth.routes.ts` — Auth route stubs (send-otp, verify-otp, refresh, logout)
- `src/routes/user.routes.ts` — User route stubs
- `src/routes/couple.routes.ts` — Couple route stubs
- `src/routes/match.routes.ts` — Match route stubs
- `src/routes/community.routes.ts` — Community route stubs
- `src/routes/chat.routes.ts` — Chat route stubs

**Controllers**
- `src/controllers/auth.controller.ts` — Auth controller stubs
- `src/controllers/user.controller.ts` — User controller stubs
- `src/controllers/couple.controller.ts` — Couple controller stubs
- `src/controllers/match.controller.ts` — Match controller stubs
- `src/controllers/community.controller.ts` — Community controller stubs
- `src/controllers/chat.controller.ts` — Chat controller stubs

**Services (stubs)**
- `src/services/auth.service.ts`
- `src/services/user.service.ts`
- `src/services/couple.service.ts`
- `src/services/match.service.ts`
- `src/services/community.service.ts`
- `src/services/chat.service.ts`
- `src/services/otp.service.ts`

**Repositories (stubs)**
- `src/repositories/user.repository.ts`
- `src/repositories/couple.repository.ts`
- `src/repositories/match.repository.ts`
- `src/repositories/community.repository.ts`
- `src/repositories/message.repository.ts`

**Types**
- `src/types/express.d.ts` — Augments `Express.Request` with `user` payload
- `src/types/index.ts` — Shared TypeScript types

**Project Config**
- `package.json` — All dependencies and npm scripts (`dev`, `build`, `start`, `lint`, `test`)
- `tsconfig.json` — TypeScript 5 strict config with path aliases
- `.env.example` — All required environment variable keys with descriptions
- `.gitignore` — Excludes `.env`, `node_modules/`, `dist/`, logs

**Git**
- Initialized git repo, connected to `https://github.com/krnkiran22/sawa_server.git`
- Initial commit pushed on `main` branch

## [0.2.0] - 2026-03-18
### Added
- Couple Model updated with exact fields from frontend onboarding flow.
- Added `/api/v1/couples/onboarding/profile` for Phase 2 basic details (both users + relation).
- Added `/api/v1/couples/onboarding/photos` for mock uploading base64 profile pictures.
- Added `/api/v1/couples/onboarding/answers` for saving couple onboarding preferences/questions.

### Changed
- `entityId` fully refactored and renamed to `coupleId` across both the Backend and Mobile App codebases to match original naming intention.
- Mobile frontend screens (ProfileSetupScreen, StoryPhotoScreen, QuestionScreen) wired to the APIs, persisting true data without any UI changes.

### Phase 3 & 4 (Discovery & Communities)
- Added `Match` model and `/api/v1/matches/discovery` feed populated with seed & sorting logic.
- Wired `HomeScreen` to render actual couple cards fetched from backend feed.
- Added `/api/v1/matches/say-hello` and `/api/v1/matches/skip` to allow users to interact with discovery feed.
- Added `Community` model and `/api/v1/communities` API suite for listing discover / yours feeds.
- Seeded default Communities to `CommunityService`.
- Wired `CommunitiesScreen` and `CommunityDetailScreen` to fetch dynamic communities via backend endpoint while respecting initial UI.
