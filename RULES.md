# SAWA Backend — Rules & Conventions

> **Always read this file before making any changes to the backend.**
> Last verified: 2026-08-19 against `bfcddb4`. **Living document**: any commit
> that makes a line here false must update that line in the same commit.

---

## 1. Brand & Identity Rules

- The backend serves the **SAWA** couples social app — a premium, safety-first
  platform for couple-to-couple social matching.
- Brand palette (for emails / push templates): Dark Teal `#1E5559`, Gin Fizz
  `#FFF8E2`, Hickory Gold `#D09B64`, Sweet Orange `#F7C3A6`.
- Do NOT alter the brand name, colors, or tone in any API response messages.
  Keep messaging warm, inclusive, and pair-focused.

---

## 2. Architecture Rules

- **No architecture changes** without updating `PLAN.md` first and adding an
  entry in `CHANGELOG.md`.
- Follow the **layered architecture** strictly:
  ```
  Route → Controller → Service → Repository → Prisma (PostgreSQL)
  ```
- The database is **PostgreSQL via Prisma 6**. The schema lives in
  `prisma/schema.prisma` — it is the single source of truth for data shape.
  Schema changes go through Prisma migrations, never manual SQL against prod.
- The Prisma client is created once in `src/lib/prisma.ts` — import it from
  there, never instantiate a second client.
- `src/models/` contains **Prisma re-export shims** that preserve legacy
  import patterns (e.g. `Couple = prisma.couple`). Do not add Mongoose, do not
  add real logic there; new code should import from `src/lib/prisma` or go
  through repositories.
- **Never** put business logic in a route file or model file.
- **Never** query the DB directly from a controller — always go through the
  service layer.
- All database operations must live in `src/repositories/`.
- All business logic must live in `src/services/`.
- All HTTP handlers must live in `src/controllers/`.
- All route definitions must live in `src/routes/`.

---

## 3. Code Quality Rules

- Use **TypeScript** for all source files. No `.js` source files.
- All functions must have explicit return type annotations.
- All async functions must use `async/await` — no raw Promise chains.
- Use `zod` for all request body & query param validation in controllers.
- Errors must be thrown using the custom `AppError` class
  (`src/utils/AppError.ts`).
- Use the central `asyncHandler` wrapper for all controller functions.
- Constants go in `src/constants/` — never use magic strings/numbers inline.
- **DRY across layers**: before adding a helper, query, or validation shape,
  search `src/utils/`, `src/repositories/`, and `src/constants/` for an
  existing one and extend it. Duplicated queries drift and become bugs.

---

## 4. API Rules

- All routes are prefixed with `/api/v1/`.
- Responses must follow this shape:
  ```json
  { "success": true, "data": {}, "message": "..." }
  { "success": false, "error": "...", "code": 400 }
  ```
- HTTP status codes must always be semantically correct.
- Pagination: use `page` + `limit` query params. Max `limit` is 100.
- All list endpoints must return `{ data: [], total, page, limit }`.

---

## 5. Auth & Security Rules

- JWT access tokens expire in **15 minutes**. Refresh tokens expire in
  **30 days**.
- Refresh tokens are stored **hashed** in PostgreSQL.
- Never log or expose JWT secrets, passwords, or phone numbers in plain text.
- Passwords must be hashed with `bcrypt` (min 12 rounds).
- Phone numbers must be verified via OTP before account activation.
- Every protected route must use the `authenticate` middleware.
- Rate limiting is **mandatory** on auth endpoints (`/auth/*`).
- CORS origins must be whitelisted — no wildcard `*` in production.
- Billing: Google Play Billing RTDN webhooks and Apple receipt validation
  (public root certs in `certs/apple/`) are security surfaces — changes there
  require extra review and a CHANGELOG entry explaining the why.

---

## 6. Real-Time (Socket.io) Rules

- Socket events must be defined in `src/constants/socketEvents.ts`.
- All socket handlers must authenticate via JWT on the `auth` handshake object.
- Rooms follow the naming pattern:
  - `chat:${chatId}` — private chat
  - `group:${groupId}` — community group chat
  - `match:${matchId}` — match notification room
- Socket payload shapes are a **contract with the mobile app** — never change
  one without confirming every mobile emit/listen site matches.

---

## 7. File & Naming Conventions

- Files: `camelCase.ts` for utilities/services, `PascalCase.ts` for model shims.
- Route files: `featureName.routes.ts`
- Controller files: `featureName.controller.ts`
- Service files: `featureName.service.ts`
- Repository files: `featureName.repository.ts`
- Model shim files: `FeatureName.model.ts`
- Type/Interface files: `featureName.types.ts`

---

## 8. Environment & Config Rules

- **Never commit `.env` files.** Use `.env.example` only.
- **Never commit `node_modules/` or `dist/`.** Build output does not belong
  in git.
- All environment variables must be validated at startup via
  `src/config/env.ts` — it is the authoritative list of required vars.
- The app must not start if required env vars are missing. Never invent or
  stub env values to force a boot.

---

## 9. Logging Rules

- Use the centralized logger (`src/utils/logger.ts`, Winston) — no raw
  `console.log` in production code.
- Log levels: `error`, `warn`, `info`, `debug`.
- HTTP requests are automatically logged by the `morgan` middleware.
- Sensitive data (tokens, passwords, OTP codes) must NEVER appear in logs.

---

## 10. Documentation Rules

- **Every change must be logged** in `CHANGELOG.md` with date, author context,
  and description — why first, then what.
- `PLAN.md` must be kept up-to-date with architecture decisions.
- New API endpoints must be documented in `PLAN.md` under the API Reference
  section.
- `README.md` contains only setup/run instructions — not architecture docs.
- This file follows the living-document contract at the top.

---

## History note (2026-08-19)

Two long-standing inaccuracies were removed from this file: §2 described a
Mongoose/MongoDB stack the codebase does not use (53 files import Prisma, zero
import Mongoose), and a "§11 Frontend UI Rules" section described the mobile
app's `src/Service/Api.ts`/Redux — it had bled in from another repo's rules and
now lives where it belongs, in the mobile repo's `AGENTS.md`.
