# SAWA Server — Change Log

> **Every change must be recorded here.** Format: `## [YYYY-MM-DD] — Description`

---

## [2026-08-20] — Planned dates become editable (PATCH + date_edit/date_delete relay copy)

**Why:** Arfam's calendar workstream — a created plan had no edit path anywhere (no route, no
service function, no UI), and a deleted plan never reached the partner in real time (no relay,
and the mobile merge was additive-only so ghosts persisted forever). Mobile half lands on
`sawa` `arfam-fix` (`c33abe51`).

**What:**

- **`PATCH /us/planned-dates/:id`** (`us.routes.ts`, `authenticate` + `idempotency` +
  `asyncHandler`) → new `updatePlannedDate` in `us.service.ts`. **Update-only, deliberately
  never upsert**: a date request the partner hasn't accepted exists only on the creator's
  device, and an edit must not create the server row (that would sidestep acceptance) — missing
  row 404, foreign couple 403 (same ownership guard as `savePlannedDate`). `rawDate` validated
  `YYYY-MM-DD`; `time`/`note` clear on empty string, untouched when absent. Standard envelope.
- **`us:nudge` copy branches** (`us.socket.ts`): `date_edit` gets a real notification row +
  localized push (`us.date.edit` added to `i18n/notif.ts`, 4 locales) instead of falling
  through to the generic "sent you a nudge" push; `date_delete` is relay-only by design —
  housekeeping, not a moment: no row, no badge poke, no push (the partner's next focus fetch
  reconciles offline devices).
- PLAN.md API table updated.

**Gates:** tsc 0 errors, 12/12 suites (79 tests) green.

---

## [2026-08-20] — Push contract unified + notification lifecycle (game invites can finally land)

**Why:** the tap-routing contract was split three ways and the app could not honor it. A game
challenge's DB row said `navigate:'UsSpace'` while its push said `navigate:'Notifications'`;
the mood event had three names (`us_mood` row / `us_mood` socket / `us_feeling` push); fridge
pushes dropped the `noteId` the row carried; and resolved interactions (accepted game
challenges, rejected/blocked/unfriended matches) left their notification rows behind as dead
taps — the direct cause of Arfam's "game invite opens a blank screen" report, together with the
app-side routing fixes landing on mobile `arfam-fix`.

**What:**

- **One vocabulary on the wire**: every Us-space/job push now carries `subtype` mirroring the
  DB row's `data.subtype` (`us.socket.ts` nudge/love/mood/game blocks, `us.service.ts`
  ask/fridge/cycle, all four jobs). `type` stays for older clients. Fridge pushes now include
  `noteId`; game pushes and mood/cycle/date-reminder pushes now say `navigate:'UsSpace'` (old
  clients fall back to the Notifications list exactly as before — additive, no breakage).
- **Challenge rows die with their session**: `us:game:accept` and `us:game:quit` call
  `clearGameChallengeNotification` (subtype+gameId scoped, result rows survive) and emit
  `notification:new` so an open list refreshes. A stale "Tap to accept and play!" can no longer
  outlive its game.
- **Match cleanup**: `rejectMatch` now clears the deleted matches' notifications (previously a
  rejected request's row survived and a later tap silently re-sent a hello via the
  acceptMatch→sayHello fallthrough); `blockCouple`/`unfriendCouple` clear match/message rows for
  the removed matches (the dead `clearNotificationsForMatch` helper is finally wired).
- **Honest iOS badge**: APNs `badge` was hardcoded `1` forever; now it is the recipient's real
  unread count (same filter as the unread endpoint, floor 1, per-partner).
- **CHAT_READ badge staleness**: marking a thread read now busts the unread cache (was serving
  a stale count for up to the 10 s TTL).
- Suite: 81/81 green; tsc clean.

---

## [2026-08-20] — Notifications: clear endpoints, self-sent exclusion, per-user badge counts

**Why:** the notification surface had no way to clear anything (no DELETE routes existed), and
the badge math was wrong in two ways Arfam hit directly: a partner's own hugs/moods counted
toward their own unread badge (rows are couple-scoped; the sender's identity lives only in
`data.senderUserId`, and neither the list nor the count excluded it), and opened notifications
stayed in the list forever.

**What:**

- **Soft-clear, not delete** — new `clearedAt DateTime?` on `Notification`
  (+ `@@index([recipientId, clearedAt])`). Cleared rows leave the list/unread endpoints but stay
  in the table, because `us_mood` Notification rows double as the durable mood-history source
  (`us.service.ts getMoodHistory`) and a hard delete would silently erase that record. Schema is
  additive — `prisma db push` applies it with no data risk.
- **New routes** (both `authenticate`-scoped to the caller's couple, idempotent):
  `DELETE /api/v1/notifications/:id` (clear one) and `DELETE /api/v1/notifications` (clear all),
  via new `clearNotification` / `clearAllNotifications` in `notification.service.ts`. Clearing
  also marks read and busts the badge cache.
- **zod on the touched controller** (RULES §7 debt): `:id` params validated
  (`validateNotificationIdParams`) on both the new DELETE and the existing `PATCH /:id/read`.
  Notification controller removed from the §7 baseline-debt list.
- **Self-sent exclusion**: `GET /notifications` and `GET /notifications/unread-count` now filter
  `NOT data.senderUserId = <caller>` — your own sends can no longer inflate your own badge or
  appear in your list (the app was already client-filtering the list; now the server agrees).
- **Per-user unread cache**: cache key becomes `sawa:notif:unread:{coupleId}:{userId}` (partners
  legitimately see different counts now); `invalidateNotifUnreadCount(coupleId)` keeps its
  signature and pattern-deletes both partners' keys.
- `upsertGroupedNotification` now bumps `createdAt` and un-clears on update — a re-notified
  grouped row (new message in an old thread, a fresh hug) surfaces at the top instead of sinking
  under its original timestamp. `clearNotificationsForMatch` now busts affected badge caches.
- New `clearGameChallengeNotification(coupleId, gameId)` — wired in the game lifecycle commit.
- Tests: `src/__tests__/notification.routes.test.ts` (7) — IDOR scoping, idempotency, zod 400,
  self-sent/cleared exclusions, per-user caching. Suite: 81/81 green.
- RULES.md: corrected the brand-palette line (§1 carried the sister project's palette — now the
  real SAWA palette + the white-on-avocado ban) and the §7 zod debt list.

---

## [2026-08-20] — Idempotency middleware for the couple's core writes (offline-lite server half)

**Why:** the mobile app is gaining an offline queue that replays writes on reconnect. Without
server dedup, a replayed create (a fridge note, a planned date) would double-apply. This is the
safety half of the contract.

**What:** new `src/middleware/idempotency.ts` — reads the `Idempotency-Key` header, keys by
authenticated identity + key, and (a) replays the stored 2xx response verbatim on a repeat,
(b) `cacheSetNX`-locks a first-seen key so concurrent duplicates don't both run (409 the loser),
(c) stores the success for 24h (matches the client queue's max lifetime). **Fails open** — any
cache error calls `next()`, never blocks a write. Requests without the header are untouched, so
normal online writes are unaffected. Applied to the five whitelisted `/us` writes the client
queues: `POST /my-feeling`, `POST /planned-dates`, `POST /ask-feeling`, `POST /fridge-notes`,
`PATCH /fridge-notes/:id/ack`. 5 new unit tests (replay, lock, fail-open); 74 tests green.

## [2026-08-20] — Us-space honest layering, cursor pagination, .env.example, LOW security fixes

**Why**: five audit/debt items. (1) The **entire** Us feature (feelings, planned
dates, fridge notes, cycle, games — ~27 direct Prisma calls) lived inside the
route file, violating the Route→Controller→Service layering (RULES §4). (2) Three
list reads were unbounded or fixed-`take` with no pagination (RULES §2 "no
unbounded findMany", §5), a scaling and payload risk on chat history + planned
dates. (3) No `.env.example` existed — the standing workspace setup blocker; the
server refuses to boot without required env and gave newcomers no key list.
(4) Three LOW findings: the Google RTDN webhook secret was compared with `===`
(a timing side channel), the **public** couple profile card leaked both partners'
full **date of birth** to any other couple (needless PII — only age is shown),
and account deletion left orphaned S3 media + `us:*` Redis keys behind. (5) A
mobile follow-up needed the primary-photo presign path verified.

**What changed**:

- **Us-space service extraction (honest layering)** — new
  `src/services/us.service.ts` holds all DB/business logic + socket emits + pushes
  for the `/us` surface; `src/routes/us.routes.ts` is now a thin HTTP layer
  (validate context → call service → shape response). **833 → 391 lines; ~27
  direct `prisma.*` calls in the route file → 0.** Behaviour is **byte-identical**
  — this was a move, not a rewrite: same endpoints, same auth middleware, same
  socket event names/payloads (`us:ask-feeling`, `us:fridge-note`,
  `us:cycle:updated`, `notification:new`), same response shapes, same
  `[UsRoutes]` 500 copy. Business rejections (429 cooldown, 403 not-partner /
  not-owner, 404/400 on fridge ack) now throw `AppError` from the service and the
  route's existing try/catch maps them to the **exact** prior status+body. The
  explicit per-handler try/catch is deliberately **kept** (not swapped to
  `asyncHandler` + the global handler) precisely to preserve those wire shapes —
  the mobile contract (RULES §1) outranks the asyncHandler tidy-up here.
- **Cursor pagination (v2-deferred), additive + backward-compatible** — new
  `src/utils/cursor.ts` (opaque base64url `[key,id]` keyset cursor + `clampLimit`,
  cap 100). Applied to the three unbounded/fixed reads; every existing field
  stays put, only `nextCursor` (+ optional `?cursor=&limit=`) is added:
  - `getPrivateMessages` (`chat.controller`): was fixed `take:100`. Now
    `data:{ matchId, messages, nextCursor }`, **default limit 50**, keyset over
    `(createdAt,id)` walking backwards into history. `messages` unchanged.
  - `GET /us/planned-dates`: was an **unbounded** `findMany`. Now bounded
    (default 100) + `nextCursor` as a **top-level sibling** of the `data` array
    (array stays an array so the app keeps reading `data.data`), order unchanged
    (earliest `rawDate` first).
  - `GET /us/fridge-notes`: default 30 (matches the write-side hard cap) +
    sibling `nextCursor`, newest-first unchanged.
  - Contract + **mobile follow-up** documented in `PLAN.md` → API Reference →
    "Cursor pagination". Follow-up: adopt `cursor`/`limit` on chat (the default
    dropped 100→50) and load older messages on demand; the planned/fridge changes
    need no app change.
- **`.env.example` created** (repo root) — generated from the authoritative
  `src/config/env.ts` (all **59** vars, verified 1:1, no omissions/extras),
  grouped by concern, `[REQUIRED]` (`DATABASE_URL`, `JWT_ACCESS_SECRET`,
  `JWT_REFRESH_SECRET`, `GROQ_API_KEY`) vs `[optional]` marked, placeholders only
  (no real secrets). `.gitignore` already permits it (ignores `.env`, not
  `.env.example`). Clears the workspace setup blocker; RULES §9 gap noted for a
  later stamp.
- **LOW security fixes**:
  - *Constant-time webhook secret* — `subscription.controller.googleNotifications`
    (~:291/:297) now compares `GOOGLE_RTDN_SECRET` via new
    `src/utils/timingSafeEqualStr` (length-guarded `crypto.timingSafeEqual`)
    instead of `===`/`!==`, closing the timing oracle (billing surface, RULES §3).
  - *Age, not DOB, on the public card* — `couple.service.getCoupleSummary`
    (~:507) now maps each partner's `dob` → a computed integer `age`
    (`src/utils/age.ts`, extracted from `couple.controller` so the 18+ gate and
    the card share one parser — RULES §7 DRY) and drops the raw DOB. Only
    `getCoupleById` consumes this (verified); the private own-profile path
    (`getCouple`) still returns DOB for profile editing. **Mobile follow-up:** the
    public profile card must read `partner1.age`/`partner2.age` (integer|null)
    instead of `.dob`.
  - *Account-deletion completeness* — `couple.service.deleteMyCouple` (~:733) now,
    **after** the DB transaction commits, fires best-effort (never blocks/fails
    the deletion) cleanup of orphaned side-channel data: the couple's S3 media
    (new `deleteCoupleMedia` → `deleteByPrefix` in `lib/storage.ts`, clearing
    `image/<couple>/` + `voice/<couple>/`) and its Redis Us-state keys
    (`cacheInvalidatePattern('us:feeling:<id>:*')` + `us:ask_feeling:<id>:*`),
    each with error logging.
- **Primary-photo presign readiness (verify only, no change)** — confirmed
  `couple.service.uploadPhotos` (:176) and `updateProfile` (:342) route the
  primary photo through `materializeImageLoose`, which passes `http…` and
  `/img/…` URLs through **unchanged** (only raw base64 is wrapped). So the server
  already accepts a URL primary photo: the mobile flip off base64 is genuinely a
  one-line change (send the presigned/proxy URL). **Verdict: READY.**
- **Tests** — new pure-unit suites (no prisma/network): `cursor.test.ts` (encode/
  decode round-trip, garbage/opaque handling, `clampLimit` bounds),
  `timingSafeEqual.test.ts` (equal / unequal / length-mismatch / non-string /
  multibyte), `age.test.ts` (ISO + DD/MM/YYYY parse, unreached-birthday, null
  cases). Gates: `npm run typecheck` **0 errors**, `npm test` **10 suites / 69
  tests green**. (`npm run lint` is a pre-existing no-op — the repo ships no
  ESLint config; unrelated to this change.)

## [2026-08-20] — SMS abuse guard-stack + logout access-token revocation (H4)

**Why**: the platform's #1 financial risk plus an auth-containment gap.
(1) `/auth/send-otp` (which sends TWO SMS per call), `/auth/login-send-otp`,
`/auth/resend-otp` and `/auth/invite-partner` are unauthenticated endpoints
that spend real Twilio money, protected only by a per-IP burst limiter
(10/15min) that IP rotation walks straight past — the exact shape of a prior
real SMS-pumping attack at the sister company. (2) Access JWTs live
`JWT_ACCESS_EXPIRES_IN` (7d default) and logout only cleared the refresh hash,
so a stolen access token stayed valid for up to a week after logout (audit H4).

**What changed**:

- **SMS abuse guard** (`src/services/abuseGuard.ts`, new; wired inside
  `otp.service.ts` at the single Twilio funnel — `generateAndStore` +
  `sendInvitation` — so BOTH the OTP routes and invite-partner pass through it,
  and no future caller can bypass it). Layers, all evaluated before any send,
  each with its own Redis day-bucketed key + TTL: corridor allowlist
  (`SMS_ALLOWED_PREFIXES`, default `+91` — India market; out-of-corridor →
  400 `SMS_REGION_UNSUPPORTED`), per-phone daily cap (`SMS_PHONE_DAILY_CAP` 6),
  per-8-digit-E.164-prefix daily cap (`SMS_PREFIX_DAILY_CAP` 30 — one prefix =
  a 10k-number block; catches sequential-range pumping), per-IP daily budget
  (`SMS_IP_DAILY_CAP` 20, on top of the burst limiter), and a global daily
  kill-switch (`SMS_DAILY_GLOBAL_CAP` 2000 → 503 `SMS_TEMPORARILY_UNAVAILABLE`)
  **incremented LAST, only after every other check passes**, so refused probes
  can't drain the platform budget. Cap refusals share ONE uniform 429
  (`SMS_LIMIT_REACHED`) so callers never learn which layer tripped. Counters
  ride `cacheIncrExpire`; Redis outage degrades to per-process counters
  (bounded workers × cap), never unbounded spend, never a login outage; the
  corridor check is stateless and always enforced. First trip of any layer per
  UTC day (new `cacheSetNX` in `lib/cache.ts`) → structured `logger.error` +
  fire-and-forget POST to optional `ALERT_WEBHOOK_URL` (never blocks/fails the
  request). Signup calls `precheckSmsSendAllowed` (read-only) BEFORE creating
  couple/user rows or sending the first of its two SMS, so refused probes leave
  no junk rows and no half-sent pairs. `req.ip` (real client — `trust proxy` is
  set) threads controller → service → guard. Phones are masked in every new
  log line (RULES §3), and the touched legacy `[OtpService]` lines now mask too.
  Pure helpers unit-tested (`src/__tests__/abuseGuard.test.ts`, 15 tests).
- **Logout revokes access tokens** (`services/tokenDenylist.ts` new,
  `utils/jwt.ts`, `middleware/authenticate.ts`, `sockets/index.ts`,
  `auth.service.logout`). **Decision: the 7d access TTL is deliberately
  unchanged** — the admin panel authenticates with the same access tokens and
  has no refresh flow, so shortening it would break admin sessions (a
  concurrent edit that defaulted it to 1h was reverted for this recorded
  reason; changing lifetimes goes through PLAN.md per RULES §3). Containment is
  Redis-side on two axes, checked in parallel by `authenticate` AND the socket
  handshake, 401/rejected with `TOKEN_REVOKED`: (a) per-token `jti` denylist —
  every access token now carries a `jti` (uuid), and logout denylists the
  presented token for its remaining lifetime; (b) per-user watermark — logout
  stores an issued-before cutoff (TTL = access lifetime + 60s skew margin), so
  EVERY token issued before the logout dies, including older copies an attacker
  holds from before a refresh rotation (the case a jti-only deny misses).
  Same-second re-login stays valid (strict `iat <` compare). Fail-open on Redis
  outage — bounded by token `exp`, and refresh is already dead (hash cleared).
  Token metadata rides a new `req.accessToken` (types/express.d.ts) instead of
  widening `req.user`, whose shape is declaration-merged in 3 files (fixing the
  TS2717 the previous concurrent edit introduced in `adminAuth.ts` — without
  touching that file).
- **Env** (`config/env.ts`): new optional-with-defaults `SMS_ALLOWED_PREFIXES`,
  `SMS_PHONE_DAILY_CAP`, `SMS_PREFIX_DAILY_CAP`, `SMS_IP_DAILY_CAP`,
  `SMS_DAILY_GLOBAL_CAP`, `ALERT_WEBHOOK_URL` — boot is unaffected. Removed a
  concurrently-added duplicate SMS-guard var block (`SMS_PER_PHONE_HOURLY_CAP`
  et al.) that referenced a `src/middleware/smsGuard.ts` which was never
  created and had zero code references — one guard, one config vocabulary.
- **Out of scope, noted**: WhatsApp notification mirrors
  (`whatsapp.service.ts`) are a separate channel (not SMS) with their own
  master switch and exclusion list; they do not pass this guard.

**Gates**: `tsc --noEmit` clean (was 1 pre-existing error from the concurrent
jti edit, now 0); all 47 unit tests pass (15 new). `npm run lint` cannot run in
this repo — no ESLint config file exists (pre-existing, repo-wide).

---

## [2026-08-20] — Security hardening: flush guard, bidirectional block, cycle-push privacy, presign validation

**Why**: four v3 audit findings where one leaked admin token, a fat-finger, a
harassment attempt, or an oversized/mistyped upload could cause damage far out
of proportion to the input. Each is verified at file:line against current code.

1. **B3/H2 — `POST /admin/flush-database` had NO guard.** It runs
   `TRUNCATE … RESTART IDENTITY CASCADE` on every table. A leaked/pasted admin
   token, or a mis-click, wiped the entire database — in production — with no
   confirmation and no attribution.
2. **M2 — one-directional block (harassment vector in a couples app).**
   `getDiscoveryFeed` and `sayHello` filtered only the requester's OWN
   `blocked[]`. A couple that BLOCKED the requester still surfaced in the
   requester's feed and could still receive a "say hello" — the block did not
   protect the person who set it.
3. **M5 — menstrual-cycle phase leaked to third parties (India DPDP).** The
   cycle nudges (`cycleNotifier.ts`) and the "shared her cycle calendar" push
   (`POST /us/cycle`) put the specific phase/prediction in the FCM/APNs/Twilio
   push BODY — shown on a locked screen and transiting Google/Apple/Twilio.
   Menstrual data is sensitive personal data under the DPDP Act.
4. **M6 — chat presign accepted anything, unbounded.** `POST /chats/upload-url`
   accepted any 3–100 char `contentType`, and the presigned PUT set no size
   limit. That PUT streams straight to object storage, bypassing the app's 10mb
   JSON body cap, so a valid token could push an arbitrary MIME at an arbitrary
   size directly into the bucket.

**What changed**:

- **Flush-database guarded** (`admin.controller.ts`, `config/env.ts`). Default
  posture is REFUSE. A typed confirmation `?confirm=FLUSH-ENTIRE-SAWA-DATABASE`
  is now required in EVERY environment. In **production** the flush additionally
  demands the deploy-level flag `ALLOW_PROD_DB_FLUSH=true` (new zod env var,
  default `false`); without it the endpoint hard-refuses (403
  `FLUSH_DISABLED_IN_PROD`), and with it but no/wrong phrase → 403
  `FLUSH_CONFIRM_REQUIRED`. Non-prod without the phrase → 403
  `FLUSH_CONFIRM_REQUIRED`. Every refusal and the actual execution log at
  `error`/`warn` with the acting admin's id (`req.user.userId`). Admin 2FA is a
  larger, separate task — recommended follow-up, not built here.
- **Bidirectional block** (`match.service.ts`). (a) Discovery `where` gains
  `NOT: { blocked: { has: me.coupleId } }` — couples that blocked us now
  disappear from our feed. `has` compiles to the array-contains operator served
  by the existing GIN index (`schema.prisma @@index([blocked], type: Gin)`), so
  no sequential scan; all other feed filters are byte-identical. (b) `sayHello`
  and `acceptPendingMatchRecord` (the single choke point for both the accept
  endpoint and the mutual-like race path) now reject with a neutral `403 BLOCKED` when
  EITHER side blocked the other — one message ("This connection is not
  available"), never leaking which direction. `blocked` added to `sayHelloSelect`
  for the guard. Unit-tested (`src/__tests__/match.block.test.ts`, 4 tests).
- **Cycle-push privacy** (`cycleNotifier.ts`, `us.routes.ts`, `i18n/notif.ts`).
  New neutral i18n key `cycle.neutral` (all 4 locales: en/hi/kn/mr) — "A gentle
  update in your space" / "Open Sawa to see it". Both outbound cycle pushes now
  send this neutral line and drop `milestone` + the `cycle.<phase>` i18n key
  from the push `data` (either would re-render/expose the phase client-side);
  `localizeFor` re-renders `cycle.neutral` per recipient locale, and the
  WhatsApp mirror does the same. The **in-app Notification row + socket emit keep
  the real phase content** (behind auth). The `[CycleNotifier]` info log no
  longer prints the phase/day against a coupleId (that was menstrual-health data
  in Winston). **Encryption-at-rest is DEFERRED** (needs a migration): the cycle
  columns (`cycleLastPeriodStart`, `cyclePeriodLength`, `cycleCycleLength`) sit
  in plaintext on `CoupleUsState`. Proposed approach in PLAN follow-up:
  app-layer AES-256-GCM on those columns with a key from a KMS/env secret
  (per-record IV, auth tag stored alongside), or Postgres `pgcrypto`. Either
  requires a schema/migration change to widen/rename the columns to hold the
  ciphertext + IV + tag and a backfill — out of scope for this code-only pass.
- **Presign validation** (`chat.controller.ts`, `lib/storage.ts`, `config/env.ts`).
  `contentType` is normalized (params stripped, lowercased) and allow-listed per
  kind — voice `{audio/aac, audio/mpeg, audio/m4a}`, image `{image/jpeg,
  image/png, image/webp}` (verified against mobile `uploadMedia.ts`: it sends
  `audio/aac` for voice and the picker mime, overwhelmingly `image/jpeg`, for
  images). Unlisted → `415 UNSUPPORTED_MEDIA_TYPE`; the client then uses its
  existing base64 fallback, so nothing hard-breaks. Size caps are new
  env-configurable vars `S3_MAX_IMAGE_BYTES` (default 10 MiB) /
  `S3_MAX_VOICE_BYTES` (default 25 MiB): a declared `contentLength` over the cap
  → `413 MEDIA_TOO_LARGE`, and when declared it is signed onto the presigned PUT
  as `Content-Length` so storage rejects a mismatched body. NOTE: a presigned
  **PUT** cannot express a size *range* the way a presigned POST policy can — an
  exact signed `Content-Length` is the PUT-compatible bound, so a hard cap
  applies only once the client declares its length. Recommended follow-up: have
  the mobile client send `contentLength` in the `/chats/upload-url` body (it
  already knows the blob size) — backward-compatible, no response-shape change.
  The `{ uploadUrl, publicUrl, key, ref, contentType }` response shape is
  unchanged, so the just-shipped presigned pipeline keeps working.

**Concurrent-edit note (gates)**: this pass shares `config/env.ts` and
`i18n/notif.ts` with another agent's in-flight security work (an SMS abuse guard
plus a JWT jti-denylist). My additions merged cleanly at distinct locations. At
hand-off, `npm run typecheck` reports 19 errors and `app.health.test.ts` fails
to compile — **all** of them inside that other agent's files
(`src/services/abuseGuard.ts` ×18: it references `SMS_PHONE_DAILY_CAP` /
`SMS_IP_DAILY_CAP` / `ALERT_WEBHOOK_URL` while their env.ts defines
`SMS_PER_PHONE_DAILY_CAP` / `SMS_PER_IP_DAILY_CAP` / no webhook var;
`src/middleware/adminAuth.ts` ×1: their `express.d.ts` gained `jti`/
`accessTokenExp` on `Request.user` but the duplicate augmentation in adminAuth
was not updated). **Zero errors trace to the six files in this change**; all
30 unit tests pass (the 4 new block tests + the prior 26). Re-run the gates
once that agent's SMS/JWT work lands.

---

## [2026-08-20] — Real match scoring, envelope unification, atomicity for multi-write paths

**Why**: three classes of dishonesty/fragility. (1) The discovery feed's
`matchScore` was `Math.random()*20+80` and its two "insights" were hardcoded
strings shown to every user — a fake compatibility claim in a product whose
core promise is matching couples well, while the real signal (onboarding
answers, activities, vibes, criteria, city) sat unused in the DB. (2) Two of
nine controllers (admin: 32 hand-rolled `res.json`, subscription: 25) bypassed
the `src/utils/response.ts` envelope, so error text lived under `message` in
one API and machine codes were stuffed into `error` in another — every client
has to guess. (3) Several multi-write paths could commit halfway: a crash in
`setupProfile` could rename a user with no couple row; a crash in the mutual
accept could connect a couple with no notification; and the order-sensitive
`@@unique([couple1Id, couple2Id])` let two simultaneous opposite-direction
hellos create duplicate (A,B)+(B,A) rows the constraint never sees.

**What changed**:

- **Deterministic match scoring** (`src/services/matchScore.ts`, new; pure —
  unit-tested in `src/__tests__/matchScore.test.ts`, 16 tests): weighted
  overlap across onboarding answers (per-question Jaccard, weight 45),
  activities (25), socialVibes (10), matchCriteria (10) — dimensions missing
  on either side are excluded and weights renormalized (absence of data is not
  disagreement) — plus a flat +10 same-city bonus that is never renormalized
  (city alone can't fake a high match). Raw 0–100 remaps onto
  **[55, 100]** (`SCORE_FLOOR`): in a couples app "12% match" reads as an
  insult, so zero overlap displays as a warm 55 while remapping (not clamping)
  keeps every real difference ordered. Option ids and legacy stored titles
  normalize to the same tokens, so old rows still score.
- **True insights**: up to 2 lines built only from genuine overlaps using the
  feed's existing display-tag vocabulary (`Q3_TITLES` moved to matchScore.ts,
  re-imported by the feed so tags render byte-identically) — e.g. "You both
  love weekend trips", "Similar pace - you both prefer meeting once a month".
  `[]` when nothing genuine is shared (the app shows neutral copy); nothing is
  ever invented. Response shape unchanged: `matchScore: number`,
  `insights: string[]`.
- **Feed ranked by score** (`match.service.ts getDiscoveryFeed`): filters and
  exclusions are unchanged; instead of returning an arbitrary DB-order 10, a
  bounded pool of 50 candidates is fetched (same `where`), scored, sorted
  descending (coupleId tiebreak for stability), and the top 10 returned.
  Scoring inputs are selected but never serialized to the client.
- **Score persisted on Match rows**: `sayHello` create and the skipped→pending
  reset now write `matchScore`/`insights` (columns existed since the schema
  was born, nothing ever wrote them). Skip rows stay unscored (they are
  exclusion markers, not connections).
- **Envelope unification** (`admin.controller.ts`, `subscription.controller.ts`
  via `utils/response.ts`): all success paths → `sendSuccess`, all errors →
  `sendError` with machine codes in `code` and human copy in `error`. Status
  codes preserved exactly. Admin errors carry a transition-only `message`
  mirror of the human text (new optional field on `sendError`) because the
  deployed panel build may predate this migration; the repo's
  `AdminDataProvider.tsx` reads only `res.ok`/`success`/`data`/`data.token`,
  all preserved. Deliberate survivors, documented in RULES.md §1: `GET
  /admin/media/*` (image bytes/plain text for `<img>` loaders),
  `verifyGoogle`'s 202 (historical top-level `pending: true` the helper can't
  carry), and `/.well-known/assetlinks.json` in app.ts (Google's Digital Asset
  Links spec REQUIRES a bare top-level JSON array — the Android OS is the
  consumer; enveloping it would break App Links verification).
- **setupProfile atomic** (`couple.service.ts`): both user rows + the couple
  row now commit in one interactive transaction. The old catch-P2002-and-retry
  email fallback can't live inside a Postgres tx (a failed statement aborts
  it), so the same non-blocking semantics are implemented as an in-tx email
  pre-check; the residual check-then-write race rolls the tx back untouched
  and it is retried once, where the pre-check sees the committed winner.
- **Mutual-accept atomic** (`match.service.ts` sayHello + accept paths): the
  `match.update` to accepted and BOTH "You've Connected!" notification upserts
  commit in one transaction (notification upserts in
  `notification.service.ts` now accept an optional transaction client);
  sockets/push fire only after commit so a rolled-back accept can never buzz a
  phone.
- **Symmetric-race fix, no migration/backfill** (`match.service.ts`): new
  Match rows are written in canonical orientation (lower coupleId first,
  `canonicalMatchPair`) so simultaneous opposite-direction hellos/skips now
  collide on the unique constraint instead of duplicating; every read stays
  bidirectional (legacy rows exist in both orientations); the skipped→pending
  reset no longer re-orients the row (re-orienting could P2002 against a
  legacy duplicate — and `getIncomingRequests` resolves direction via
  `actionById`, so orientation is meaningless); sayHello's P2002 recovery now
  re-queries BOTH orientations and, when the racing row is the other couple's
  incoming pending, accepts it as the mutual like it is; `skipCouple` treats a
  P2002 as success (the pair row exists — exactly what a skip wants).
- **Photo URL corruption fix** (`couple.service.ts` uploadPhotos +
  updateProfile, `lib/storage.ts`): the app's presigned-upload pipeline sends
  already-hosted URLs, but both photo paths blind-wrapped any non-`data:`
  value as `data:image/jpeg;base64,<value>`, corrupting URL values — which is
  why mobile kept primary photos on base64. Both now route through the
  existing `materializeImageLoose` choke point (handles base64, data: URIs and
  http URLs), which additionally passes relative `/img/…` image-proxy paths
  through unchanged. Response shapes unchanged.
- Known debt left in place deliberately: admin/subscription controllers still
  lack zod validation (RULES §7 baseline) — adding schemas would change which
  request bodies are accepted and risk the deployed panel; this pass was
  response-serialization only.

Gates: `npm run typecheck` 0 errors; `npm test` 28/28 (12 existing + 16 new).
`npm run lint` is inert in this repo (no ESLint config exists — pre-existing).

## [2026-08-20] — Companion layer: game-result loop, partner presence, quiet hours, celebrations, mood history

**Why**: the Us space had four emotional dead-ends. A finished game notified nobody — the
`us_game_result` subtype was declared (`us.socket.ts`) but never sent, so an offline partner
never learned the game ended. The couple room existed but never said whether the partner was
there. Socket-driven pushes (nudges, moods, game results) buzzed phones at 2am while every cron
job politely respected 08–21 IST. And nothing celebrated birthdays or the couple's own Sawa
anniversary even though `User.dob` and `Couple.createdAt` sit in the schema. All five changes
ride the existing schema — no migration.

**What changed**:

- **Game-result loop closed** (`src/sockets/us.socket.ts`): when `us:game:result` is scored
  (inside the existing scored-once idempotency guard), the partner who did NOT report gets the
  full us.mood-pattern treatment — Notification row (`subtype: 'us_game_result'`),
  `notification:new` socket refresh, localized push via `pushToUser`. Copy is written from the
  recipient's perspective (win / loss / draw), mentions the live streak from 2 consecutive wins,
  and keeps a playful "Rematch?" tone. New i18n keys `us.game.win|winStreak|loss|lossStreak|draw`
  in all four locales (`src/i18n/notif.ts`), phrased with ergative/respectful constructions in
  hi/mr/kn so no gendered variants are needed.
- **Ambient partner presence** (`src/sockets/index.ts`, `src/constants/socketEvents.ts`):
  `us:partner:presence { userId, online }` is emitted to `couple:{coupleId}` on a user's FIRST
  socket connecting and LAST socket disconnecting (per-user socket counting in a per-worker
  Map). Socket-only by design — no Notification row, no push. The comment documents the PM2
  truth: cluster mode has NO sticky sessions, so delivery is cluster-correct via the Redis
  adapter but counting is per-worker (exact for one-device users; multi-worker users can flicker
  a false offline). Redis INCR/DECR is the named upgrade path.
- **Quiet hours for event pushes** (`src/services/push.service.ts`): outside 08:00–22:00 IST,
  `pushToUser`/`pushToCouple` suppress the FCM push AND the WhatsApp mirror for the types in the
  new exported `QUIET_HOURS_GATED_TYPES` (us_nudge, us_love, us_feeling, us_ask_feeling,
  us_fridge_note, us_fridge_ack, us_game_challenge, us_game_result). Notification rows and
  socket emits are unaffected (callers write them first) — in-app surfaces stay live; only the
  phone buzz respects the night. Chat/match pushes stay exempt; cron types already self-gate.
  Timezone hardcoded IST to match the jobs; per-user timezone is a named known gap.
- **Celebrations job** (`src/jobs/celebrationNotifier.ts`, wired in `src/server.ts` worker-0
  gate like the other three): every 3h inside 08–21 IST, Redis once-per-day dedupe. Birthday
  tomorrow → heads-up to the other partner; birthday today → warm wish to the birthday person +
  gentle nudge to the partner (per-partner visibility via the existing `data.senderUserId`
  client filter); Sawa anniversary of `Couple.createdAt` (years ≥ 1) → both partners via
  couple-level row + `pushToCouple`. Subtypes `us_birthday`/`us_anniversary` on the existing
  `type: 'system'` enum value — no schema change. New i18n keys `us.birthday.tomorrow`,
  `us.birthday.today.you`, `us.birthday.today.partner`, `us.anniversary.one`,
  `us.anniversary.many` (two keys because "1 year" pluralizes differently across the four
  languages). DOB parsing mirrors `ageFromDobString` (DD/MM/YYYY and ISO); Feb-29 celebrates on
  Feb 28 in non-leap years; banned couples are skipped.
- **Mood history read-path** (`src/routes/us.routes.ts`): `GET /api/v1/us/mood-history` returns
  the couple's last 30 days of mood events `{ userId, mood, at }` (both partners, newest first)
  from the `us_mood` Notification rows the socket path already writes — Redis moods TTL out at
  7 days, these don't. Bounded (30-day window + take 200), served by the `[recipientId, type]`
  index with a JSON-path subtype filter. New-code rules applied: `sendSuccess` envelope +
  `asyncHandler` (rest of the file remains baseline debt).
- **Test harness repaired** (no production code): `src/__tests__/setup.ts` set a `JWT_SECRET`
  nothing reads and lacked `GROQ_API_KEY`, so env validation `process.exit(1)`-ed every suite at
  import; `@types/supertest` was never installed, so two suites failed to compile (bridged with
  `src/types/supertest.d.ts` — install the real types on the next dependency change);
  `report.routes.test.ts` mock predated the route's blocked-list read (`couple.findUnique`) and
  the `req.user.userId` augmentation; `app.health.test.ts` demanded a live Postgres for what is
  a contract test (DB ping now mocked). `npm test`: 3/3 suites, 12/12 tests green — it could
  not even start before.

Gates: `tsc --noEmit` 0 errors (baseline 0), `npm test` green (baseline: env-exit before any
test). `eslint src --ext .ts` cannot run — the repo has no ESLint config file (pre-existing;
adding one is a separate decision, not smuggled in here).

**Why**: `sawa/` and `sawa_admin/` each carry a `CLAUDE.md` containing `@AGENTS.md`, so their
rules auto-load for agent sessions started inside the repo. This repo had no equivalent — a
session started in `sawa_server/` never saw RULES.md unless it was launched from the
workspace folder above. The rules only work if they load.

**What changed**: new `CLAUDE.md` containing `@RULES.md`. Docs only.

---

## [2026-08-19] — RULES.md regenerated against verified code, restructured design → performance → security

**Why**: a claim-by-claim verification of RULES.md against `arfam-fix` `42bbf2c` found six
statements the code contradicts — JWT lifetimes stated as 15m/30d (env defaults are 7d/90d,
`src/config/env.ts:12-13`), fictional `group:`/`match:` socket rooms (real rooms are `chat:`
and `couple:`), "bcrypt min 12 rounds" (cost is 10, admin-only; users are OTP-only), an
asyncHandler claim that mismatched where it's actually wired (route layer, 8 of 13 files), a
pagination spec no endpoint implements, and a `.env.example` reference when none exists. A
rules file that states falsehoods as facts trains every future session wrong. Arfam also set
the standing priority order: design first, performance second, security third.

**What changed** (docs only, no code):
- All six false claims corrected to what the code actually does, with file references.
- Rules the codebase doesn't yet meet are now explicitly **baseline debt** with counts
  (direct-prisma controllers 6/9, zod coverage 5/9 controllers, asyncHandler 8/13 route
  files, ~53 legacy console.logs) — never add to it, shrink it in touched code. Counts are
  part of the living-document contract.
- Restructured: §1 Design (API contract as a design surface, error messages as user-facing
  copy, brand/tone) → §2 Performance (cache.ts contract, query shaping, indexes-with-
  migrations, no polling over sockets) → §3 Security (all prior guarantees kept: hashed
  refresh tokens, CSPRNG OTP, prod-gated bypass, rate limits, requireEntitlement, S8
  response shaping) → architecture/API/sockets/quality unchanged in substance.
- Pagination rewritten as a convention for **new** list endpoints; bcrypt cost 12 set as the
  target on next admin-auth touch; JWT lifetime changes routed through PLAN.md as a product
  decision.

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
