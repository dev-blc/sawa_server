# SAWA Backend — Rules & Conventions

> **Always read this file before making any changes to the backend.**
> Last verified: 2026-08-19 against `arfam-fix` `42bbf2c`. **Living document**:
> any commit that makes a line here false must update that line in the same
> commit and bump this stamp.
>
> **Priority order: design first, performance second, security third.** That is
> the order of attention and tie-breaks, not permission to skip anything below —
> every security rule here is still a hard requirement. Facts in this file are
> verified against code at file:line. Where the codebase does not yet meet a
> rule, the gap is named as **baseline debt**: never add to it, shrink it in
> any code you touch.

---

## 1. Design rules — the server is part of the felt product

- The backend serves **SAWA**, a premium couples social app: one private space
  per couple plus couple-to-couple discovery. The taste test applies to
  everything user-visible the server produces (API messages, push, email):
  *a quiet gift between two people, never an app shouting at a user.*
- Brand palette for email/push templates: Dark Teal `#1E5559`, Gin Fizz
  `#FFF8E2`, Hickory Gold `#D09B64`, Sweet Orange `#F7C3A6`. Do not alter the
  brand name, colors, or tone in any API response or notification. Warm,
  inclusive, pair-focused; no urgency mechanics, no guilt copy.
- **The API contract is a design surface.** Every response goes through the
  helpers in `src/utils/response.ts` — shape `{ success: true, data, message }`
  on success, `{ success: false, error, code }` on failure. Never hand-roll a
  `res.json()` shape in new code.
- **Error messages are user-facing copy.** Throw `AppError`
  (`src/utils/AppError.ts`) with a message a person can read. Internals,
  stack details, and DB errors never reach the client.
- Response shapes and socket payloads are **contracts with the mobile app**.
  Never change one without checking every mobile consume/emit/listen site in
  the same change.
- HTTP status codes are always semantically correct.

## 2. Performance rules

- **Hot read paths cache through `src/lib/cache.ts`** (Redis with an in-process
  fallback). Its contract is law: TTLs stay short (5–60s), every write path
  that mutates a cached value calls `invalidate()`, and correctness is never
  traded for speed. No second caching mechanism.
- **Anything entitlement- or billing-shaped is never decided from a cache**
  (the-floor.md P6: money fails closed).
- **Shape Prisma queries to the response.** Use `select`/`include` for what the
  client actually needs — this is a performance rule and a security rule (§3).
  No unbounded `findMany` on a list path.
- The schema carries its indexes (42 `@@index` today). A new query pattern adds
  its index in the same migration.
- `compression()` is on; JSON body limit is 10mb (base64 onboarding photos —
  documented in `src/app.ts`). Do not raise it; move anything bigger to proper
  uploads.
- Realtime goes over sockets. Do not add HTTP polling for state a socket
  already pushes.
- Performance claims are **measured, never estimated** (the-floor.md P1).

## 3. Security rules

- **Login is OTP-only — users have no passwords.** OTP codes are CSPRNG
  (`crypto.randomInt`, `src/services/otp.service.ts`), never `Math.random`.
  `BYPASS_PHONES` is ignored in production unless `BYPASS_PHONES_ALLOW_PROD`
  is explicitly set (`src/services/auth.service.ts`) — keep it that way.
- **JWT lifetimes are env-driven**: `JWT_ACCESS_EXPIRES_IN` (code default `7d`)
  and `JWT_REFRESH_EXPIRES_IN` (default `90d`) in `src/config/env.ts`.
  Changing them is a product/security decision that goes through `PLAN.md`,
  not a silent edit.
- **Refresh tokens are stored hashed** and compared constant-time
  (`src/services/auth.service.ts`). Never store or log a raw token.
- Admin credentials hash with bcrypt (cost 10 today, `bootstrapAdmin.ts`);
  raise to 12 on the next commit that touches admin auth.
- Every protected route uses the `authenticate` middleware. Identity comes
  **only from the verified token, never from the request body**
  (the-floor.md S2).
- **Rate limiting is mandatory on `/auth/*`** (`authRateLimiter` — wired),
  including `/invite-partner`, which spends Twilio money (the-floor.md S3).
  Never remove a limiter to "fix" a UX complaint.
- **Paid surfaces gate server-side** through `requireEntitlement`
  (wired on community create/join and match routes). The client never decides
  entitlement. The app's IAP surface stays removed until a compliant flow
  ships (the-floor.md S1, R1).
- **Never return more than the client needs**: explicit response shaping,
  never spread a DB row into a response (the-floor.md S8).
- CORS origins come from `CORS_ORIGINS` env, whitelisted — no wildcard.
- Billing surfaces — Google Play RTDN webhooks, Apple receipt validation,
  `certs/apple/` — get extra review and a why-first `CHANGELOG.md` entry for
  any change.
- Secrets never live in the repo; an exposed credential gets **rotated, not
  argued about** (the-floor.md S5). Tokens, passwords, OTP codes, and phone
  numbers never appear in logs; `morgan` logs through the sanitized `safeurl`
  token — keep it.

## 4. Architecture rules

- Layered, strictly:

  ```text
  Route → Controller → Service → Repository → Prisma (PostgreSQL)
  ```

- **PostgreSQL via Prisma 6.** `prisma/schema.prisma` is the single source of
  truth for data shape; changes go through Prisma migrations, never manual SQL
  against prod.
- One Prisma client, created in `src/lib/prisma.ts` — import it from there.
  (Standalone one-shot scripts under `src/scripts/` may create their own
  short-lived client; server code never does.)
- `src/models/` contains **Prisma re-export shims** only (e.g.
  `Couple = prisma.couple`) preserving legacy imports. No Mongoose, no logic
  there; new code imports from `src/lib/prisma` or goes through repositories.
- No business logic in route or model files. HTTP handling in
  `src/controllers/`, business logic in `src/services/`, DB access in
  `src/repositories/`, route definitions in `src/routes/`.
- **Baseline debt (2026-08-19):** 6 of 9 controllers still hit `prisma`
  directly, and most services query without a repository (only 5 repositories
  exist). New endpoints follow the full layering; when you touch a legacy
  path, move it one layer closer to the rule. Never add a new direct-prisma
  call in a controller.
- No architecture changes without updating `PLAN.md` first and logging why in
  `CHANGELOG.md`.

## 5. API rules

- All routes prefixed `/api/v1/`.
- Envelope per §1, via `src/utils/response.ts`.
- **Pagination convention for new list endpoints** (no current endpoint
  paginates — that is the baseline): `page` + `limit` query params, `limit`
  capped at 100, response `{ data, total, page, limit }`. Any new or touched
  list endpoint that can grow unbounded adopts this.

## 6. Real-time (Socket.io) rules

- Event names live in `src/constants/socketEvents.ts`.
- Every socket authenticates via JWT on the handshake, and membership is
  checked before any room join (the-floor.md S2).
- Rooms that exist today: `chat:${chatId}` and `couple:${coupleId}`. New rooms
  follow the `noun:${id}` pattern and get added to this list in the same
  commit.
- Socket payload shapes are a contract with the mobile app (§1).

## 7. Code quality rules

- **TypeScript only** — zero `.js` files in `src/` (verified). Exported
  functions in new code carry explicit return types.
- **zod validation** through `src/middleware/validate.ts` for request bodies
  and query params. Wired on auth, chat, community, match, and couple.
  **Baseline debt:** admin, notification, subscription, and user controllers
  predate it — any endpoint you touch there gets zod in the same change.
- **`asyncHandler`** (`src/utils/asyncHandler.ts`) wraps controllers at the
  route layer. Wired in 8 of 13 route files; `admin`, `prompt`, `report`, and
  `us` routes are baseline debt — wrap when touched.
- Errors thrown as `AppError`; `async/await` only, no raw promise chains.
- Constants in `src/constants/` — no magic strings/numbers inline.
- **DRY across layers**: before adding a helper, query, or validation shape,
  search `src/utils/`, `src/repositories/`, and `src/constants/` for an
  existing one and extend it.
- **No new `console.log`** — use the Winston logger (`src/utils/logger.ts`,
  levels `error`/`warn`/`info`/`debug`). ~53 legacy `console.log`s remain in
  `src/`; burn them down opportunistically, never add one.

## 8. File & naming conventions

- Files: `camelCase.ts` for utilities/services, `PascalCase.ts` for model shims.
- `featureName.routes.ts` / `featureName.controller.ts` /
  `featureName.service.ts` / `featureName.repository.ts` /
  `FeatureName.model.ts` / `featureName.types.ts`.

## 9. Environment & config rules

- All env vars validated at startup by `src/config/env.ts` — the authoritative
  list. The app refuses to boot if required vars are missing; **never invent
  or stub values to force a boot.**
- **Never commit `.env`**, `node_modules/`, or `dist/`.
- There is **no `.env.example` yet** (known workspace blocker). Creating one —
  keys only, no values, generated from `env.ts` — is an open task; until then,
  `env.ts` is the setup reference.

## 10. Documentation rules

- **Every change is logged in `CHANGELOG.md`** — why first, then what — and in
  the workspace `changelog.md` for cross-repo context.
- `PLAN.md` holds architecture decisions and the API reference; new endpoints
  get documented there.
- `README.md` is setup/run only.
- This file follows the living-document contract at the top. Baseline-debt
  counts in §4/§7 are part of that contract: a commit that clears one updates
  the count.

---

## History notes

**2026-08-19 (evening) — regenerated against verified code.** The previous
revision carried six claims the code contradicted: JWT lifetimes stated as
15m/30d (env defaults are 7d/90d), fictional `group:`/`match:` socket rooms
(real rooms: `chat:`, `couple:`), "bcrypt min 12 rounds" (cost is 10,
admin-only — users are OTP-only with no passwords), "asyncHandler for all
controller functions" (it wraps at the route layer, and only in 8 of 13 route
files), a pagination spec no endpoint implements, and "use `.env.example`"
when none exists. Rules the codebase doesn't yet meet are now explicitly
marked baseline debt instead of reading as false descriptions. File
restructured design → performance → security per the workspace priority order.

**2026-08-19 (morning)** — removed two long-standing inaccuracies: §2 described
a Mongoose/MongoDB stack the codebase does not use (53 files import Prisma,
zero import Mongoose), and a "§11 Frontend UI Rules" section that had bled in
from the mobile repo's rules (now in `sawa/AGENTS.md`).
