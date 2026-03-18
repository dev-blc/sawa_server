# SAWA Server — Change Log

> **Every change must be recorded here.** Format: `## [YYYY-MM-DD] — Description`

---

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
