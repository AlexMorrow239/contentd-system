# Publishing Loop Implementation Plan (Plan 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ready` library videos upload to YouTube Shorts unattended on per-channel local-time slot schedules, via a cron `brainrot publish-next` tick with its own lease, with encrypted OAuth tokens, manual-resolution paths for interrupted uploads, library review commands, and digest visibility.

**Architecture:** A new `src/publish/` domain (crypto, tokens, types, publishes DAO, slot math, YouTube adapter, OAuth flow) composed by `src/loop/publish-next.ts`, mirroring the produce-next tick pattern exactly: short-lived cron process, DB lease, guarded claims via a UNIQUE constraint, one JSON line on stdout. Spec: `docs/superpowers/specs/2026-07-22-publishing-loop-design.md` (READ IT FIRST — decisions of record are binding).

**Tech Stack:** TypeScript ^5.9 strict ESM (NodeNext, `.js` import suffixes), better-sqlite3 v12, commander ^15, zod v4, vitest 4, `node:crypto` (AES-256-GCM), `node:http` (OAuth loopback). **Zero new npm dependencies.**

## Global Constraints

- **TDD every task**: red → verify fail → green → verify pass → commit. Vitest 4; a missing named export surfaces as a runtime TypeError in the test, not an import error; a missing module file fails at import time.
- Strict ESM NodeNext: relative imports carry `.js` suffixes. `import type` for type-only imports.
- **No new runtime dependencies.** Node built-ins only for new capability.
- better-sqlite3: FKs are OFF; write transactions via `db.transaction(fn)()`; guarded single-row transitions return `.changes === 1` booleans; batch ops return `.changes` counts; placeholder lists via `ids.map(() => '?').join(', ')`. DB rows are snake_case, mapped to camelCase interfaces via a private `toXRow` mapper (copy `src/scout/topics.ts` style).
- Tests use `openDb(':memory:')` directly (no helper); contract tests are `*.contract.test.ts`, gated by `CONTRACT=1` (see `vitest.config.ts`), skipped otherwise.
- **Time domains**: slot bookkeeping (`publishes.day`, due-slot math) uses machine-LOCAL date/time; all existing budget/cost code stays UTC. Never mix them. All time-dependent functions take an injected `now: Date` (or `now: () => Date` at the tick level) — no bare `new Date()` in logic under test.
- **One-JSON-line stdout contract** for `publish-next`: the tick function returns a `PublishTickResult`; `src/cli.ts` prints `JSON.stringify(result) + '\n'` and sets `process.exitCode` (1 only for `action: 'publish-failed'`). Config/DB errors go to stderr via the existing `parseAsync().catch` path, no JSON line.
- **Never log or print token material** — not in errors, not in tests, not in CLI output. Confirmations print scopes and channel names only.
- Config objects returned by loaders are deep-frozen (`Object.freeze`), fresh arrays per load (no shared references — see the `DEFAULT_SCOUT` aliasing bug history).
- Plain `throw new Error(...)` for config/validation errors; `PublishError` (with `kind`) only for platform-call failures.
- Error messages follow house style: `` `functionName: what went wrong` `` prefix where a provider call fails.
- Commit after every task's final step with a conventional-commits message; run the full suite (`npm test`) once before each commit, focused tests while iterating.
- Constants are `UPPER_SNAKE` exported from the module that owns them; env vars are read at call time, never at module load.
- YouTube synthetic-media disclosure is ALWAYS set true — no config, no flag, no exceptions.

## Interface Contract (BINDING)

Every signature below is authoritative. Task authors and implementers use these names, parameter orders, and types exactly. `Database` = `better-sqlite3`'s type (imported as in existing DAOs). `Tier` = existing `'volume' | 'premium'`.

### Existing seams consumed (already on main — do not modify unless a task says to)

```ts
// src/loop/lease.ts
export function acquireLease(db: Database, name: string, holder: string, ttlMs: number): boolean
export function releaseLease(db: Database, name: string, holder: string): void
// src/db/index.ts
export function openDb(dbPath: string): Database
// src/config/channel.ts
export function loadChannelsDir(dir: string): ChannelConfig[]
// src/stages/_testkit.ts
export function testChannel(overrides?: Partial<ChannelConfig>): ChannelConfig
// library.metadata_json content: {"youtube": {"title","description","hashtags"}, "tiktok": {...}, "instagram": {...}} or '{}'
```

### New constants

```ts
// src/loop/lease.ts (addition)
export const PUBLISH_LEASE_TTL_MS = 1_800_000        // 30 min
// lease name literal used by publish-next: 'publish'; holder: `pid:${process.pid}`
// src/publish/publishes.ts
export const MAX_PUBLISH_ATTEMPTS = 3
// src/publish/youtube.ts
export const YT_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload'
export const UPLOAD_TIMEOUT_MS = 300_000              // 5 min per HTTP call in the upload
export const DEFAULT_YT_UPLOADS_PER_DAY = 6
```

### src/publish/types.ts (Task 3)

```ts
export const PUBLISH_PLATFORMS = ['youtube'] as const
export type Platform = (typeof PUBLISH_PLATFORMS)[number]
export type PublishErrorKind = 'auth' | 'quota' | 'rejected' | 'transient'
export class PublishError extends Error {
  constructor(message: string, public kind: PublishErrorKind)
}
export interface PlatformMeta { title: string; description: string; hashtags: string[] }
export interface PublishChannelConfig {
  slots: string[]                       // non-empty, 'HH:MM' zero-padded 24h, unique, sorted ascending by the loader
  platforms: Platform[]                 // v1: exactly ['youtube']
  privacy: 'public' | 'unlisted' | 'private'
  categoryId: number
  madeForKids: boolean
}
export interface PublishTarget {
  readonly platformId: Platform
  upload(
    req: { videoPath: string; meta: PlatformMeta; publish: PublishChannelConfig },
    accessToken: string
  ): Promise<{ postId: string; url: string }>
}
// Picks `platform`'s entry from a metadata_json map; missing/invalid entry (e.g. legacy '{}')
// falls back to { title: fallbackTopic.slice(0, 90), description: '', hashtags: [] }.
export function resolvePlatformMeta(metadataJson: string, platform: Platform, fallbackTopic: string): PlatformMeta
```

### src/publish/crypto.ts (Task 2)

```ts
// Parses 64-char hex → 32-byte Buffer. Missing/malformed → throw new Error('BRAINROT_TOKEN_KEY must be 64 hex characters')
export function parseTokenKey(hex: string | undefined): Buffer
// AES-256-GCM, fresh random 12-byte IV per call. Layout: iv(12) || authTag(16) || ciphertext
export function encryptToken(plaintext: string, key: Buffer): Buffer
// Throws (GCM auth failure / blob too short) on tamper, truncation, wrong key
export function decryptToken(blob: Buffer, key: Buffer): string
```

### src/publish/tokens.ts (Task 4)

```ts
export function upsertToken(db: Database, platform: Platform, channel: string, refreshToken: string, scopes: string, key: Buffer): void
// null when the row is missing OR decryption fails (decrypt failure also writes ONE warning line to stderr naming platform+channel, never token bytes)
export function loadRefreshToken(db: Database, platform: Platform, channel: string, key: Buffer): string | null
```

### src/config/channel.ts additions (Task 5)

```ts
export interface ChannelConfig { /* existing fields */; publish: PublishChannelConfig | null }  // null = publishing disabled
```
Raw TOML `[publish]` table optional. When present: `slots` required non-empty array matching `/^([01]\d|2[0-3]):[0-5]\d$/`, unique, loader sorts ascending; `platforms` optional default `['youtube']`, every element must be in `PUBLISH_PLATFORMS`; `privacy` optional default `'public'`; `category_id` optional positive integer default `24`; `made_for_kids` optional boolean default `false`. Absent table → `publish: null`. Result frozen (including the arrays). Malformed values → load-time `Error` (existing wrap style: `` `failed to load channel config ${path}: ...` ``). `testChannel()` in `_testkit.ts` gains `publish: null` default.

### src/publish/slots.ts (Task 6) — pure functions, no DB

```ts
export function localDay(now: Date): string           // 'YYYY-MM-DD' in machine-local time
export function localHHMM(now: Date): string          // 'HH:MM' zero-padded machine-local
// Slots with slot <= localHHMM(now) and not in consumed. Preserves the config's ascending order.
export function dueSlotsForChannel(cfg: PublishChannelConfig, consumed: Set<string>, now: Date): string[]
export interface SlotCandidate { channel: string; platform: Platform; slot: string; filledCount: number; totalSlots: number }
// Sort: filledCount/totalSlots ASC, then slot ASC, then channel ASC. Pure; returns a new array.
export function orderCandidates(candidates: SlotCandidate[]): SlotCandidate[]
```

### src/publish/publishes.ts (Task 7)

```ts
export type PublishStatus = 'claimed' | 'done' | 'failed' | 'interrupted'
export interface PublishRow {
  id: number; jobId: string; platform: Platform; channel: string
  day: string; slot: string; status: PublishStatus
  postId: string | null; url: string | null; error: string | null
  errorKind: PublishErrorKind | null; attempt: number
  createdAt: string; finishedAt: string | null
}
// INSERT claimed row; attempt = 1 + COUNT(rows for job_id+platform), computed inside the same transaction.
// Returns new row id, or null if UNIQUE(channel,platform,day,slot) conflicted (racing tick).
export function claimPublish(db: Database, opts: { jobId: string; platform: Platform; channel: string; day: string; slot: string }): number | null
// ONE transaction: publishes row → done + post_id/url/finished_at, AND library.state → 'published' for that job.
export function markPublishDone(db: Database, id: number, postId: string, url: string, now: Date): void
export function markPublishFailed(db: Database, id: number, error: string, kind: PublishErrorKind, now: Date): void
// claimed rows with created_at older than olderThanMs relative to now → interrupted. Returns count. Idempotent.
export function sweepInterrupted(db: Database, olderThanMs: number, now: Date): number
// Slot strings with any-status row for (channel, platform, day)
export function consumedSlots(db: Database, channel: string, platform: Platform, day: string): Set<string>
// Rows that plausibly hit the upload endpoint: claimed + done + interrupted + failed WHERE error_kind != 'auth' (NULL error_kind counts)
export function uploadsUsedToday(db: Database, platform: Platform, day: string): number
// Eligibility per spec §6 step 6. Joins library (state='ready') + jobs (channel). Returns null if none.
export function eligibleVideo(db: Database, channel: string, platform: Platform): { jobId: string; videoPath: string; metadataJson: string; topic: string } | null
export function listPublishes(db: Database, opts?: { sinceDays?: number }): PublishRow[]   // default 7 (UTC created_at window)
// interrupted → failed, error_kind 'transient', error += '; manually cleared'. False if job has no interrupted row.
export function retryInterrupted(db: Database, jobId: string): boolean
// interrupted → done with postId/url AND library → 'published', one transaction. False if no interrupted row.
export function markInterruptedDone(db: Database, jobId: string, postId: string, url: string, now: Date): boolean
```

### src/publish/youtube.ts (Task 8)

```ts
// env BRAINROT_YT_UPLOADS_PER_DAY read at call time; unset/empty → DEFAULT_YT_UPLOADS_PER_DAY; non-positive/NaN → Error
export function ytUploadsPerDayCap(): number
// POST https://oauth2.googleapis.com/token (grant_type=refresh_token). invalid_grant/4xx → PublishError kind 'auth'; 5xx/network → 'transient'
export async function mintAccessToken(opts: { refreshToken: string; clientId: string; clientSecret: string; fetchImpl?: typeof fetch }): Promise<string>
export function youtubeTarget(fetchImpl?: typeof fetch): PublishTarget
```
`upload`: resumable protocol — (1) POST `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status` with JSON body `{ snippet: { title, description: description + '\n\n' + hashtags.join(' '), tags: hashtags.map(h => h.replace(/^#/, '')), categoryId: String(categoryId) }, status: { privacyStatus, selfDeclaredMadeForKids, containsSyntheticMedia: true } }` → `Location` header; (2) PUT the file bytes (`readFileSync`) to that URL. Empty-hashtags edge: description gets no trailing separator. `AbortSignal.timeout(UPLOAD_TIMEOUT_MS)` on both calls. Error mapping: response body `error.errors[].reason` of `quotaExceeded`/`uploadLimitExceeded`/`dailyLimitExceeded` → `'quota'`; HTTP 401 → `'auth'`; other 4xx → `'rejected'`; 5xx/network/abort → `'transient'`; `ENOENT` reading the file → `'rejected'`. Returns `{ postId: <video id>, url: 'https://youtube.com/shorts/' + postId }`. (`containsSyntheticMedia` is the disclosure field per current API reference — the contract test in Task 14 verifies it is accepted by the live API; if the live API rejects the field name, fixing it is a one-line change verified there.)

### src/publish/oauth-flow.ts (Task 9)

```ts
// Starts a 127.0.0.1 loopback server (listenPort ?? 0 = ephemeral), opens consent URL via openBrowser
// (default: execa('open', [url]) on darwin), waits for the redirect (state param verified,
// AUTH_FLOW_TIMEOUT_MS = 300_000 → Error), exchanges the code at https://oauth2.googleapis.com/token,
// returns the refresh token + granted scopes. Server always closed (finally).
export const AUTH_FLOW_TIMEOUT_MS = 300_000
export async function runYoutubeAuthFlow(opts: {
  clientId: string; clientSecret: string
  openBrowser?: (url: string) => void | Promise<void>
  fetchImpl?: typeof fetch
  listenPort?: number
}): Promise<{ refreshToken: string; scopes: string }>
```
Consent URL: `https://accounts.google.com/o/oauth2/v2/auth` with `client_id`, `redirect_uri=http://127.0.0.1:<port>`, `response_type=code`, `scope=YT_UPLOAD_SCOPE`, `access_type=offline`, `prompt=consent`, `state=<random hex>`. Missing refresh token in the exchange response → `Error('runYoutubeAuthFlow: no refresh_token in response; remove prior grant at myaccount.google.com/permissions and retry')`.

### src/jobs/library.ts (Task 11)

```ts
export type LibraryState = 'ready' | 'needs-review' | 'published' | 'blocked'
export interface LibraryRow { jobId: string; channel: string; tier: Tier; topic: string; videoPath: string; state: LibraryState; createdAt: string }
export function listLibrary(db: Database, filter?: { state?: LibraryState; channel?: string }): LibraryRow[]
export function approveLibrary(db: Database, jobIds: string[]): number   // needs-review → ready only
export function rejectLibrary(db: Database, jobIds: string[]): number    // needs-review OR ready → blocked
```

### src/loop/publish-next.ts (Task 10)

```ts
export interface PublishTickResult {
  action: 'published' | 'publish-failed' | 'noop' | 'dry-run'
  reason?: 'lease-held' | 'no-due-slot' | 'platform-quota' | 'no-ready-video' | 'no-auth' | 'claim-conflict'
  channel?: string; platform?: Platform; jobId?: string; slot?: string
  postId?: string; url?: string; error?: string
  wouldPublish?: { channel: string; platform: Platform; slot: string; jobId: string; title: string } | null
}
export async function publishNextTick(db: Database, opts: {
  channelsDir: string
  target?: PublishTarget          // default youtubeTarget(); tests inject fakes
  fetchImpl?: typeof fetch        // threaded to mintAccessToken
  now?: () => Date                // default () => new Date()
  dryRun?: boolean
}): Promise<PublishTickResult>
```
Algorithm: spec §6, exactly — lease (skip in dry-run), sweep (skip in dry-run), due slots, quota gate (`uploadsUsedToday` vs `ytUploadsPerDayCap()`), candidate iteration (video then token per candidate, first-blocker reason on exhaustion), claim, `resolvePlatformMeta`, mint token, upload, finalize. Env for client creds: `YT_CLIENT_ID` / `YT_CLIENT_SECRET` — absent counts as the `no-auth` blocker for every candidate. Dry-run: ZERO DB writes, returns `action: 'dry-run'` with `wouldPublish` (or `null` + `reason`).

### CLI (Tasks 9, 10, 11, 12 modify src/cli.ts)

`auth youtube --channel <name>` (Task 9); `publish-next [--dry-run]` with the standard `--db`/`--channels-dir` options (Task 10); `library list [--state <s>] [--channel <c>]` / `library approve <jobIds...>` / `library reject <jobIds...>` (Task 11); `publish retry <jobId>` / `publish mark-done <jobId> <postId>` / `publishes list [--days <n>]` (Task 12). All follow existing idioms: `resolveDbPath`, try/finally `db.close()`, human-readable output for list/manual commands (match `topics list` style), JSON line only for `publish-next`.

### Digest (Task 13 modifies src/loop/digest.ts)

`buildDigest(db, channels)` gains a `Publishing (last 24h)` section between `Spend today (UTC)` and `Action items`, and new Action-items entries: auth-failure hint, interrupted-check instruction, attempt-capped list, lapsed-slots-yesterday line. Empty subsection prints `  none` (house style).

### Schema (Task 1 modifies src/db/schema.sql)

Exactly the two `CREATE TABLE IF NOT EXISTS` blocks from spec §3.1/§3.2 (publishes with `error_kind` and `UNIQUE (channel, platform, day, slot)`; oauth_tokens with `PRIMARY KEY (platform, channel)`).

---

## Task Index & Dependencies

| # | Task | Files | Depends on |
|---|---|---|---|
| 1 | Schema: publishes + oauth_tokens | `src/db/schema.sql`, `src/db/schema.test.ts` | — |
| 2 | Token crypto | `src/publish/crypto.ts` + test | — |
| 3 | Publish types + resolvePlatformMeta | `src/publish/types.ts` + test | — |
| 4 | Tokens DAO | `src/publish/tokens.ts` + test | 1, 2, 3 |
| 5 | `[publish]` channel config | `src/config/channel.ts`, `src/stages/_testkit.ts` + tests | 3 |
| 6 | Slot math (pure) | `src/publish/slots.ts` + test | 3 |
| 7 | Publishes DAO | `src/publish/publishes.ts` + test | 1, 3 |
| 8 | YouTube adapter | `src/publish/youtube.ts` + test | 3 |
| 9 | OAuth flow + `auth` CLI | `src/publish/oauth-flow.ts`, `src/cli.ts` + tests | 2, 4, 8 |
| 10 | publish-next tick + CLI | `src/loop/publish-next.ts`, `src/loop/lease.ts`, `src/cli.ts` + tests | 2, 3, 4, 5, 6, 7, 8 |
| 11 | Library DAO + `library` CLI | `src/jobs/library.ts`, `src/cli.ts` + tests | 1 |
| 12 | Publish manual CLI | `src/cli.ts` + tests | 7 |
| 13 | Digest publishing section | `src/loop/digest.ts` + tests | 3, 5, 6, 7 |
| 14 | README + golden path + contract test | `README.md`, `src/jobs/golden-path-loop.test.ts`, `src/publish/youtube.contract.test.ts`, fixture | 2, 3, 4, 8, 9, 10 |

Execution is sequential (subagent-driven, one task at a time) — same-file tasks (9/10/11/12 all touch `src/cli.ts`) never run concurrently.

---

### Task 1: Schema: publishes + oauth_tokens tables

**Files:**
- Modify: `src/db/schema.sql`
- Test: `src/db/schema.test.ts` (does not exist yet — create it)

**Interfaces:**
- Consumes: `export function openDb(dbPath: string): Database` (`src/db/index.ts`, existing, unchanged — runs `schema.sql` via `db.exec` on every open).
- Produces:
  - `publishes` table — columns `id, job_id, platform, channel, day, slot, status, post_id, url, error, error_kind, attempt, created_at, finished_at`; `CHECK (status IN ('claimed','done','failed','interrupted'))`; `CHECK (error_kind IN ('auth','quota','rejected','transient'))`; `UNIQUE (channel, platform, day, slot)`. Relied on verbatim by Task 7 (`src/publish/publishes.ts`) and Task 10/11/12/13.
  - `oauth_tokens` table — columns `platform, channel, token_ciphertext, scopes, updated_at`; `PRIMARY KEY (platform, channel)`. Relied on verbatim by Task 4 (`src/publish/tokens.ts`).

- [ ] **Step 1: Write the failing schema test**

Create `src/db/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { openDb } from './index.js'

describe('publishes and oauth_tokens tables', () => {
  it('are created by openDb', () => {
    const db = openDb(':memory:')
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[]
    ).map((r) => r.name)
    expect(names).toContain('publishes')
    expect(names).toContain('oauth_tokens')
    db.close()
  })
})

describe('publishes table constraints', () => {
  it('rejects a status outside the lifecycle CHECK', () => {
    const db = openDb(':memory:')
    expect(() =>
      db
        .prepare(
          "INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt) " +
            "VALUES ('job-1', 'youtube', 'chan-a', '2026-07-22', '10:00', 'uploading', 1)",
        )
        .run(),
    ).toThrow(/CHECK/)
    db.close()
  })

  it('rejects a duplicate (channel, platform, day, slot) insert', () => {
    const db = openDb(':memory:')
    db.prepare(
      "INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt) " +
        "VALUES ('job-1', 'youtube', 'chan-a', '2026-07-22', '10:00', 'claimed', 1)",
    ).run()
    expect(() =>
      db
        .prepare(
          "INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt) " +
            "VALUES ('job-2', 'youtube', 'chan-a', '2026-07-22', '10:00', 'claimed', 1)",
        )
        .run(),
    ).toThrow(/UNIQUE/)
    db.close()
  })

  it('rejects an error_kind outside the CHECK, and accepts NULL', () => {
    const db = openDb(':memory:')
    expect(() =>
      db
        .prepare(
          "INSERT INTO publishes (job_id, platform, channel, day, slot, status, error_kind, attempt) " +
            "VALUES ('job-1', 'youtube', 'chan-a', '2026-07-22', '10:00', 'failed', 'timeout', 1)",
        )
        .run(),
    ).toThrow(/CHECK/)
    db.prepare(
      "INSERT INTO publishes (job_id, platform, channel, day, slot, status, error_kind, attempt) " +
        "VALUES ('job-1', 'youtube', 'chan-a', '2026-07-22', '10:00', 'claimed', NULL, 1)",
    ).run()
    const row = db.prepare('SELECT error_kind FROM publishes').get() as {
      error_kind: string | null
    }
    expect(row.error_kind).toBeNull()
    db.close()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/db/schema.test.ts`

Expected failure (neither table exists yet — `schema.sql` still has only the Plan-4 placeholder comment):

```
FAIL  src/db/schema.test.ts > publishes and oauth_tokens tables > are created by openDb
AssertionError: expected [ 'bg_usage', 'costs', 'job_stages', … ] to contain 'publishes'

FAIL  src/db/schema.test.ts > publishes table constraints > rejects a status outside the lifecycle CHECK
SqliteError: no such table: publishes

FAIL  src/db/schema.test.ts > publishes table constraints > rejects a duplicate (channel, platform, day, slot) insert
SqliteError: no such table: publishes

FAIL  src/db/schema.test.ts > publishes table constraints > rejects an error_kind outside the CHECK, and accepts NULL
SqliteError: no such table: publishes

Test Files  1 failed (1)
     Tests  4 failed (4)
```

- [ ] **Step 3: Add the two tables to the schema**

Modify `src/db/schema.sql` — replace the trailing line `-- publishes table arrives in Plan 4.` so the file reads exactly:

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, channel TEXT NOT NULL, tier TEXT NOT NULL CHECK (tier IN ('volume','premium')),
  topic TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','failed','done','blocked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS job_stages (
  job_id TEXT NOT NULL REFERENCES jobs(id), stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  error TEXT, started_at TEXT, finished_at TEXT,
  PRIMARY KEY (job_id, stage)
);
CREATE TABLE IF NOT EXISTS library (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id), video_path TEXT NOT NULL, metadata_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready','needs-review','published','blocked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id),
  provider TEXT NOT NULL, operation TEXT NOT NULL, usd_micros INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS bg_usage (
  channel TEXT NOT NULL, file TEXT NOT NULL, used_at TEXT NOT NULL,
  PRIMARY KEY (channel, file, used_at)
);
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL, title TEXT NOT NULL,
  raw_title TEXT NOT NULL, source TEXT NOT NULL,
  url TEXT NOT NULL, dedupe_hash TEXT NOT NULL,
  score INTEGER NOT NULL, reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate','approved','claimed','used','rejected')),
  job_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (channel, dedupe_hash)
);
CREATE TABLE IF NOT EXISTS leases (
  name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS publishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  platform TEXT NOT NULL CHECK (platform IN ('youtube')),
  channel TEXT NOT NULL,
  day TEXT NOT NULL,      -- local YYYY-MM-DD of the slot filled
  slot TEXT NOT NULL,     -- 'HH:MM' from the channel's slots list
  status TEXT NOT NULL CHECK (status IN ('claimed','done','failed','interrupted')),
  post_id TEXT, url TEXT, error TEXT,
  error_kind TEXT CHECK (error_kind IN ('auth','quota','rejected','transient')),  -- null unless failed
  attempt INTEGER NOT NULL,   -- 1-based ordinal per (job_id, platform)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  UNIQUE (channel, platform, day, slot)
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  platform TEXT NOT NULL,
  channel TEXT NOT NULL,
  token_ciphertext BLOB NOT NULL,   -- iv (12B) || gcm tag (16B) || ciphertext
  scopes TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (platform, channel)
);
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/db/schema.test.ts`

Expected:

```
✓ src/db/schema.test.ts > publishes and oauth_tokens tables > are created by openDb
✓ src/db/schema.test.ts > publishes table constraints > rejects a status outside the lifecycle CHECK
✓ src/db/schema.test.ts > publishes table constraints > rejects a duplicate (channel, platform, day, slot) insert
✓ src/db/schema.test.ts > publishes table constraints > rejects an error_kind outside the CHECK, and accepts NULL

Test Files  1 passed (1)
     Tests  4 passed (4)
```

- [ ] **Step 5: Run the full suite, then commit**

Run: `npm test`

Expected: all existing suites plus the new one pass (no regressions — `schema.sql` only gained two new `CREATE TABLE IF NOT EXISTS` blocks; nothing existing was touched).

```
git add src/db/schema.sql src/db/schema.test.ts && git commit -m "$(cat <<'EOF'
feat: add publishes and oauth_tokens tables to schema

Lays the data-model groundwork for the publishing loop (Plan 4):
per-attempt publish rows with a UNIQUE(channel,platform,day,slot)
slot-consumption guard, and per-(platform,channel) encrypted
OAuth refresh token storage.
EOF
)"
```

### Task 2: Token crypto (AES-256-GCM)

**Files:** Create: `src/publish/crypto.ts`. Test: `src/publish/crypto.test.ts`.

**Interfaces:**
- Consumes: `node:crypto` built-ins only — `createCipheriv(algorithm: string, key: CipherKey, iv: BinaryLike): Cipher`, `createDecipheriv(algorithm: string, key: CipherKey, iv: BinaryLike): Decipher`, `randomBytes(size: number): Buffer`. No repo-internal signatures (Task 2 has no plan dependencies).
- Produces (exact signatures Task 4's `src/publish/tokens.ts` relies on):
  - `export function parseTokenKey(hex: string | undefined): Buffer`
  - `export function encryptToken(plaintext: string, key: Buffer): Buffer`
  - `export function decryptToken(blob: Buffer, key: Buffer): string`

- [ ] **Step 1: Write failing tests for `parseTokenKey`**

Create `src/publish/crypto.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseTokenKey } from './crypto.js'

const VALID_KEY_HEX = '0123456789abcdef'.repeat(4)

describe('parseTokenKey', () => {
  it('rejects undefined', () => {
    expect(() => parseTokenKey(undefined)).toThrow('BRAINROT_TOKEN_KEY must be 64 hex characters')
  })

  it('rejects hex shorter than 64 characters', () => {
    expect(() => parseTokenKey('ab'.repeat(10))).toThrow(
      'BRAINROT_TOKEN_KEY must be 64 hex characters',
    )
  })

  it('rejects a 64-character string containing a non-hex digit', () => {
    const notHex = `g${'0'.repeat(63)}`
    expect(() => parseTokenKey(notHex)).toThrow('BRAINROT_TOKEN_KEY must be 64 hex characters')
  })

  it('accepts a valid 64-char hex string and returns a 32-byte Buffer', () => {
    const key = parseTokenKey(VALID_KEY_HEX)
    expect(key).toBeInstanceOf(Buffer)
    expect(key.length).toBe(32)
    expect(key.toString('hex')).toBe(VALID_KEY_HEX)
  })
})
```

- [ ] **Step 2: Run it — expect failure**

Run: `npx vitest run src/publish/crypto.test.ts`

Expected failure — `src/publish/crypto.ts` does not exist yet, so the relative import fails to resolve at load time (a missing module file fails at import time, not inside a test body):

```
Error: Failed to resolve import "./crypto.js" from "src/publish/crypto.test.ts". Does the file exist?
```

The whole file errors out before any test runs (0 passed).

- [ ] **Step 3: Minimal implementation — `parseTokenKey` only**

Create `src/publish/crypto.ts`:

```ts
// Parses BRAINROT_TOKEN_KEY (64 hex chars = 32 raw bytes for AES-256) into the
// key Buffer. Missing/malformed input is a config error the caller surfaces
// before any token work is attempted — never a bare crash on a bad .env value.
export function parseTokenKey(hex: string | undefined): Buffer {
  if (hex === undefined || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('BRAINROT_TOKEN_KEY must be 64 hex characters')
  }
  return Buffer.from(hex, 'hex')
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `npx vitest run src/publish/crypto.test.ts`

Expected: `Test Files  1 passed (1)`, `Tests  4 passed (4)`.

- [ ] **Step 5: Write failing tests for `encryptToken` / `decryptToken`**

Replace the full contents of `src/publish/crypto.test.ts` with:

```ts
import { describe, expect, it } from 'vitest'
import { decryptToken, encryptToken, parseTokenKey } from './crypto.js'

const VALID_KEY_HEX = '0123456789abcdef'.repeat(4)

describe('parseTokenKey', () => {
  it('rejects undefined', () => {
    expect(() => parseTokenKey(undefined)).toThrow('BRAINROT_TOKEN_KEY must be 64 hex characters')
  })

  it('rejects hex shorter than 64 characters', () => {
    expect(() => parseTokenKey('ab'.repeat(10))).toThrow(
      'BRAINROT_TOKEN_KEY must be 64 hex characters',
    )
  })

  it('rejects a 64-character string containing a non-hex digit', () => {
    const notHex = `g${'0'.repeat(63)}`
    expect(() => parseTokenKey(notHex)).toThrow('BRAINROT_TOKEN_KEY must be 64 hex characters')
  })

  it('accepts a valid 64-char hex string and returns a 32-byte Buffer', () => {
    const key = parseTokenKey(VALID_KEY_HEX)
    expect(key).toBeInstanceOf(Buffer)
    expect(key.length).toBe(32)
    expect(key.toString('hex')).toBe(VALID_KEY_HEX)
  })
})

describe('encryptToken / decryptToken', () => {
  const key = parseTokenKey(VALID_KEY_HEX)

  it('round-trips a plaintext through encrypt then decrypt', () => {
    const blob = encryptToken('rt-test-token', key)
    expect(decryptToken(blob, key)).toBe('rt-test-token')
  })

  it('produces a different blob on each call (fresh IV) but both decrypt correctly', () => {
    const blobA = encryptToken('rt-test-token', key)
    const blobB = encryptToken('rt-test-token', key)
    expect(blobA.equals(blobB)).toBe(false)
    expect(decryptToken(blobA, key)).toBe('rt-test-token')
    expect(decryptToken(blobB, key)).toBe('rt-test-token')
  })

  it('throws when a ciphertext byte is flipped', () => {
    const blob = encryptToken('rt-test-token', key)
    const tampered = Buffer.from(blob)
    tampered[tampered.length - 1] ^= 0xff
    expect(() => decryptToken(tampered, key)).toThrow()
  })

  it('throws on a truncated blob shorter than iv+authTag (28 bytes)', () => {
    const tooShort = Buffer.alloc(27)
    expect(() => decryptToken(tooShort, key)).toThrow()
  })
})
```

- [ ] **Step 6: Run it — expect failure**

Run: `npx vitest run src/publish/crypto.test.ts`

Expected failure — the import line resolves fine (the module exists and exports `parseTokenKey`), but `encryptToken` and `decryptToken` are not exported yet, so the bound names are `undefined`; the failure surfaces as a runtime `TypeError` at the first call site inside the test body, not at import time:

```
FAIL  src/publish/crypto.test.ts > encryptToken / decryptToken > round-trips a plaintext through encrypt then decrypt
TypeError: encryptToken is not a function
```

The 4 `parseTokenKey` tests still pass; the 4 new tests in `encryptToken / decryptToken` fail the same way (each hits the undefined `encryptToken`/`decryptToken` binding).

- [ ] **Step 7: Implement `encryptToken` / `decryptToken`**

Replace the full contents of `src/publish/crypto.ts` with:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

// Parses BRAINROT_TOKEN_KEY (64 hex chars = 32 raw bytes for AES-256) into the
// key Buffer. Missing/malformed input is a config error the caller surfaces
// before any token work is attempted — never a bare crash on a bad .env value.
export function parseTokenKey(hex: string | undefined): Buffer {
  if (hex === undefined || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('BRAINROT_TOKEN_KEY must be 64 hex characters')
  }
  return Buffer.from(hex, 'hex')
}

// Fresh random IV per call so identical plaintexts never produce identical
// ciphertexts (GCM requires a unique IV per key: reuse breaks both
// confidentiality and authenticity). Blob layout iv(12) || authTag(16) ||
// ciphertext is self-contained — no separate IV column needed in oauth_tokens.
export function encryptToken(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, ciphertext])
}

// Throws on a truncated blob and on GCM auth-tag failure (tamper, corruption,
// wrong key) — callers treat any throw here as "token unusable" (the no-auth
// noop path), never a crash.
export function decryptToken(blob: Buffer, key: Buffer): string {
  if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('decryptToken: blob too short')
  }
  const iv = blob.subarray(0, IV_LENGTH)
  const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}
```

- [ ] **Step 8: Run it — expect pass**

Run: `npx vitest run src/publish/crypto.test.ts`

Expected: `Test Files  1 passed (1)`, `Tests  8 passed (8)`.

- [ ] **Step 9: Full suite, then commit**

Run: `npm test`

Expected: all suites pass, including the new `src/publish/crypto.test.ts`.

```
git add src/publish/crypto.ts src/publish/crypto.test.ts && git commit -m "feat(publish): add AES-256-GCM token crypto helpers"
```

### Task 3: Publish types + resolvePlatformMeta

**Files:** Create: `src/publish/types.ts`. Test: `src/publish/types.test.ts`.

**Interfaces:**
- Consumes: nothing from earlier tasks — this is the foundational, dependency-free module of the `src/publish/` domain. Only import is `zod` (`^4.4.3`, already a project dependency used the same way in `src/stages/script.ts` and `src/config/channel.ts`).
- Produces (verbatim from the Interface Contract; Tasks 4, 5, 6, 7, 8, 10 import these directly):
  ```ts
  export const PUBLISH_PLATFORMS = ['youtube'] as const
  export type Platform = (typeof PUBLISH_PLATFORMS)[number]
  export type PublishErrorKind = 'auth' | 'quota' | 'rejected' | 'transient'
  export class PublishError extends Error {
    constructor(message: string, public kind: PublishErrorKind)
  }
  export interface PlatformMeta { title: string; description: string; hashtags: string[] }
  export interface PublishChannelConfig {
    slots: string[]
    platforms: Platform[]
    privacy: 'public' | 'unlisted' | 'private'
    categoryId: number
    madeForKids: boolean
  }
  export interface PublishTarget {
    readonly platformId: Platform
    upload(
      req: { videoPath: string; meta: PlatformMeta; publish: PublishChannelConfig },
      accessToken: string,
    ): Promise<{ postId: string; url: string }>
  }
  export function resolvePlatformMeta(metadataJson: string, platform: Platform, fallbackTopic: string): PlatformMeta
  ```

- [ ] **Step 1: Write the failing test for `PUBLISH_PLATFORMS` and `PublishError`**

  Create `src/publish/types.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest'
  import { PUBLISH_PLATFORMS, PublishError } from './types.js'
  import type { PublishErrorKind } from './types.js'

  describe('PUBLISH_PLATFORMS', () => {
    it('is exactly youtube for v1', () => {
      expect(PUBLISH_PLATFORMS).toEqual(['youtube'])
    })
  })

  describe('PublishError', () => {
    it('carries its kind alongside the standard Error message', () => {
      const err = new PublishError('mintAccessToken: refresh rejected', 'auth')
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toBe('mintAccessToken: refresh rejected')
      expect(err.kind).toBe('auth')
    })

    it.each<PublishErrorKind>(['auth', 'quota', 'rejected', 'transient'])(
      'accepts kind %s',
      (kind) => {
        const err = new PublishError('boom', kind)
        expect(err.kind).toBe(kind)
      },
    )
  })
  ```

- [ ] **Step 2: Run, observe the failure**

  ```bash
  npx vitest run src/publish/types.test.ts
  ```

  Expected failure: `Error: Failed to resolve import "./types.js" from "src/publish/types.test.ts". Does the file exist?` — `src/publish/types.ts` does not exist yet, so the whole file fails at collection and 0 tests run.

- [ ] **Step 3: Create `src/publish/types.ts` with the constants, `PublishError`, and the plain interfaces**

  ```ts
  // v1 ships YouTube Shorts only; PublishTarget, the publishes table, and the
  // scheduler stay platform-agnostic so TikTok/Instagram are additive later
  // (design spec decision 1).
  export const PUBLISH_PLATFORMS = ['youtube'] as const
  export type Platform = (typeof PUBLISH_PLATFORMS)[number]

  export type PublishErrorKind = 'auth' | 'quota' | 'rejected' | 'transient'

  // Thrown only for platform-call failures (mintAccessToken, PublishTarget.upload)
  // — config/validation errors stay plain `Error` per house style. `kind` drives
  // the tick's attempt-failure handling and the digest's per-kind messaging.
  export class PublishError extends Error {
    constructor(message: string, public kind: PublishErrorKind) {
      super(message)
      this.name = 'PublishError'
    }
  }

  // One platform's entry out of library.metadata_json's per-platform map.
  export interface PlatformMeta {
    title: string
    description: string
    hashtags: string[]
  }

  // Parsed [publish] TOML table for a channel (src/config/channel.ts, Task 5).
  export interface PublishChannelConfig {
    slots: string[]
    platforms: Platform[]
    privacy: 'public' | 'unlisted' | 'private'
    categoryId: number
    madeForKids: boolean
  }

  export interface PublishTarget {
    readonly platformId: Platform
    upload(
      req: { videoPath: string; meta: PlatformMeta; publish: PublishChannelConfig },
      accessToken: string,
    ): Promise<{ postId: string; url: string }>
  }
  ```

- [ ] **Step 4: Run to green**

  ```bash
  npx vitest run src/publish/types.test.ts
  ```

  Expected: `6 passed` (1 `PUBLISH_PLATFORMS` test + 1 `PublishError` message/instanceof test + 4 `it.each` kind tests).

- [ ] **Step 5: Run the full suite**

  ```bash
  npm test
  ```

  Expected: every suite passes, no failures — this file's 6 tests are additive, nothing else touches `src/publish/`.

- [ ] **Step 6: Commit**

  ```bash
  git add src/publish/types.ts src/publish/types.test.ts
  git commit -m "feat: add publish platform types and PublishError" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 7: Write the failing tests for `resolvePlatformMeta`**

  Replace `src/publish/types.test.ts` with:

  ```ts
  import { describe, expect, it } from 'vitest'
  import { PUBLISH_PLATFORMS, PublishError, resolvePlatformMeta } from './types.js'
  import type { PublishErrorKind } from './types.js'

  describe('PUBLISH_PLATFORMS', () => {
    it('is exactly youtube for v1', () => {
      expect(PUBLISH_PLATFORMS).toEqual(['youtube'])
    })
  })

  describe('PublishError', () => {
    it('carries its kind alongside the standard Error message', () => {
      const err = new PublishError('mintAccessToken: refresh rejected', 'auth')
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toBe('mintAccessToken: refresh rejected')
      expect(err.kind).toBe('auth')
    })

    it.each<PublishErrorKind>(['auth', 'quota', 'rejected', 'transient'])(
      'accepts kind %s',
      (kind) => {
        const err = new PublishError('boom', kind)
        expect(err.kind).toBe(kind)
      },
    )
  })

  describe('resolvePlatformMeta', () => {
    const fullMap = JSON.stringify({
      youtube: { title: 'YT Title', description: 'YT description', hashtags: ['#space', '#shorts'] },
      tiktok: { title: 'TT Title', description: 'TT description', hashtags: ['#tiktok'] },
      instagram: { title: 'IG Title', description: 'IG description', hashtags: ['#reels'] },
    })

    it('picks the youtube entry out of a full per-platform map', () => {
      const meta = resolvePlatformMeta(fullMap, 'youtube', 'fallback topic')
      expect(meta).toEqual({
        title: 'YT Title',
        description: 'YT description',
        hashtags: ['#space', '#shorts'],
      })
    })

    it('falls back on a legacy empty-object row', () => {
      const meta = resolvePlatformMeta('{}', 'youtube', 'fallback topic')
      expect(meta).toEqual({ title: 'fallback topic', description: '', hashtags: [] })
    })

    it('falls back on invalid JSON', () => {
      const meta = resolvePlatformMeta('not json at all', 'youtube', 'fallback topic')
      expect(meta).toEqual({ title: 'fallback topic', description: '', hashtags: [] })
    })

    it('falls back when the entry has the wrong types', () => {
      const badMap = JSON.stringify({
        youtube: { title: 'YT Title', description: 'YT description', hashtags: 'not-an-array' },
      })
      const meta = resolvePlatformMeta(badMap, 'youtube', 'fallback topic')
      expect(meta).toEqual({ title: 'fallback topic', description: '', hashtags: [] })
    })

    it('slices a fallback topic over 90 chars down to 90', () => {
      const longTopic = 'x'.repeat(120)
      const meta = resolvePlatformMeta('{}', 'youtube', longTopic)
      expect(meta.title).toBe('x'.repeat(90))
      expect(meta.title).toHaveLength(90)
    })
  })
  ```

- [ ] **Step 8: Run, observe the failure**

  ```bash
  npx vitest run src/publish/types.test.ts
  ```

  Expected failure: `TypeError: resolvePlatformMeta is not a function` — `resolvePlatformMeta` is not yet exported from `./types.js` (the file exists, so this fails at runtime inside the test, not at import time; esbuild resolves the missing named export to `undefined`). The 6 tests from Step 4 keep passing — expected red summary: `5 failed | 6 passed`.

- [ ] **Step 9: Implement `resolvePlatformMeta`**

  Replace `src/publish/types.ts` with:

  ```ts
  import { z } from 'zod'

  // v1 ships YouTube Shorts only; PublishTarget, the publishes table, and the
  // scheduler stay platform-agnostic so TikTok/Instagram are additive later
  // (design spec decision 1).
  export const PUBLISH_PLATFORMS = ['youtube'] as const
  export type Platform = (typeof PUBLISH_PLATFORMS)[number]

  export type PublishErrorKind = 'auth' | 'quota' | 'rejected' | 'transient'

  // Thrown only for platform-call failures (mintAccessToken, PublishTarget.upload)
  // — config/validation errors stay plain `Error` per house style. `kind` drives
  // the tick's attempt-failure handling and the digest's per-kind messaging.
  export class PublishError extends Error {
    constructor(message: string, public kind: PublishErrorKind) {
      super(message)
      this.name = 'PublishError'
    }
  }

  // One platform's entry out of library.metadata_json's per-platform map.
  export interface PlatformMeta {
    title: string
    description: string
    hashtags: string[]
  }

  // Parsed [publish] TOML table for a channel (src/config/channel.ts, Task 5).
  export interface PublishChannelConfig {
    slots: string[]
    platforms: Platform[]
    privacy: 'public' | 'unlisted' | 'private'
    categoryId: number
    madeForKids: boolean
  }

  export interface PublishTarget {
    readonly platformId: Platform
    upload(
      req: { videoPath: string; meta: PlatformMeta; publish: PublishChannelConfig },
      accessToken: string,
    ): Promise<{ postId: string; url: string }>
  }

  const platformEntrySchema = z.object({
    title: z.string(),
    description: z.string(),
    hashtags: z.array(z.string()),
  })

  // library.metadata_json is the per-platform map the script stage writes
  // (src/stages/script.ts platformMetaSchema): {youtube:{...}, tiktok:{...},
  // instagram:{...}}, or legacy '{}' for library rows produced before platform
  // metadata existed. Any way that map can fail to yield a valid entry for
  // `platform` — corrupt JSON, a missing key, a malformed entry — falls back
  // to a synthesized meta so old or broken library rows stay publishable
  // instead of blocking their slot forever.
  export function resolvePlatformMeta(
    metadataJson: string,
    platform: Platform,
    fallbackTopic: string,
  ): PlatformMeta {
    const fallback: PlatformMeta = {
      title: fallbackTopic.slice(0, 90),
      description: '',
      hashtags: [],
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(metadataJson)
    } catch {
      return fallback
    }
    if (parsed === null || typeof parsed !== 'object') return fallback
    const entry = (parsed as Record<string, unknown>)[platform]
    const result = platformEntrySchema.safeParse(entry)
    return result.success ? result.data : fallback
  }
  ```

- [ ] **Step 10: Run to green**

  ```bash
  npx vitest run src/publish/types.test.ts
  ```

  Expected: `11 passed` (the 6 from Step 4 plus 5 new `resolvePlatformMeta` cases).

- [ ] **Step 11: Run the full suite**

  ```bash
  npm test
  ```

  Expected: every suite passes, no failures.

- [ ] **Step 12: Commit**

  ```bash
  git add src/publish/types.ts src/publish/types.test.ts
  git commit -m "feat: add resolvePlatformMeta for per-platform library metadata" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 4: Tokens DAO

**Files:**
- Create: `src/publish/tokens.ts`
- Test: `src/publish/tokens.test.ts`

**Interfaces:**
- Consumes:
  - `export function encryptToken(plaintext: string, key: Buffer): Buffer` and `export function decryptToken(blob: Buffer, key: Buffer): string` — `src/publish/crypto.ts` (Task 2)
  - `export type Platform = (typeof PUBLISH_PLATFORMS)[number]` — `src/publish/types.ts` (Task 3)
  - `export function openDb(dbPath: string): Database` — `src/db/index.ts`
  - `oauth_tokens` table: `platform TEXT NOT NULL, channel TEXT NOT NULL, token_ciphertext BLOB NOT NULL, scopes TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY (platform, channel)` — `src/db/schema.sql` (Task 1)
- Produces:
  - `export function upsertToken(db: Database, platform: Platform, channel: string, refreshToken: string, scopes: string, key: Buffer): void`
  - `export function loadRefreshToken(db: Database, platform: Platform, channel: string, key: Buffer): string | null`
  - Consumed by Task 9 (`auth youtube` CLI, writes via `upsertToken`) and Task 10 (`publish-next` tick, reads via `loadRefreshToken` per candidate).

- [ ] **Step 1: Write the failing round-trip / overwrite / missing-row tests**

  Create `src/publish/tokens.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest'
  import { openDb } from '../db/index.js'
  import { loadRefreshToken, upsertToken } from './tokens.js'

  // AES-256-GCM key sized for crypto.ts's parseTokenKey output; filler bytes
  // are fine — these tests never touch parseTokenKey or a real secret.
  const TEST_KEY = Buffer.alloc(32, 0x42)

  describe('upsertToken / loadRefreshToken', () => {
    it('round-trips a stored refresh token through encrypt/decrypt', () => {
      const db = openDb(':memory:')
      upsertToken(
        db,
        'youtube',
        'chan-a',
        'rt-test-token',
        'https://www.googleapis.com/auth/youtube.upload',
        TEST_KEY,
      )
      expect(loadRefreshToken(db, 'youtube', 'chan-a', TEST_KEY)).toBe('rt-test-token')
      db.close()
    })

    it('overwrites the token and scopes on re-upsert, keeping a single row', () => {
      const db = openDb(':memory:')
      upsertToken(db, 'youtube', 'chan-a', 'rt-test-token-1', 'scope-a', TEST_KEY)
      upsertToken(db, 'youtube', 'chan-a', 'rt-test-token-2', 'scope-b', TEST_KEY)
      expect(loadRefreshToken(db, 'youtube', 'chan-a', TEST_KEY)).toBe('rt-test-token-2')
      const rows = db.prepare('SELECT scopes FROM oauth_tokens').all() as { scopes: string }[]
      expect(rows).toEqual([{ scopes: 'scope-b' }])
      db.close()
    })

    it('returns null when no row exists for that platform/channel', () => {
      const db = openDb(':memory:')
      expect(loadRefreshToken(db, 'youtube', 'no-such-channel', TEST_KEY)).toBeNull()
      db.close()
    })
  })
  ```

- [ ] **Step 2: Run, observe the failure**

  ```bash
  npx vitest run src/publish/tokens.test.ts
  ```

  Expected failure: `Error: Failed to resolve import "./tokens.js" from "src/publish/tokens.test.ts". Does the file exist?` — `src/publish/tokens.ts` does not exist yet.

- [ ] **Step 3: Create src/publish/tokens.ts with upsertToken and a bare loadRefreshToken**

  ```ts
  import type { Database } from 'better-sqlite3'
  import { decryptToken, encryptToken } from './crypto.js'
  import type { Platform } from './types.js'

  // One row per platform x channel — each YouTube channel is its own brand
  // account with its own consent grant (design spec §3.2). Only the
  // long-lived refresh token is stored; access tokens are minted per tick
  // and never persisted.
  export function upsertToken(
    db: Database,
    platform: Platform,
    channel: string,
    refreshToken: string,
    scopes: string,
    key: Buffer,
  ): void {
    const ciphertext = encryptToken(refreshToken, key)
    db.prepare(
      'INSERT INTO oauth_tokens (platform, channel, token_ciphertext, scopes) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(platform, channel) DO UPDATE SET ' +
        'token_ciphertext = excluded.token_ciphertext, scopes = excluded.scopes, ' +
        "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    ).run(platform, channel, ciphertext, scopes)
  }

  export function loadRefreshToken(
    db: Database,
    platform: Platform,
    channel: string,
    key: Buffer,
  ): string | null {
    const row = db
      .prepare('SELECT token_ciphertext FROM oauth_tokens WHERE platform = ? AND channel = ?')
      .get(platform, channel) as { token_ciphertext: Buffer } | undefined
    if (row === undefined) return null
    return decryptToken(row.token_ciphertext, key)
  }
  ```

- [ ] **Step 4: Run to green**

  ```bash
  npx vitest run src/publish/tokens.test.ts
  ```

  Expected: `3 passed`.

- [ ] **Step 5: Commit the happy-path DAO**

  ```bash
  git add src/publish/tokens.ts src/publish/tokens.test.ts
  git commit -m "feat: add oauth_tokens upsert/load DAO" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 6: Write the failing corrupt-ciphertext test**

  In `src/publish/tokens.test.ts`, change the vitest import line to:

  ```ts
  import { describe, expect, it, vi } from 'vitest'
  ```

  Then add this test to the end of the `describe('upsertToken / loadRefreshToken', ...)` block, right before its closing `})`:

  ```ts

    it('returns null and writes one stderr line naming platform+channel when the stored ciphertext is tampered', () => {
      const db = openDb(':memory:')
      upsertToken(db, 'youtube', 'chan-a', 'rt-test-token', 'scope-a', TEST_KEY)
      db.prepare(
        'UPDATE oauth_tokens SET token_ciphertext = ? WHERE platform = ? AND channel = ?',
      ).run(Buffer.alloc(40, 0xff), 'youtube', 'chan-a')
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      expect(loadRefreshToken(db, 'youtube', 'chan-a', TEST_KEY)).toBeNull()
      expect(stderrSpy).toHaveBeenCalledTimes(1)
      const line = String(stderrSpy.mock.calls[0][0])
      expect(line).toContain('youtube')
      expect(line).toContain('chan-a')
      expect(line).not.toContain('rt-test-token')
      stderrSpy.mockRestore()
      db.close()
    })
  ```

- [ ] **Step 7: Run, observe the failure**

  ```bash
  npx vitest run src/publish/tokens.test.ts
  ```

  Expected failure: the new test throws before its assertions run — `Error: Unsupported state or unable to authenticate data` (Node's GCM tag check rejects the tampered ciphertext inside `decryptToken`; `loadRefreshToken` has no try/catch yet, so the exception propagates out of the test instead of `loadRefreshToken` returning `null`). Result: `3 passed | 1 failed`.

- [ ] **Step 8: Guard the decrypt call in loadRefreshToken**

  In `src/publish/tokens.ts`, replace the `loadRefreshToken` function with:

  ```ts
  // null covers both "never authed" (no row) and "can't be trusted" (decrypt
  // failure — tampered blob, or a rotated BRAINROT_TOKEN_KEY that no longer
  // opens old ciphertext), so callers treat both the same way: skip this
  // candidate, never crash the tick. A decrypt failure is reported once to
  // stderr naming platform+channel — never token bytes.
  export function loadRefreshToken(
    db: Database,
    platform: Platform,
    channel: string,
    key: Buffer,
  ): string | null {
    const row = db
      .prepare('SELECT token_ciphertext FROM oauth_tokens WHERE platform = ? AND channel = ?')
      .get(platform, channel) as { token_ciphertext: Buffer } | undefined
    if (row === undefined) return null
    try {
      return decryptToken(row.token_ciphertext, key)
    } catch {
      process.stderr.write(`loadRefreshToken: decrypt failed for ${platform}/${channel}\n`)
      return null
    }
  }
  ```

- [ ] **Step 9: Run to green**

  ```bash
  npx vitest run src/publish/tokens.test.ts
  ```

  Expected: `4 passed`.

- [ ] **Step 10: Full suite, then commit the decrypt-failure guard**

  ```bash
  npm test
  git add src/publish/tokens.ts src/publish/tokens.test.ts
  git commit -m "feat: return null and log once on oauth token decrypt failure" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 5: `[publish]` channel config

**Files:**
- Modify: `src/config/channel.ts`, `src/stages/_testkit.ts`
- Test: `src/config/channel.test.ts` (extend existing)

**Interfaces:**

- Consumes (existing/earlier-task code, used as-is):

```ts
// src/publish/types.ts (Task 3 — already on disk by the time this task runs)
export const PUBLISH_PLATFORMS = ['youtube'] as const
export type Platform = (typeof PUBLISH_PLATFORMS)[number]
export interface PublishChannelConfig {
  slots: string[]
  platforms: Platform[]
  privacy: 'public' | 'unlisted' | 'private'
  categoryId: number
  madeForKids: boolean
}
// src/config/channel.ts (existing, extended in place — existing exports unchanged)
export interface ChannelConfig { /* existing fields incl. scout: ScoutConfig */ }
export function loadChannelConfig(path: string): ChannelConfig
export function loadChannelsDir(dir: string): ChannelConfig[]
// src/stages/_testkit.ts (existing, extended in place)
export function testChannel(overrides?: Partial<ChannelConfig>): ChannelConfig
```

- Produces (binding — Task 6 `slots.ts`, Task 10 `publish-next.ts`, and every later fixture that builds a `ChannelConfig` rely on this):

```ts
// src/config/channel.ts
export interface ChannelConfig { /* existing fields */; publish: PublishChannelConfig | null }
// TOML [publish]: absent -> publish: null. Present -> slots required non-empty,
// each /^([01]\d|2[0-3]):[0-5]\d$/, unique, loader sorts ascending; platforms
// optional default ['youtube'], every element in PUBLISH_PLATFORMS; privacy
// optional default 'public'; category_id optional positive int default 24;
// made_for_kids optional bool default false. Result (cfg.publish and its
// slots/platforms arrays) is frozen.
// src/stages/_testkit.ts
export function testChannel(overrides?: Partial<ChannelConfig>): ChannelConfig
// testChannel() now defaults publish: null, overridable via `overrides.publish`
```

House style notes (match them): no semicolons in `src/config/` (`src/stages/_testkit.ts` DOES use semicolons — keep its style when editing it), single quotes, trailing commas, zod raw schema in snake_case mapped to camelCase in the return object. ESM: relative imports end in `.js`. `import type` for type-only imports.

- [ ] **Step 1: Failing test — basic `[publish]` parsing, defaults, sorting**

  In `src/config/channel.test.ts`, append at the end of the file (`PLAN1_LINES` and `writeToml` already exist there; `PLAN1_LINES` ends with an empty string, so appended `[publish]` lines start cleanly after `[budget]`):

  ```ts
  describe('[publish] config', () => {
    it('defaults publish to null when the [publish] table is absent', () => {
      const cfg = loadChannelConfig(writeToml(PLAN1_LINES))
      expect(cfg.publish).toBeNull()
    })

    it('parses a full [publish] table into camelCase', () => {
      const cfg = loadChannelConfig(
        writeToml([
          ...PLAN1_LINES,
          '[publish]',
          'slots = ["10:00", "14:00", "19:00"]',
          'platforms = ["youtube"]',
          'privacy = "unlisted"',
          'category_id = 22',
          'made_for_kids = true',
        ]),
      )
      expect(cfg.publish).toEqual({
        slots: ['10:00', '14:00', '19:00'],
        platforms: ['youtube'],
        privacy: 'unlisted',
        categoryId: 22,
        madeForKids: true,
      })
    })

    it('sorts slots ascending regardless of TOML order', () => {
      const cfg = loadChannelConfig(
        writeToml([...PLAN1_LINES, '[publish]', 'slots = ["19:00", "10:00", "14:00"]']),
      )
      expect(cfg.publish?.slots).toEqual(['10:00', '14:00', '19:00'])
    })

    it('applies platforms/privacy/category_id/made_for_kids defaults when only slots is given', () => {
      const cfg = loadChannelConfig(writeToml([...PLAN1_LINES, '[publish]', 'slots = ["10:00"]']))
      expect(cfg.publish).toEqual({
        slots: ['10:00'],
        platforms: ['youtube'],
        privacy: 'public',
        categoryId: 24,
        madeForKids: false,
      })
    })
  })
  ```

  Run: `npx vitest run src/config/channel.test.ts`

  Expected failure: 4 new tests fail (19 pre-existing tests still pass). `ChannelConfig` has no `publish` member yet, so `raw.publish` is stripped by the unknown-key-stripping `rawSchema` and `cfg.publish` is `undefined` in every new assertion:
  - `'defaults publish to null...'`: `AssertionError: expected undefined to be null`
  - `'parses a full [publish] table...'`: `AssertionError: expected undefined to deeply equal { slots: [ '10:00', '14:00', '19:00' ], platforms: [ 'youtube' ], privacy: 'unlisted', categoryId: 22, madeForKids: true }`
  - `'sorts slots ascending...'`: `AssertionError: expected undefined to deeply equal [ '10:00', '14:00', '19:00' ]`
  - `'applies platforms/privacy/... defaults...'`: `AssertionError: expected undefined to deeply equal { slots: [ '10:00' ], platforms: [ 'youtube' ], privacy: 'public', categoryId: 24, madeForKids: false }`

- [ ] **Step 2: Implement — minimal `[publish]` schema, type, and mapping (no validation yet)**

  Four edits inside `src/config/channel.ts`:

  (a) Change the top imports from

  ```ts
  import { readdirSync, readFileSync } from 'node:fs'
  import { basename, join } from 'node:path'
  import { parse as parseToml } from 'smol-toml'
  import { z } from 'zod'
  ```

  to

  ```ts
  import { readdirSync, readFileSync } from 'node:fs'
  import { basename, join } from 'node:path'
  import { parse as parseToml } from 'smol-toml'
  import { z } from 'zod'
  import type { PublishChannelConfig } from '../publish/types.js'
  ```

  (b) In `ChannelConfig`, add a final member after `scout: ScoutConfig`:

  ```ts
  export interface ChannelConfig {
    name: string
    niche: string[]
    tierMix: { volume: number; premium: number }
    voice: { volume: string; premium?: PremiumVoiceConfig }
    premium: PremiumConfig
    captionStyle: CaptionStyle
    bgDir: string
    bgmDir: string
    budget: { perVideoUsdMicros: number; premiumPerVideoUsdMicros: number; perDayUsdMicros: number }
    scriptModel: string
    scout: ScoutConfig
    publish: PublishChannelConfig | null
  }
  ```

  (c) In `rawSchema`, between the `scout` block's closing `.optional(),` and the `caption_style` field (i.e. insert a new `publish` field right before `caption_style: z.object({`):

  ```ts
    publish: z
      .object({
        slots: z.array(z.string()),
        platforms: z.array(z.string()).default(['youtube']),
        privacy: z.enum(['public', 'unlisted', 'private']).default('public'),
        category_id: z.number().int().positive().default(24),
        made_for_kids: z.boolean().default(false),
      })
      .optional(),
  ```

  (d) In the `loadChannelConfig` return object, after the `scout` ternary's trailing comma (i.e. as the new last property, right before the function's closing `}`):

  ```ts
      publish: raw.publish
        ? {
            slots: [...raw.publish.slots].sort(),
            platforms: raw.publish.platforms,
            privacy: raw.publish.privacy,
            categoryId: raw.publish.category_id,
            madeForKids: raw.publish.made_for_kids,
          }
        : null,
  ```

  Run: `npx vitest run src/config/channel.test.ts` — expect `Test Files  1 passed (1)`, `Tests  23 passed (23)`.

- [ ] **Step 3: Failing test — slot format, uniqueness, non-empty, and platform validation**

  In `src/config/channel.test.ts`, append at the end of the file:

  ```ts
  describe('[publish] validation', () => {
    it('rejects a slot that is not zero-padded 24h HH:MM', () => {
      expect(() =>
        loadChannelConfig(writeToml([...PLAN1_LINES, '[publish]', 'slots = ["9:00"]'])),
      ).toThrow()
      expect(() =>
        loadChannelConfig(writeToml([...PLAN1_LINES, '[publish]', 'slots = ["24:00"]'])),
      ).toThrow()
      expect(() =>
        loadChannelConfig(writeToml([...PLAN1_LINES, '[publish]', 'slots = ["10:60"]'])),
      ).toThrow()
    })

    it('rejects duplicate slots', () => {
      expect(() =>
        loadChannelConfig(writeToml([...PLAN1_LINES, '[publish]', 'slots = ["10:00", "10:00"]'])),
      ).toThrow()
    })

    it('rejects an empty slots array', () => {
      expect(() => loadChannelConfig(writeToml([...PLAN1_LINES, '[publish]', 'slots = []']))).toThrow()
    })

    it('rejects a platform outside PUBLISH_PLATFORMS', () => {
      expect(() =>
        loadChannelConfig(
          writeToml([...PLAN1_LINES, '[publish]', 'slots = ["10:00"]', 'platforms = ["tiktok"]']),
        ),
      ).toThrow()
    })
  })
  ```

  Run: `npx vitest run src/config/channel.test.ts`

  Expected failure: 4 new tests fail (23 pre-existing tests still pass), each `AssertionError: expected [Function] to throw an error` — the raw schema has no HH:MM regex, no duplicate check, no non-empty check, and `platforms` currently accepts any string, so every one of these malformed tables parses without throwing.

- [ ] **Step 4: Implement — slot regex, uniqueness, non-empty, platform enum**

  Two edits inside `src/config/channel.ts`:

  (a) After the line `const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_multilingual_v2'`, add:

  ```ts
  const SLOT_RE = /^([01]\d|2[0-3]):[0-5]\d$/
  ```

  (b) Add the `PUBLISH_PLATFORMS` value import — change

  ```ts
  import type { PublishChannelConfig } from '../publish/types.js'
  ```

  to

  ```ts
  import { PUBLISH_PLATFORMS } from '../publish/types.js'
  import type { PublishChannelConfig } from '../publish/types.js'
  ```

  (c) Replace the `publish` field added in Step 2c with the validated version:

  ```ts
    publish: z
      .object({
        slots: z
          .array(z.string().regex(SLOT_RE, 'slots must be zero-padded 24h HH:MM'))
          .min(1, 'slots must be a non-empty array')
          .refine((slots) => new Set(slots).size === slots.length, {
            message: 'slots must not contain duplicates',
          }),
        platforms: z.array(z.enum(PUBLISH_PLATFORMS)).default(['youtube']),
        privacy: z.enum(['public', 'unlisted', 'private']).default('public'),
        category_id: z.number().int().positive().default(24),
        made_for_kids: z.boolean().default(false),
      })
      .optional(),
  ```

  Run: `npx vitest run src/config/channel.test.ts` — expect `Test Files  1 passed (1)`, `Tests  27 passed (27)`.

- [ ] **Step 5: Failing test — result frozen, `testChannel()` publish default**

  In `src/config/channel.test.ts`, change the import block from

  ```ts
  import { describe, expect, it } from 'vitest'
  import { mkdtempSync, writeFileSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import { DEFAULT_SCOUT, loadChannelConfig, loadChannelsDir } from './channel.js'
  ```

  to

  ```ts
  import { describe, expect, it } from 'vitest'
  import { mkdtempSync, writeFileSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import { DEFAULT_SCOUT, loadChannelConfig, loadChannelsDir } from './channel.js'
  import { testChannel } from '../stages/_testkit.js'
  ```

  Then append at the end of the file:

  ```ts
  describe('[publish] freezing', () => {
    it('freezes the publish object and its arrays', () => {
      const cfg = loadChannelConfig(
        writeToml([...PLAN1_LINES, '[publish]', 'slots = ["10:00", "14:00"]']),
      )
      expect(Object.isFrozen(cfg.publish)).toBe(true)
      expect(Object.isFrozen(cfg.publish?.slots)).toBe(true)
      expect(Object.isFrozen(cfg.publish?.platforms)).toBe(true)
    })
  })

  describe('testChannel() publish default', () => {
    it('defaults publish to null and allows overriding it', () => {
      expect(testChannel().publish).toBeNull()
      const withPublish = testChannel({
        publish: { slots: ['10:00'], platforms: ['youtube'], privacy: 'public', categoryId: 24, madeForKids: false },
      })
      expect(withPublish.publish).toEqual({
        slots: ['10:00'],
        platforms: ['youtube'],
        privacy: 'public',
        categoryId: 24,
        madeForKids: false,
      })
    })
  })
  ```

  Run: `npx vitest run src/config/channel.test.ts`

  Expected failure: 2 new tests fail (27 pre-existing tests still pass):
  - `'freezes the publish object and its arrays'`: `AssertionError: expected false to be true` (`cfg.publish` is a plain, unfrozen object built by the Step 2/4 ternary)
  - `'defaults publish to null and allows overriding it'`: `AssertionError: expected undefined to be null` (`testChannel()`'s returned object has no `publish` key yet)

- [ ] **Step 6: Implement — freeze the publish result; `testChannel()` publish default**

  Two edits:

  (a) In `src/config/channel.ts`, replace the `publish` mapping added in Step 2d with the frozen version:

  ```ts
      publish: raw.publish
        ? (Object.freeze({
            slots: Object.freeze([...raw.publish.slots].sort()),
            platforms: Object.freeze([...raw.publish.platforms]),
            privacy: raw.publish.privacy,
            categoryId: raw.publish.category_id,
            madeForKids: raw.publish.made_for_kids,
          }) as PublishChannelConfig)
        : null,
  ```

  (b) In `src/stages/_testkit.ts`, in the `testChannel` return object, add `publish: null,` right before `...overrides,`:

  ```ts
  export function testChannel(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
    return {
      name: 'test',
      niche: ['space facts', 'astronomy'],
      tierMix: { volume: 2, premium: 1 },
      voice: {
        volume: 'af_heart',
        premium: { provider: 'elevenlabs', voiceId: 'EXAVITQu4vr4xnSDxMaL', modelId: 'eleven_multilingual_v2' },
      },
      premium: { ...DEFAULT_PREMIUM },
      captionStyle: { font: 'Inter', fontSizePx: 72, activeColor: '#FFD700', inactiveColor: '#FFFFFF', strokePx: 8 },
      bgDir: 'assets/bg',
      bgmDir: 'assets/bgm',
      budget: { perVideoUsdMicros: 8_000_000, premiumPerVideoUsdMicros: 7_000_000, perDayUsdMicros: 20_000_000 },
      scriptModel: 'claude-sonnet-5',
      scout: { ...DEFAULT_SCOUT },
      publish: null,
      ...overrides,
    };
  }
  ```

  Run: `npx vitest run src/config/channel.test.ts` — expect `Test Files  1 passed (1)`, `Tests  29 passed (29)`.

- [ ] **Step 7: Patch existing `ChannelConfig` literals and gate on the compiler**

  `publish` is a required field, and `tsconfig.json` includes all of `src/` — so every test file that builds a `ChannelConfig` value directly (bypassing `testChannel`) now fails `tsc --noEmit` even though vitest (which transpiles without type-checking) still runs it. As of plan-writing time the six files below build such values; add `publish: null,` to each builder's literal:

  - `src/jobs/runner.test.ts` (the channel literal near the top)
  - `src/jobs/costs.test.ts` (the channel-builder function)
  - `src/stages/assemble.test.ts` (`makeChannel`)
  - `src/stages/visuals-volume.test.ts` (`makeChannel`)
  - `src/stages/visuals-premium.test.ts` (`premiumChannel`)
  - `src/scout/scout.test.ts` (`scoutedChannel`)

  (`src/loop/plan-tick.test.ts` needs nothing — it builds channels via `testChannel(...)` overrides, which this task already defaults.) Place `publish: null,` alongside the other top-level fields, matching each literal's field order.

  Run: `npx tsc --noEmit`
  Expected: no output, exit 0. **The compiler is the authoritative list** — if it flags a TS2741/TS2345 in any file not named above, patch that file the same way before moving on.

  Run: `npm test`

  Expected: every test file passes, zero failures — the field is behaviorally inert (`null` = publishing disabled) so no runtime assertions change.

- [ ] **Step 8: Commit the `[publish]` channel config**

  ```bash
  git add src/config/channel.ts src/config/channel.test.ts src/stages/_testkit.ts \
    src/jobs/runner.test.ts src/jobs/costs.test.ts src/stages/assemble.test.ts \
    src/stages/visuals-volume.test.ts src/stages/visuals-premium.test.ts src/scout/scout.test.ts
  git commit -m "$(cat <<'EOF'
  feat: add [publish] channel config table with defaults

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

### Task 6: Slot math (pure)

**Files:**
- Create: `src/publish/slots.ts`, `src/publish/slots.test.ts`
- Modify: none
- Test: `src/publish/slots.test.ts`

**Interfaces:**
- Consumes: `Platform` and `PublishChannelConfig` from `src/publish/types.ts` (Task 3) — `PublishChannelConfig.slots: string[]` is guaranteed non-empty, `'HH:MM'` zero-padded, unique, and sorted ascending by the Task 5 config loader before it ever reaches this module.
- Produces (binding — Task 10's `publishNextTick` imports all five names):
  ```ts
  export function localDay(now: Date): string
  export function localHHMM(now: Date): string
  export function dueSlotsForChannel(cfg: PublishChannelConfig, consumed: Set<string>, now: Date): string[]
  export interface SlotCandidate { channel: string; platform: Platform; slot: string; filledCount: number; totalSlots: number }
  export function orderCandidates(candidates: SlotCandidate[]): SlotCandidate[]
  ```

---

- [ ] **Step 1: Write the failing `localDay`/`localHHMM` tests**

  Create `src/publish/slots.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest'
  import { localDay, localHHMM } from './slots.js'

  describe('localDay', () => {
    it('renders YYYY-MM-DD in local time, zero-padded', () => {
      expect(localDay(new Date(2026, 6, 22, 14, 30))).toBe('2026-07-22')
    })

    it('zero-pads a single-digit month and day', () => {
      expect(localDay(new Date(2026, 0, 5, 9, 3))).toBe('2026-01-05')
    })
  })

  describe('localHHMM', () => {
    it('renders HH:MM in local time, zero-padded', () => {
      expect(localHHMM(new Date(2026, 6, 22, 14, 30))).toBe('14:30')
    })

    it('zero-pads a single-digit hour and minute', () => {
      expect(localHHMM(new Date(2026, 0, 5, 9, 3))).toBe('09:03')
    })
  })
  ```

  Run: `npx vitest run src/publish/slots.test.ts`

  Expected failure: `src/publish/slots.ts` does not exist yet, so the whole file errors at import/collection time (0 tests run, reported under `Failed Suites 1`):
  ```
  Error: Cannot find module './slots.js' imported from /Users/alex/code/project-brainrot/src/publish/slots.test.ts
  ```
  Summary line: `Test Files  1 failed (1)`, `Tests  no tests`.

- [ ] **Step 2: Implement `localDay` + `localHHMM`, run green**

  Create `src/publish/slots.ts`:

  ```ts
  // 'YYYY-MM-DD' in the MACHINE's local time zone — never toISOString() (that
  // renders UTC). Slot bookkeeping is deliberately local (design spec §13): a
  // channel's posting slots are wall-clock times on this machine, not UTC.
  export function localDay(now: Date): string {
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  // 'HH:MM' zero-padded machine-local. Same-length zero-padded strings compare
  // lexicographically in chronological order, which is what dueSlotsForChannel
  // and the channel config's `slots` entries rely on.
  export function localHHMM(now: Date): string {
    const hours = String(now.getHours()).padStart(2, '0')
    const minutes = String(now.getMinutes()).padStart(2, '0')
    return `${hours}:${minutes}`
  }
  ```

  Run: `npx vitest run src/publish/slots.test.ts`

  Expected: `Test Files  1 passed (1)`, `Tests  4 passed (4)`.

- [ ] **Step 3: Write the failing `dueSlotsForChannel` tests**

  Replace the full contents of `src/publish/slots.test.ts` with:

  ```ts
  import { describe, expect, it } from 'vitest'
  import type { PublishChannelConfig } from './types.js'
  import { dueSlotsForChannel, localDay, localHHMM } from './slots.js'

  describe('localDay', () => {
    it('renders YYYY-MM-DD in local time, zero-padded', () => {
      expect(localDay(new Date(2026, 6, 22, 14, 30))).toBe('2026-07-22')
    })

    it('zero-pads a single-digit month and day', () => {
      expect(localDay(new Date(2026, 0, 5, 9, 3))).toBe('2026-01-05')
    })
  })

  describe('localHHMM', () => {
    it('renders HH:MM in local time, zero-padded', () => {
      expect(localHHMM(new Date(2026, 6, 22, 14, 30))).toBe('14:30')
    })

    it('zero-pads a single-digit hour and minute', () => {
      expect(localHHMM(new Date(2026, 0, 5, 9, 3))).toBe('09:03')
    })
  })

  // slots already sorted ascending, exactly as the config loader (Task 5) leaves them.
  function channelWithSlots(slots: string[]): PublishChannelConfig {
    return {
      slots,
      platforms: ['youtube'],
      privacy: 'public',
      categoryId: 24,
      madeForKids: false,
    }
  }

  describe('dueSlotsForChannel', () => {
    const cfg = channelWithSlots(['10:00', '14:00', '19:00'])

    it('is empty before the first slot', () => {
      expect(dueSlotsForChannel(cfg, new Set(), new Date(2026, 6, 22, 9, 59))).toEqual([])
    })

    it('includes a slot exactly at its boundary (slot == now counts as due)', () => {
      expect(dueSlotsForChannel(cfg, new Set(), new Date(2026, 6, 22, 10, 0))).toEqual(['10:00'])
    })

    it('includes only slots at-or-before now, preserving ascending order', () => {
      expect(dueSlotsForChannel(cfg, new Set(), new Date(2026, 6, 22, 14, 30))).toEqual([
        '10:00',
        '14:00',
      ])
    })

    it('includes every slot once the day is done, with an empty consumed set', () => {
      expect(dueSlotsForChannel(cfg, new Set(), new Date(2026, 6, 22, 23, 0))).toEqual([
        '10:00',
        '14:00',
        '19:00',
      ])
    })

    it('is empty once every slot for the day is consumed', () => {
      const consumed = new Set(['10:00', '14:00', '19:00'])
      expect(dueSlotsForChannel(cfg, consumed, new Date(2026, 6, 22, 23, 0))).toEqual([])
    })

    it('skips only the consumed slots, preserving order for the rest', () => {
      const consumed = new Set(['14:00'])
      expect(dueSlotsForChannel(cfg, consumed, new Date(2026, 6, 22, 23, 0))).toEqual([
        '10:00',
        '19:00',
      ])
    })
  })
  ```

  Run: `npx vitest run src/publish/slots.test.ts`

  Expected failure: `slots.js` exists and exports `localDay`/`localHHMM`, but not `dueSlotsForChannel` — the import resolves, so the module loads and the 4 existing tests still pass; each of the 6 new tests calls the missing binding directly and fails at runtime:
  ```
  TypeError: dueSlotsForChannel is not a function
  ```
  Summary line: `Test Files  1 failed (1)`, `Tests  6 failed | 4 passed (10)`.

- [ ] **Step 4: Implement `dueSlotsForChannel`, run green**

  Replace the full contents of `src/publish/slots.ts` with:

  ```ts
  import type { PublishChannelConfig } from './types.js'

  // 'YYYY-MM-DD' in the MACHINE's local time zone — never toISOString() (that
  // renders UTC). Slot bookkeeping is deliberately local (design spec §13): a
  // channel's posting slots are wall-clock times on this machine, not UTC.
  export function localDay(now: Date): string {
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  // 'HH:MM' zero-padded machine-local. Same-length zero-padded strings compare
  // lexicographically in chronological order, which is what dueSlotsForChannel
  // and the channel config's `slots` entries rely on.
  export function localHHMM(now: Date): string {
    const hours = String(now.getHours()).padStart(2, '0')
    const minutes = String(now.getMinutes()).padStart(2, '0')
    return `${hours}:${minutes}`
  }

  // Slots whose time has arrived — slot <= now, so a slot exactly matching the
  // current minute counts as due (design spec §6 step 3) — and that have not
  // already consumed a publishes row today. cfg.slots is already sorted
  // ascending by the config loader (Task 5); filtering alone preserves order.
  export function dueSlotsForChannel(
    cfg: PublishChannelConfig,
    consumed: Set<string>,
    now: Date,
  ): string[] {
    const nowHHMM = localHHMM(now)
    return cfg.slots.filter((slot) => slot <= nowHHMM && !consumed.has(slot))
  }
  ```

  Run: `npx vitest run src/publish/slots.test.ts`

  Expected: `Test Files  1 passed (1)`, `Tests  10 passed (10)`.

- [ ] **Step 5: Write the failing `orderCandidates` tests**

  Replace the full contents of `src/publish/slots.test.ts` with:

  ```ts
  import { describe, expect, it } from 'vitest'
  import type { PublishChannelConfig } from './types.js'
  import { dueSlotsForChannel, localDay, localHHMM, orderCandidates } from './slots.js'
  import type { SlotCandidate } from './slots.js'

  describe('localDay', () => {
    it('renders YYYY-MM-DD in local time, zero-padded', () => {
      expect(localDay(new Date(2026, 6, 22, 14, 30))).toBe('2026-07-22')
    })

    it('zero-pads a single-digit month and day', () => {
      expect(localDay(new Date(2026, 0, 5, 9, 3))).toBe('2026-01-05')
    })
  })

  describe('localHHMM', () => {
    it('renders HH:MM in local time, zero-padded', () => {
      expect(localHHMM(new Date(2026, 6, 22, 14, 30))).toBe('14:30')
    })

    it('zero-pads a single-digit hour and minute', () => {
      expect(localHHMM(new Date(2026, 0, 5, 9, 3))).toBe('09:03')
    })
  })

  // slots already sorted ascending, exactly as the config loader (Task 5) leaves them.
  function channelWithSlots(slots: string[]): PublishChannelConfig {
    return {
      slots,
      platforms: ['youtube'],
      privacy: 'public',
      categoryId: 24,
      madeForKids: false,
    }
  }

  describe('dueSlotsForChannel', () => {
    const cfg = channelWithSlots(['10:00', '14:00', '19:00'])

    it('is empty before the first slot', () => {
      expect(dueSlotsForChannel(cfg, new Set(), new Date(2026, 6, 22, 9, 59))).toEqual([])
    })

    it('includes a slot exactly at its boundary (slot == now counts as due)', () => {
      expect(dueSlotsForChannel(cfg, new Set(), new Date(2026, 6, 22, 10, 0))).toEqual(['10:00'])
    })

    it('includes only slots at-or-before now, preserving ascending order', () => {
      expect(dueSlotsForChannel(cfg, new Set(), new Date(2026, 6, 22, 14, 30))).toEqual([
        '10:00',
        '14:00',
      ])
    })

    it('includes every slot once the day is done, with an empty consumed set', () => {
      expect(dueSlotsForChannel(cfg, new Set(), new Date(2026, 6, 22, 23, 0))).toEqual([
        '10:00',
        '14:00',
        '19:00',
      ])
    })

    it('is empty once every slot for the day is consumed', () => {
      const consumed = new Set(['10:00', '14:00', '19:00'])
      expect(dueSlotsForChannel(cfg, consumed, new Date(2026, 6, 22, 23, 0))).toEqual([])
    })

    it('skips only the consumed slots, preserving order for the rest', () => {
      const consumed = new Set(['14:00'])
      expect(dueSlotsForChannel(cfg, consumed, new Date(2026, 6, 22, 23, 0))).toEqual([
        '10:00',
        '19:00',
      ])
    })
  })

  function candidate(overrides: Partial<SlotCandidate> = {}): SlotCandidate {
    return {
      channel: 'chan-a',
      platform: 'youtube',
      slot: '10:00',
      filledCount: 0,
      totalSlots: 1,
      ...overrides,
    }
  }

  describe('orderCandidates', () => {
    it('sorts by filled fraction ascending via integer cross-multiplication (0-filled beats a partial channel)', () => {
      // 1/3 (chan-a) vs 0/2 (chan-b): 0/2 is the emptier channel despite fewer total slots.
      const a = candidate({ channel: 'chan-a', filledCount: 1, totalSlots: 3 })
      const b = candidate({ channel: 'chan-b', filledCount: 0, totalSlots: 2 })
      expect(orderCandidates([a, b]).map((c) => c.channel)).toEqual(['chan-b', 'chan-a'])
    })

    it('breaks a fraction tie (1/2 == 2/4) by slot ascending', () => {
      const late = candidate({ channel: 'chan-c', slot: '11:00', filledCount: 1, totalSlots: 2 })
      const early = candidate({ channel: 'chan-d', slot: '09:00', filledCount: 2, totalSlots: 4 })
      expect(orderCandidates([late, early]).map((c) => c.channel)).toEqual(['chan-d', 'chan-c'])
    })

    it('breaks a fraction+slot tie by channel name ascending', () => {
      const z = candidate({ channel: 'chan-z', slot: '10:00', filledCount: 1, totalSlots: 2 })
      const a = candidate({ channel: 'chan-a', slot: '10:00', filledCount: 1, totalSlots: 2 })
      expect(orderCandidates([z, a]).map((c) => c.channel)).toEqual(['chan-a', 'chan-z'])
    })

    it('returns a new array, leaving the input order untouched', () => {
      const a = candidate({ channel: 'chan-a', filledCount: 1, totalSlots: 3 })
      const b = candidate({ channel: 'chan-b', filledCount: 0, totalSlots: 2 })
      const input = [a, b]
      const output = orderCandidates(input)
      expect(output).not.toBe(input)
      expect(input.map((c) => c.channel)).toEqual(['chan-a', 'chan-b'])
      expect(output.map((c) => c.channel)).toEqual(['chan-b', 'chan-a'])
    })

    it('applies all three tiebreakers together across a mixed candidate set', () => {
      const candidates = [
        candidate({ channel: 'chan-z', slot: '10:00', filledCount: 1, totalSlots: 2 }), // 0.5
        candidate({ channel: 'chan-a', slot: '10:00', filledCount: 1, totalSlots: 2 }), // 0.5, ties chan-z
        candidate({ channel: 'chan-b', slot: '09:00', filledCount: 0, totalSlots: 3 }), // 0
        candidate({ channel: 'chan-c', slot: '11:00', filledCount: 0, totalSlots: 5 }), // 0, ties chan-b on fraction, later slot
      ]
      expect(orderCandidates(candidates).map((c) => c.channel)).toEqual([
        'chan-b',
        'chan-c',
        'chan-a',
        'chan-z',
      ])
    })
  })
  ```

  Run: `npx vitest run src/publish/slots.test.ts`

  Expected failure: `slots.js` does not export `orderCandidates` (or `SlotCandidate`) yet; the 10 existing tests still pass, and each of the 5 new tests fails at runtime calling the missing binding:
  ```
  TypeError: orderCandidates is not a function
  ```
  Summary line: `Test Files  1 failed (1)`, `Tests  5 failed | 10 passed (15)`.

- [ ] **Step 6: Implement `orderCandidates`, run green, commit**

  Replace the full contents of `src/publish/slots.ts` with:

  ```ts
  import type { Platform, PublishChannelConfig } from './types.js'

  // 'YYYY-MM-DD' in the MACHINE's local time zone — never toISOString() (that
  // renders UTC). Slot bookkeeping is deliberately local (design spec §13): a
  // channel's posting slots are wall-clock times on this machine, not UTC.
  export function localDay(now: Date): string {
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  // 'HH:MM' zero-padded machine-local. Same-length zero-padded strings compare
  // lexicographically in chronological order, which is what dueSlotsForChannel
  // and the channel config's `slots` entries rely on.
  export function localHHMM(now: Date): string {
    const hours = String(now.getHours()).padStart(2, '0')
    const minutes = String(now.getMinutes()).padStart(2, '0')
    return `${hours}:${minutes}`
  }

  // Slots whose time has arrived — slot <= now, so a slot exactly matching the
  // current minute counts as due (design spec §6 step 3) — and that have not
  // already consumed a publishes row today. cfg.slots is already sorted
  // ascending by the config loader (Task 5); filtering alone preserves order.
  export function dueSlotsForChannel(
    cfg: PublishChannelConfig,
    consumed: Set<string>,
    now: Date,
  ): string[] {
    const nowHHMM = localHHMM(now)
    return cfg.slots.filter((slot) => slot <= nowHHMM && !consumed.has(slot))
  }

  export interface SlotCandidate {
    channel: string
    platform: Platform
    slot: string
    filledCount: number
    totalSlots: number
  }

  // Fairness order for the tick's candidate pass (design spec §6 step 5):
  // least-filled channel first, earliest due slot next, channel name last for
  // determinism across ticks with identical fractions. filledCount/totalSlots
  // is compared by cross-multiplication (a.filledCount * b.totalSlots vs
  // b.filledCount * a.totalSlots) instead of division — totalSlots is always a
  // positive slot count, so multiplying preserves the comparison's direction
  // with zero float-rounding risk. Pure: sorts a copy, never the caller's array.
  export function orderCandidates(candidates: SlotCandidate[]): SlotCandidate[] {
    return [...candidates].sort((a, b) => {
      const fractionDiff = a.filledCount * b.totalSlots - b.filledCount * a.totalSlots
      if (fractionDiff !== 0) return fractionDiff
      if (a.slot !== b.slot) return a.slot < b.slot ? -1 : 1
      return a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0
    })
  }
  ```

  Run: `npx vitest run src/publish/slots.test.ts`

  Expected: `Test Files  1 passed (1)`, `Tests  15 passed (15)`.

  Then run the full suite once: `npx vitest run`. Expect no regressions (all prior suites still pass; `src/publish/slots.test.ts` adds its 15 to the total).

  Commit:

  ```bash
  git add src/publish/slots.ts src/publish/slots.test.ts && git commit -m "$(cat <<'EOF'
  feat: pure local-time slot due-check and candidate ordering for publish-next

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

### Task 7: Publishes DAO

**Files:**
- Create: `src/publish/publishes.ts`
- Test: `src/publish/publishes.test.ts`

**Interfaces:**

Consumes (existing/earlier-task code — verbatim):
```ts
// src/db/index.ts
export function openDb(dbPath: string): Database   // better-sqlite3; FKs OFF by design

// src/publish/types.ts (Task 3)
export const PUBLISH_PLATFORMS = ['youtube'] as const
export type Platform = (typeof PUBLISH_PLATFORMS)[number]
export type PublishErrorKind = 'auth' | 'quota' | 'rejected' | 'transient'

// src/db/schema.sql (Task 1) — publishes table
// columns: id, job_id, platform, channel, day, slot, status, post_id, url,
// error, error_kind, attempt, created_at, finished_at
// UNIQUE (channel, platform, day, slot); status CHECK IN ('claimed','done','failed','interrupted')

// jobs table (existing): id, channel, tier, topic, status, created_at, finished_at
// library table (existing): job_id, video_path, metadata_json, state, created_at
```

Produces (Tasks 10, 12, 13 rely on these exact signatures):
```ts
// src/publish/publishes.ts
export const MAX_PUBLISH_ATTEMPTS = 3
export type PublishStatus = 'claimed' | 'done' | 'failed' | 'interrupted'
export interface PublishRow {
  id: number; jobId: string; platform: Platform; channel: string
  day: string; slot: string; status: PublishStatus
  postId: string | null; url: string | null; error: string | null
  errorKind: PublishErrorKind | null; attempt: number
  createdAt: string; finishedAt: string | null
}
export function claimPublish(db: Database, opts: { jobId: string; platform: Platform; channel: string; day: string; slot: string }): number | null
export function markPublishDone(db: Database, id: number, postId: string, url: string, now: Date): void
export function markPublishFailed(db: Database, id: number, error: string, kind: PublishErrorKind, now: Date): void
export function sweepInterrupted(db: Database, olderThanMs: number, now: Date): number
export function consumedSlots(db: Database, channel: string, platform: Platform, day: string): Set<string>
export function uploadsUsedToday(db: Database, platform: Platform, day: string): number
export function eligibleVideo(db: Database, channel: string, platform: Platform): { jobId: string; videoPath: string; metadataJson: string; topic: string } | null
export function listPublishes(db: Database, opts?: { sinceDays?: number }): PublishRow[]   // default 7 (UTC created_at window)
export function retryInterrupted(db: Database, jobId: string): boolean
export function markInterruptedDone(db: Database, jobId: string, postId: string, url: string, now: Date): boolean
```

House rules in force: ESM `.js` suffixes on relative imports; real SQLite in tests via `openDb(':memory:')`; write transactions via `db.transaction(fn)()`; DB rows are snake_case, mapped to camelCase via a private `toPublishRow` mapper (`src/scout/topics.ts` style); conventional commits with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

---

- [ ] **Step 1: Write the failing claimPublish test**

  Create `src/publish/publishes.test.ts` (new directory `src/publish/`):

  ```ts
  import { describe, expect, it } from 'vitest'
  import type { Database } from 'better-sqlite3'
  import { openDb } from '../db/index.js'
  import { claimPublish } from './publishes.js'

  // Raw-insert seed: publishes.job_id references jobs(id) (FKs are OFF, but
  // every fixture stays realistic — eligibleVideo's JOIN through jobs needs a
  // real row). One helper covers every test below; overrides keep each test
  // declaring only what it cares about.
  function seedJob(
    db: Database,
    id: string,
    overrides: Partial<{ channel: string; tier: string; topic: string; status: string }> = {},
  ): void {
    db.prepare('INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, ?, ?, ?, ?)').run(
      id,
      overrides.channel ?? 'chan-a',
      overrides.tier ?? 'volume',
      overrides.topic ?? 'seeded topic',
      overrides.status ?? 'done',
    )
  }

  describe('claimPublish', () => {
    it('numbers attempts 1-based per (jobId, platform), counting every prior row regardless of slot or day', () => {
      const db = openDb(':memory:')
      seedJob(db, 'job-1')

      const id1 = claimPublish(db, {
        jobId: 'job-1',
        platform: 'youtube',
        channel: 'chan-a',
        day: '2026-07-20',
        slot: '10:00',
      })
      expect(id1).not.toBeNull()
      expect(
        (db.prepare('SELECT attempt FROM publishes WHERE id = ?').get(id1) as { attempt: number })
          .attempt,
      ).toBe(1)
      db.prepare("UPDATE publishes SET status = 'failed' WHERE id = ?").run(id1)

      const id2 = claimPublish(db, {
        jobId: 'job-1',
        platform: 'youtube',
        channel: 'chan-a',
        day: '2026-07-20',
        slot: '14:00',
      })
      expect(
        (db.prepare('SELECT attempt FROM publishes WHERE id = ?').get(id2) as { attempt: number })
          .attempt,
      ).toBe(2)
      db.prepare("UPDATE publishes SET status = 'failed' WHERE id = ?").run(id2)

      const id3 = claimPublish(db, {
        jobId: 'job-1',
        platform: 'youtube',
        channel: 'chan-a',
        day: '2026-07-21',
        slot: '10:00',
      })
      expect(
        (db.prepare('SELECT attempt FROM publishes WHERE id = ?').get(id3) as { attempt: number })
          .attempt,
      ).toBe(3)
      db.close()
    })

    it('returns null on a UNIQUE (channel, platform, day, slot) conflict and writes nothing', () => {
      const db = openDb(':memory:')
      seedJob(db, 'job-1')
      seedJob(db, 'job-2')

      const first = claimPublish(db, {
        jobId: 'job-1',
        platform: 'youtube',
        channel: 'chan-a',
        day: '2026-07-20',
        slot: '10:00',
      })
      expect(first).not.toBeNull()

      const conflict = claimPublish(db, {
        jobId: 'job-2',
        platform: 'youtube',
        channel: 'chan-a',
        day: '2026-07-20',
        slot: '10:00',
      })
      expect(conflict).toBeNull()

      const rows = db.prepare('SELECT job_id FROM publishes').all() as { job_id: string }[]
      expect(rows).toEqual([{ job_id: 'job-1' }])
      db.close()
    })
  })
  ```

- [ ] **Step 2: Run, observe the failure**

  ```bash
  npx vitest run src/publish/publishes.test.ts
  ```

  Expected failure: `Error: Cannot find module './publishes.js' imported from .../src/publish/publishes.test.ts` — the module does not exist yet.

- [ ] **Step 3: Create src/publish/publishes.ts with claimPublish**

  ```ts
  import type { Database } from 'better-sqlite3'
  import BetterSqlite3 from 'better-sqlite3'
  import type { Platform, PublishErrorKind } from './types.js'

  export type PublishStatus = 'claimed' | 'done' | 'failed' | 'interrupted'

  export interface PublishRow {
    id: number
    jobId: string
    platform: Platform
    channel: string
    day: string
    slot: string
    status: PublishStatus
    postId: string | null
    url: string | null
    error: string | null
    errorKind: PublishErrorKind | null
    attempt: number
    createdAt: string
    finishedAt: string | null
  }

  // Attempt cap for the eligibility pool (design spec decision 8): a job with
  // this many 'rejected'-kind failures retires from rotation and is
  // digest-flagged — auth/quota/transient failures never count toward it.
  export const MAX_PUBLISH_ATTEMPTS = 3

  // INSERT a claimed row; attempt = 1 + count of every prior row for this
  // (jobId, platform), computed inside the same transaction so a concurrent
  // claim can never observe a half-written count. The UNIQUE (channel,
  // platform, day, slot) constraint IS the slot bookkeeping (design spec
  // §3.1) — a conflict here means a racing tick already took the slot, so
  // the SqliteError from the INSERT (and only the INSERT) is caught and
  // reported as null rather than propagated.
  export function claimPublish(
    db: Database,
    opts: { jobId: string; platform: Platform; channel: string; day: string; slot: string },
  ): number | null {
    const countPriorAttempts = db.prepare(
      'SELECT COUNT(*) AS n FROM publishes WHERE job_id = ? AND platform = ?',
    )
    const insertClaim = db.prepare(
      "INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt) " +
        "VALUES (?, ?, ?, ?, ?, 'claimed', ?)",
    )
    const claim = db.transaction((): number | null => {
      const { n } = countPriorAttempts.get(opts.jobId, opts.platform) as { n: number }
      try {
        const info = insertClaim.run(
          opts.jobId,
          opts.platform,
          opts.channel,
          opts.day,
          opts.slot,
          n + 1,
        )
        return Number(info.lastInsertRowid)
      } catch (err) {
        if (err instanceof BetterSqlite3.SqliteError && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return null
        }
        throw err
      }
    })
    return claim()
  }
  ```

- [ ] **Step 4: Run to green**

  ```bash
  npx vitest run src/publish/publishes.test.ts
  ```

  Expected: `2 passed`.

- [ ] **Step 5: Commit claimPublish**

  ```bash
  git add src/publish/publishes.ts src/publish/publishes.test.ts
  git commit -m "feat: add claimPublish with per-(job,platform) attempt numbering" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 6: Write the failing markPublishDone / markPublishFailed tests**

  Extend the import line in `src/publish/publishes.test.ts`:

  ```ts
  import { claimPublish, markPublishDone, markPublishFailed } from './publishes.js'
  ```

  Add a `seedLibrary` helper and two describe blocks at the bottom:

  ```ts
  // Same insert shape the runner's final-gate library upsert writes
  // (src/jobs/runner.ts).
  function seedLibrary(
    db: Database,
    jobId: string,
    overrides: Partial<{
      videoPath: string
      metadataJson: string
      state: string
      createdAt: string
    }> = {},
  ): void {
    db.prepare(
      'INSERT INTO library (job_id, video_path, metadata_json, state, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      jobId,
      overrides.videoPath ?? '/tmp/out.mp4',
      overrides.metadataJson ?? '{}',
      overrides.state ?? 'ready',
      overrides.createdAt ?? new Date().toISOString(),
    )
  }

  describe('markPublishDone', () => {
    it('flips the publish row to done and the library row to published in one transaction', () => {
      const db = openDb(':memory:')
      seedJob(db, 'job-1')
      seedLibrary(db, 'job-1', { state: 'ready' })
      const id = claimPublish(db, {
        jobId: 'job-1',
        platform: 'youtube',
        channel: 'chan-a',
        day: '2026-07-20',
        slot: '10:00',
      }) as number

      markPublishDone(
        db,
        id,
        'yt-abc123',
        'https://youtube.com/shorts/yt-abc123',
        new Date('2026-07-20T10:01:00.000Z'),
      )

      expect(
        db.prepare('SELECT status, post_id, url, finished_at FROM publishes WHERE id = ?').get(id),
      ).toEqual({
        status: 'done',
        post_id: 'yt-abc123',
        url: 'https://youtube.com/shorts/yt-abc123',
        finished_at: '2026-07-20T10:01:00.000Z',
      })
      expect(
        (db.prepare('SELECT state FROM library WHERE job_id = ?').get('job-1') as { state: string })
          .state,
      ).toBe('published')
      db.close()
    })
  })

  describe('markPublishFailed', () => {
    it('records the failure and leaves the library row ready', () => {
      const db = openDb(':memory:')
      seedJob(db, 'job-1')
      seedLibrary(db, 'job-1', { state: 'ready' })
      const id = claimPublish(db, {
        jobId: 'job-1',
        platform: 'youtube',
        channel: 'chan-a',
        day: '2026-07-20',
        slot: '10:00',
      }) as number

      markPublishFailed(
        db,
        id,
        'upload rejected: bad metadata',
        'rejected',
        new Date('2026-07-20T10:02:00.000Z'),
      )

      expect(
        db
          .prepare('SELECT status, error, error_kind, finished_at FROM publishes WHERE id = ?')
          .get(id),
      ).toEqual({
        status: 'failed',
        error: 'upload rejected: bad metadata',
        error_kind: 'rejected',
        finished_at: '2026-07-20T10:02:00.000Z',
      })
      expect(
        (db.prepare('SELECT state FROM library WHERE job_id = ?').get('job-1') as { state: string })
          .state,
      ).toBe('ready')
      db.close()
    })
  })
  ```

- [ ] **Step 7: Run, observe the failure**

  ```bash
  npx vitest run src/publish/publishes.test.ts
  ```

  Expected failure: 2 failed — `TypeError: markPublishDone is not a function` and `TypeError: markPublishFailed is not a function`.

- [ ] **Step 8: Implement markPublishDone and markPublishFailed**

  Append to `src/publish/publishes.ts`:

  ```ts
  // ONE transaction: the publishes row flips to done with its post facts, AND
  // the library row flips to 'published' — no window where one fact is
  // visible without the other (design spec §6 step 9). A missing id is a
  // silent no-op (defensive; the tick only ever calls this with an id it
  // just claimed).
  export function markPublishDone(
    db: Database,
    id: number,
    postId: string,
    url: string,
    now: Date,
  ): void {
    const selectJobId = db.prepare('SELECT job_id FROM publishes WHERE id = ?')
    const updatePublish = db.prepare(
      "UPDATE publishes SET status = 'done', post_id = ?, url = ?, finished_at = ? WHERE id = ?",
    )
    const updateLibrary = db.prepare("UPDATE library SET state = 'published' WHERE job_id = ?")
    db.transaction(() => {
      const row = selectJobId.get(id) as { job_id: string } | undefined
      if (row === undefined) return
      updatePublish.run(postId, url, now.toISOString(), id)
      updateLibrary.run(row.job_id)
    })()
  }

  // Failure never touches the library row: the video stays 'ready' and
  // re-enters the eligibility pool for the next slot (design spec decision 7).
  export function markPublishFailed(
    db: Database,
    id: number,
    error: string,
    kind: PublishErrorKind,
    now: Date,
  ): void {
    db.prepare(
      "UPDATE publishes SET status = 'failed', error = ?, error_kind = ?, finished_at = ? WHERE id = ?",
    ).run(error, kind, now.toISOString(), id)
  }
  ```

- [ ] **Step 9: Run to green**

  ```bash
  npx vitest run src/publish/publishes.test.ts
  ```

  Expected: `4 passed`.

- [ ] **Step 10: Commit markPublishDone/markPublishFailed**

  ```bash
  git add src/publish/publishes.ts src/publish/publishes.test.ts
  git commit -m "feat: add markPublishDone/markPublishFailed publish-outcome transitions" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 11: Write the failing sweepInterrupted test**

  Extend the import line in `src/publish/publishes.test.ts`:

  ```ts
  import { claimPublish, markPublishDone, markPublishFailed, sweepInterrupted } from './publishes.js'
  ```

  Add a `seedPublish` helper (direct control over every column, including `created_at`, which the DAO never lets a caller backdate) and a describe block:

  ```ts
  function seedPublish(
    db: Database,
    overrides: Partial<{
      jobId: string
      platform: string
      channel: string
      day: string
      slot: string
      status: string
      postId: string | null
      url: string | null
      error: string | null
      errorKind: string | null
      attempt: number
      createdAt: string
      finishedAt: string | null
    }> = {},
  ): number {
    const row = {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-20',
      slot: '10:00',
      status: 'claimed',
      postId: null,
      url: null,
      error: null,
      errorKind: null,
      attempt: 1,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      ...overrides,
    }
    const res = db
      .prepare(
        'INSERT INTO publishes (job_id, platform, channel, day, slot, status, post_id, url, error, error_kind, attempt, created_at, finished_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.jobId,
        row.platform,
        row.channel,
        row.day,
        row.slot,
        row.status,
        row.postId,
        row.url,
        row.error,
        row.errorKind,
        row.attempt,
        row.createdAt,
        row.finishedAt,
      )
    return Number(res.lastInsertRowid)
  }

  describe('sweepInterrupted', () => {
    it('flips only claimed rows older than the cutoff, and is idempotent on rerun', () => {
      const db = openDb(':memory:')
      seedJob(db, 'job-old')
      seedJob(db, 'job-fresh')
      const now = new Date('2026-07-20T12:00:00.000Z')
      const oldId = seedPublish(db, {
        jobId: 'job-old',
        status: 'claimed',
        createdAt: '2026-07-20T11:00:00.000Z',
      })
      const freshId = seedPublish(db, {
        jobId: 'job-fresh',
        slot: '14:00',
        status: 'claimed',
        createdAt: '2026-07-20T11:55:00.000Z',
      })

      expect(sweepInterrupted(db, 30 * 60_000, now)).toBe(1)
      const rows = db.prepare('SELECT id, status FROM publishes ORDER BY id').all() as {
        id: number
        status: string
      }[]
      expect(rows).toEqual([
        { id: oldId, status: 'interrupted' },
        { id: freshId, status: 'claimed' },
      ])

      expect(sweepInterrupted(db, 30 * 60_000, now)).toBe(0)
      db.close()
    })
  })
  ```

- [ ] **Step 12: Run, observe the failure**

  ```bash
  npx vitest run src/publish/publishes.test.ts
  ```

  Expected failure: `TypeError: sweepInterrupted is not a function`.

- [ ] **Step 13: Implement sweepInterrupted**

  Append to `src/publish/publishes.ts`:

  ```ts
  // Repair sweep for a tick that died mid-upload (design spec decision 12):
  // claimed rows older than the TTL are stale — flip to 'interrupted' so
  // they never look like an active claim to a later tick. Guarded by
  // status, so a rerun against the same cutoff finds nothing left to flip.
  export function sweepInterrupted(db: Database, olderThanMs: number, now: Date): number {
    const cutoff = new Date(now.getTime() - olderThanMs).toISOString()
    const info = db
      .prepare(
        "UPDATE publishes SET status = 'interrupted' WHERE status = 'claimed' AND created_at <= ?",
      )
      .run(cutoff)
    return info.changes
  }
  ```

- [ ] **Step 14: Run to green**

  ```bash
  npx vitest run src/publish/publishes.test.ts
  ```

  Expected: `5 passed`.

- [ ] **Step 15: Commit sweepInterrupted**

  ```bash
  git add src/publish/publishes.ts src/publish/publishes.test.ts
  git commit -m "feat: add sweepInterrupted repair sweep for stale claims" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 16: Write the failing consumedSlots / uploadsUsedToday tests**

  Extend the import line in `src/publish/publishes.test.ts`:

  ```ts
  import {
    claimPublish,
    consumedSlots,
    markPublishDone,
    markPublishFailed,
    sweepInterrupted,
    uploadsUsedToday,
  } from './publishes.js'
  ```

  Add two describe blocks:

  ```ts
  describe('consumedSlots', () => {
    it('returns slot strings with any-status row for the given (channel, platform, day)', () => {
      const db = openDb(':memory:')
      seedJob(db, 'job-1')
      seedJob(db, 'job-2')
      seedJob(db, 'job-3')
      seedPublish(db, { jobId: 'job-1', slot: '10:00', status: 'done' })
      seedPublish(db, { jobId: 'job-2', slot: '14:00', status: 'failed', errorKind: 'transient' })
      seedPublish(db, { jobId: 'job-3', slot: '19:00', channel: 'chan-b' })
      seedPublish(db, { jobId: 'job-3', slot: '08:00', day: '2026-07-19' })

      expect(consumedSlots(db, 'chan-a', 'youtube', '2026-07-20')).toEqual(
        new Set(['10:00', '14:00']),
      )
      expect(consumedSlots(db, 'chan-a', 'youtube', '2026-07-21')).toEqual(new Set())
      db.close()
    })
  })

  describe('uploadsUsedToday', () => {
    it('counts claimed/done/interrupted and non-auth failed rows, including NULL error_kind, excluding auth failures', () => {
      const db = openDb(':memory:')
      for (const id of ['job-1', 'job-2', 'job-3', 'job-4', 'job-5', 'job-6']) seedJob(db, id)
      seedPublish(db, { jobId: 'job-1', slot: '08:00', status: 'claimed' })
      seedPublish(db, { jobId: 'job-2', slot: '09:00', status: 'done' })
      seedPublish(db, { jobId: 'job-3', slot: '10:00', status: 'interrupted' })
      seedPublish(db, { jobId: 'job-4', slot: '11:00', status: 'failed', errorKind: 'quota' })
      seedPublish(db, { jobId: 'job-5', slot: '12:00', status: 'failed', errorKind: null })
      seedPublish(db, { jobId: 'job-6', slot: '13:00', status: 'failed', errorKind: 'auth' })

      expect(uploadsUsedToday(db, 'youtube', '2026-07-20')).toBe(5)
      expect(uploadsUsedToday(db, 'youtube', '2026-07-21')).toBe(0)
      db.close()
    })
  })
  ```

- [ ] **Step 17: Run, observe the failure**

  ```bash
  npx vitest run src/publish/publishes.test.ts
  ```

  Expected failure: 2 failed — `TypeError: consumedSlots is not a function` and `TypeError: uploadsUsedToday is not a function`.

- [ ] **Step 18: Implement consumedSlots and uploadsUsedToday**

  Append to `src/publish/publishes.ts`:

  ```ts
  // Slot bookkeeping read: every slot string with a row of ANY status for
  // this (channel, platform, day) — an attempt, successful or not, consumes
  // its slot for the rest of the local day (design spec decision 7).
  export function consumedSlots(
    db: Database,
    channel: string,
    platform: Platform,
    day: string,
  ): Set<string> {
    const rows = db
      .prepare('SELECT slot FROM publishes WHERE channel = ? AND platform = ? AND day = ?')
      .all(channel, platform, day) as { slot: string }[]
    return new Set(rows.map((r) => r.slot))
  }

  // Platform quota gate (design spec decision 10, §6 step 4): every row that
  // plausibly reached videos.insert today — claimed/done/interrupted, plus
  // failed rows whose error_kind isn't 'auth' (an auth rejection never
  // reaches the upload call, so it never burns quota; NULL error_kind is a
  // non-auth failure and still counts). `IS NOT` (not `!=`) so a NULL
  // error_kind compares as non-auth instead of making the whole clause
  // unknown.
  export function uploadsUsedToday(db: Database, platform: Platform, day: string): number {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM publishes WHERE platform = ? AND day = ? " +
          "AND (status != 'failed' OR error_kind IS NOT 'auth')",
      )
      .get(platform, day) as { n: number }
    return row.n
  }
  ```

- [ ] **Step 19: Run to green**

  ```bash
  npx vitest run src/publish/publishes.test.ts
  ```

  Expected: `7 passed`.

- [ ] **Step 20: Commit consumedSlots/uploadsUsedToday**

  ```bash
  git add src/publish/publishes.ts src/publish/publishes.test.ts
  git commit -m "feat: add consumedSlots and uploadsUsedToday publish-quota reads" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 21: Write the failing eligibleVideo tests**

  Extend the import line in `src/publish/publishes.test.ts`:

  ```ts
  import {
    claimPublish,
    consumedSlots,
    eligibleVideo,
    markPublishDone,
    markPublishFailed,
    MAX_PUBLISH_ATTEMPTS,
    sweepInterrupted,
    uploadsUsedToday,
  } from './publishes.js'
  ```

  Add a describe block covering the full eligibility matrix:

  ```ts
  describe('eligibleVideo', () => {
    it('only considers ready library rows on the given channel', () => {
      const db = openDb(':memory:')
      seedJob(db, 'job-ready', { topic: 'ready topic' })
      seedJob(db, 'job-review')
      seedJob(db, 'job-published')
      seedJob(db, 'job-blocked')
      seedJob(db, 'job-other-chan', { channel: 'chan-b' })
      seedLibrary(db, 'job-ready', { state: 'ready' })
      seedLibrary(db, 'job-review', { state: 'needs-review' })
      seedLibrary(db, 'job-published', { state: 'published' })
      seedLibrary(db, 'job-blocked', { state: 'blocked' })
      seedLibrary(db, 'job-other-chan', { state: 'ready' })

      expect(eligibleVideo(db, 'chan-a', 'youtube')).toEqual({
        jobId: 'job-ready',
        videoPath: '/tmp/out.mp4',
        metadataJson: '{}',
        topic: 'ready topic',
      })
      expect(eligibleVideo(db, 'chan-c', 'youtube')).toBeNull()
      db.close()
    })

    it('excludes jobs with a done, claimed, or interrupted row for the platform', () => {
      const db = openDb(':memory:')
      seedJob(db, 'job-done')
      seedJob(db, 'job-claimed')
      seedJob(db, 'job-interrupted')
      seedLibrary(db, 'job-done', { state: 'ready' })
      seedLibrary(db, 'job-claimed', { state: 'ready' })
      seedLibrary(db, 'job-interrupted', { state: 'ready' })
      seedPublish(db, { jobId: 'job-done', slot: '08:00', status: 'done' })
      seedPublish(db, { jobId: 'job-claimed', slot: '09:00', status: 'claimed' })
      seedPublish(db, { jobId: 'job-interrupted', slot: '10:00', status: 'interrupted' })

      expect(eligibleVideo(db, 'chan-a', 'youtube')).toBeNull()
      db.close()
    })

    it('excludes a job at MAX_PUBLISH_ATTEMPTS rejected failures but includes one still under the cap', () => {
      const db = openDb(':memory:')
      expect(MAX_PUBLISH_ATTEMPTS).toBe(3)
      seedJob(db, 'job-capped', { topic: 'capped' })
      seedJob(db, 'job-under-cap', { topic: 'under cap' })
      seedLibrary(db, 'job-capped', { state: 'ready' })
      seedLibrary(db, 'job-under-cap', { state: 'ready' })
      seedPublish(db, { jobId: 'job-capped', slot: '08:00', status: 'failed', errorKind: 'rejected' })
      seedPublish(db, { jobId: 'job-capped', slot: '09:00', status: 'failed', errorKind: 'rejected' })
      seedPublish(db, { jobId: 'job-capped', slot: '10:00', status: 'failed', errorKind: 'rejected' })
      seedPublish(db, {
        jobId: 'job-under-cap',
        slot: '08:00',
        status: 'failed',
        errorKind: 'rejected',
      })
      seedPublish(db, {
        jobId: 'job-under-cap',
        slot: '09:00',
        status: 'failed',
        errorKind: 'rejected',
      })

      expect(eligibleVideo(db, 'chan-a', 'youtube')?.jobId).toBe('job-under-cap')
      db.close()
    })

    it('orders by fewest failed rows of any kind, then newest library row, then job id', () => {
      const db = openDb(':memory:')
      seedJob(db, 'job-a')
      seedJob(db, 'job-b')
      seedJob(db, 'job-c')
      seedJob(db, 'job-d')
      // job-a: one non-rejected failure — doesn't count toward the cap, but
      // still outranked by the zero-failure jobs on the primary sort key.
      seedLibrary(db, 'job-a', { state: 'ready', createdAt: '2026-07-19T00:00:00.000Z' })
      seedPublish(db, { jobId: 'job-a', slot: '08:00', status: 'failed', errorKind: 'transient' })
      // job-b, job-c, job-d: zero failures — tie broken by created_at DESC,
      // then job_id ASC.
      seedLibrary(db, 'job-b', { state: 'ready', createdAt: '2026-07-18T00:00:00.000Z' })
      seedLibrary(db, 'job-c', { state: 'ready', createdAt: '2026-07-20T00:00:00.000Z' })
      seedLibrary(db, 'job-d', { state: 'ready', createdAt: '2026-07-20T00:00:00.000Z' })

      expect(eligibleVideo(db, 'chan-a', 'youtube')?.jobId).toBe('job-c')
      db.close()
    })
  })
  ```

- [ ] **Step 22: Run, observe the failure**

  ```bash
  npx vitest run src/publish/publishes.test.ts
  ```

  Expected failure: 4 failed, each `TypeError: eligibleVideo is not a function`.

- [ ] **Step 23: Implement eligibleVideo**

  Append to `src/publish/publishes.ts`:

  ```ts
  // Eligibility per design spec §6 step 6: 'ready' library rows for jobs on
  // this channel, excluding any job that already has a done/claimed/
  // interrupted row for this platform (it's either published or in
  // flight), and excluding any job at or past MAX_PUBLISH_ATTEMPTS
  // 'rejected' failures (poison-video guard — decision 8; only 'rejected'
  // counts, since auth/quota/transient failures are channel- or
  // platform-wide, not the video's fault). The LEFT JOIN is against a
  // per-job aggregate (grouped by job_id, filtered to this platform) rather
  // than a raw join against `publishes`, so a job with several rows
  // contributes exactly one joined row — no fan-out to dedupe. Order:
  // fewest failed rows of any kind first (spreads attempts during a
  // channel-wide outage), then newest library row first (fresh trend
  // content over stale), then job id for determinism.
  export function eligibleVideo(
    db: Database,
    channel: string,
    platform: Platform,
  ): { jobId: string; videoPath: string; metadataJson: string; topic: string } | null {
    const row = db
      .prepare(
        `SELECT l.job_id AS jobId, l.video_path AS videoPath, l.metadata_json AS metadataJson, j.topic AS topic
         FROM library l
         JOIN jobs j ON j.id = l.job_id
         LEFT JOIN (
           SELECT job_id,
                  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
                  SUM(CASE WHEN status = 'failed' AND error_kind = 'rejected' THEN 1 ELSE 0 END) AS rejectedCount,
                  SUM(CASE WHEN status IN ('done','claimed','interrupted') THEN 1 ELSE 0 END) AS blockingCount
           FROM publishes
           WHERE platform = ?
           GROUP BY job_id
         ) p ON p.job_id = l.job_id
         WHERE l.state = 'ready'
           AND j.channel = ?
           AND COALESCE(p.blockingCount, 0) = 0
           AND COALESCE(p.rejectedCount, 0) < ?
         ORDER BY COALESCE(p.failedCount, 0) ASC, l.created_at DESC, l.job_id ASC
         LIMIT 1`,
      )
      .get(platform, channel, MAX_PUBLISH_ATTEMPTS) as
      | { jobId: string; videoPath: string; metadataJson: string; topic: string }
      | undefined
    return row === undefined ? null : row
  }
  ```

- [ ] **Step 24: Run to green**

  ```bash
  npx vitest run src/publish/publishes.test.ts
  ```

  Expected: `11 passed`.

- [ ] **Step 25: Commit eligibleVideo**

  ```bash
  git add src/publish/publishes.ts src/publish/publishes.test.ts
  git commit -m "feat: add eligibleVideo poison-guarded publish candidate pick" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 26: Write the failing retryInterrupted / markInterruptedDone tests**

  Extend the import line in `src/publish/publishes.test.ts`:

  ```ts
  import {
    claimPublish,
    consumedSlots,
    eligibleVideo,
    markInterruptedDone,
    markPublishDone,
    markPublishFailed,
    MAX_PUBLISH_ATTEMPTS,
    retryInterrupted,
    sweepInterrupted,
    uploadsUsedToday,
  } from './publishes.js'
  ```

  Add two describe blocks:

  ```ts
  describe('retryInterrupted', () => {
    it('flips an interrupted row to failed, kind transient, with an appended clearance note', () => {
      const db = openDb(':memory:')
      seedJob(db, 'job-1')
      const id = seedPublish(db, { jobId: 'job-1', status: 'interrupted' })

      expect(retryInterrupted(db, 'job-1')).toBe(true)
      expect(
        db.prepare('SELECT status, error, error_kind FROM publishes WHERE id = ?').get(id),
      ).toEqual({
        status: 'failed',
        error: '; manually cleared',
        error_kind: 'transient',
      })
      db.close()
    })

    it('returns false and touches nothing when the job has no interrupted row', () => {
      const db = openDb(':memory:')
      seedJob(db, 'job-1')
      seedPublish(db, { jobId: 'job-1', status: 'done' })

      expect(retryInterrupted(db, 'job-1')).toBe(false)
      expect(retryInterrupted(db, 'job-unknown')).toBe(false)
      expect(
        (db.prepare('SELECT status FROM publishes WHERE job_id = ?').get('job-1') as {
          status: string
        }).status,
      ).toBe('done')
      db.close()
    })
  })

  describe('markInterruptedDone', () => {
    it('flips the interrupted publish row to done and the library row to published together', () => {
      const db = openDb(':memory:')
      seedJob(db, 'job-1')
      seedLibrary(db, 'job-1', { state: 'ready' })
      const id = seedPublish(db, { jobId: 'job-1', status: 'interrupted' })

      const ok = markInterruptedDone(
        db,
        'job-1',
        'yt-xyz789',
        'https://youtube.com/shorts/yt-xyz789',
        new Date('2026-07-20T10:10:00.000Z'),
      )

      expect(ok).toBe(true)
      expect(
        db.prepare('SELECT status, post_id, url, finished_at FROM publishes WHERE id = ?').get(id),
      ).toEqual({
        status: 'done',
        post_id: 'yt-xyz789',
        url: 'https://youtube.com/shorts/yt-xyz789',
        finished_at: '2026-07-20T10:10:00.000Z',
      })
      expect(
        (db.prepare('SELECT state FROM library WHERE job_id = ?').get('job-1') as {
          state: string
        }).state,
      ).toBe('published')
      db.close()
    })

    it('returns false and touches neither table when the job has no interrupted row', () => {
      const db = openDb(':memory:')
      seedJob(db, 'job-1')
      seedLibrary(db, 'job-1', { state: 'ready' })

      const ok = markInterruptedDone(
        db,
        'job-1',
        'yt-xyz789',
        'https://youtube.com/shorts/yt-xyz789',
        new Date('2026-07-20T10:10:00.000Z'),
      )

      expect(ok).toBe(false)
      expect(
        (db.prepare('SELECT state FROM library WHERE job_id = ?').get('job-1') as {
          state: string
        }).state,
      ).toBe('ready')
      db.close()
    })
  })
  ```

- [ ] **Step 27: Run, observe the failure**

  ```bash
  npx vitest run src/publish/publishes.test.ts
  ```

  Expected failure: 4 failed — the two `retryInterrupted` tests with `TypeError: retryInterrupted is not a function`; the two `markInterruptedDone` tests with `TypeError: markInterruptedDone is not a function`.

- [ ] **Step 28: Implement retryInterrupted and markInterruptedDone**

  Append to `src/publish/publishes.ts`:

  ```ts
  // Manual resolution path (design spec §7 `publish retry`): interrupted →
  // failed with kind 'transient' so the video re-enters the eligibility
  // pool at the next slot. The suffix appends to whatever error text is
  // already on the row (interrupted rows leave it NULL, so COALESCE keeps
  // the append from producing a literal "null" prefix). Guarded by status,
  // so a job with no interrupted row is a no-op and reports false.
  export function retryInterrupted(db: Database, jobId: string): boolean {
    const info = db
      .prepare(
        "UPDATE publishes SET status = 'failed', error_kind = 'transient', " +
          "error = COALESCE(error, '') || '; manually cleared' " +
          "WHERE job_id = ? AND status = 'interrupted'",
      )
      .run(jobId)
    return info.changes === 1
  }

  // Manual resolution path (design spec §7 `publish mark-done`): for when
  // Studio confirms the upload actually landed. Same one-transaction shape
  // as markPublishDone, guarded on the interrupted row existing — the
  // library flip only runs when the publishes update actually matched a
  // row, so a job with no interrupted row leaves both tables untouched and
  // reports false.
  export function markInterruptedDone(
    db: Database,
    jobId: string,
    postId: string,
    url: string,
    now: Date,
  ): boolean {
    const updatePublish = db.prepare(
      "UPDATE publishes SET status = 'done', post_id = ?, url = ?, finished_at = ? " +
        "WHERE job_id = ? AND status = 'interrupted'",
    )
    const updateLibrary = db.prepare("UPDATE library SET state = 'published' WHERE job_id = ?")
    const flip = db.transaction((): boolean => {
      const info = updatePublish.run(postId, url, now.toISOString(), jobId)
      if (info.changes !== 1) return false
      updateLibrary.run(jobId)
      return true
    })
    return flip()
  }
  ```

- [ ] **Step 29: Run to green**

  ```bash
  npx vitest run src/publish/publishes.test.ts
  ```

  Expected: `15 passed`.

- [ ] **Step 30: Commit retryInterrupted/markInterruptedDone**

  ```bash
  git add src/publish/publishes.ts src/publish/publishes.test.ts
  git commit -m "feat: add retryInterrupted/markInterruptedDone manual resolution paths" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 31: Write the failing listPublishes tests**

  Extend the import line in `src/publish/publishes.test.ts`:

  ```ts
  import {
    claimPublish,
    consumedSlots,
    eligibleVideo,
    listPublishes,
    markInterruptedDone,
    markPublishDone,
    markPublishFailed,
    MAX_PUBLISH_ATTEMPTS,
    retryInterrupted,
    sweepInterrupted,
    uploadsUsedToday,
  } from './publishes.js'
  ```

  Add a `DAY_MS` constant, an `isoAgo` helper (same idiom as `src/loop/digest.test.ts`), and a describe block:

  ```ts
  const DAY_MS = 24 * 60 * 60 * 1000

  // Explicit timestamps offset from the real clock keep the
  // datetime('now', ...) window comparison inside listPublishes meaningful.
  function isoAgo(ms: number): string {
    return new Date(Date.now() - ms).toISOString()
  }

  describe('listPublishes', () => {
    it('defaults to a 7-day window, newest first, mapped to camelCase', () => {
      const db = openDb(':memory:')
      seedJob(db, 'job-newer')
      seedJob(db, 'job-older')
      seedJob(db, 'job-out')
      const newerAt = isoAgo(1 * DAY_MS)
      const olderAt = isoAgo(2 * DAY_MS)
      const newerId = seedPublish(db, {
        jobId: 'job-newer',
        status: 'done',
        postId: 'yt-1',
        url: 'https://youtube.com/shorts/yt-1',
        createdAt: newerAt,
      })
      const olderId = seedPublish(db, {
        jobId: 'job-older',
        slot: '11:00',
        status: 'failed',
        errorKind: 'rejected',
        createdAt: olderAt,
      })
      seedPublish(db, {
        jobId: 'job-out',
        slot: '12:00',
        status: 'failed',
        errorKind: 'transient',
        createdAt: isoAgo(8 * DAY_MS),
      })

      const rows = listPublishes(db)
      expect(rows.map((r) => r.id)).toEqual([newerId, olderId])
      expect(rows[0]).toEqual({
        id: newerId,
        jobId: 'job-newer',
        platform: 'youtube',
        channel: 'chan-a',
        day: '2026-07-20',
        slot: '10:00',
        status: 'done',
        postId: 'yt-1',
        url: 'https://youtube.com/shorts/yt-1',
        error: null,
        errorKind: null,
        attempt: 1,
        createdAt: newerAt,
        finishedAt: null,
      })
      db.close()
    })

    it('sinceDays widens or narrows the window', () => {
      const db = openDb(':memory:')
      seedJob(db, 'job-1')
      seedPublish(db, { jobId: 'job-1', createdAt: isoAgo(8 * DAY_MS) })

      expect(listPublishes(db)).toHaveLength(0)
      expect(listPublishes(db, { sinceDays: 10 })).toHaveLength(1)
      db.close()
    })
  })
  ```

- [ ] **Step 32: Run, observe the failure**

  ```bash
  npx vitest run src/publish/publishes.test.ts
  ```

  Expected failure: 2 failed, each `TypeError: listPublishes is not a function`.

- [ ] **Step 33: Implement listPublishes**

  Append to `src/publish/publishes.ts`:

  ```ts
  const PUBLISH_COLUMNS =
    'id, job_id, platform, channel, day, slot, status, post_id, url, error, error_kind, attempt, created_at, finished_at'

  interface DbPublishRow {
    id: number
    job_id: string
    platform: Platform
    channel: string
    day: string
    slot: string
    status: PublishStatus
    post_id: string | null
    url: string | null
    error: string | null
    error_kind: PublishErrorKind | null
    attempt: number
    created_at: string
    finished_at: string | null
  }

  function toPublishRow(row: DbPublishRow): PublishRow {
    return {
      id: row.id,
      jobId: row.job_id,
      platform: row.platform,
      channel: row.channel,
      day: row.day,
      slot: row.slot,
      status: row.status,
      postId: row.post_id,
      url: row.url,
      error: row.error,
      errorKind: row.error_kind,
      attempt: row.attempt,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    }
  }

  // Attempt history for `brainrot publishes list` (design spec §7). No
  // `now` parameter — this is a display query, not scheduling logic, so it
  // reads SQLite's own wall clock exactly like the digest's '-1 day' window
  // does.
  export function listPublishes(db: Database, opts?: { sinceDays?: number }): PublishRow[] {
    const sinceDays = opts?.sinceDays ?? 7
    const rows = db
      .prepare(
        `SELECT ${PUBLISH_COLUMNS} FROM publishes WHERE datetime(created_at) >= datetime('now', ?) ` +
          'ORDER BY created_at DESC, id DESC',
      )
      .all(`-${sinceDays} days`) as DbPublishRow[]
    return rows.map(toPublishRow)
  }
  ```

- [ ] **Step 34: Run the task file to green**

  ```bash
  npx vitest run src/publish/publishes.test.ts
  ```

  Expected: `17 passed`.

- [ ] **Step 35: Run the whole suite**

  ```bash
  npx vitest run
  ```

  Expected: 0 failures across the whole suite, including the 17 passing tests in `src/publish/publishes.test.ts`.

- [ ] **Step 36: Typecheck**

  ```bash
  npx tsc --noEmit
  ```

  Expected: no output, exit 0.

- [ ] **Step 37: Final commit**

  ```bash
  git add src/publish/publishes.ts src/publish/publishes.test.ts
  git commit -m "feat: add listPublishes attempt-history query" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 8: YouTube adapter

**Files:**
- Create: `src/publish/youtube.ts`, `src/publish/youtube.test.ts`
- Modify: none
- Test: `src/publish/youtube.test.ts`

**Interfaces:**

- Consumes — `src/publish/types.ts` (Task 3), verbatim, plus Node/runtime globals (`node:fs`'s `readFileSync`, and `fetch`/`Response`/`Headers`/`AbortSignal`/`URLSearchParams`, native in Node ≥22 and typed via the `DOM` lib already in `tsconfig.json`):
  ```ts
  // src/publish/types.ts
  export type PublishErrorKind = 'auth' | 'quota' | 'rejected' | 'transient'
  export class PublishError extends Error {
    constructor(message: string, public kind: PublishErrorKind)
  }
  export interface PlatformMeta { title: string; description: string; hashtags: string[] }
  export interface PublishChannelConfig {
    slots: string[]
    platforms: Platform[]
    privacy: 'public' | 'unlisted' | 'private'
    categoryId: number
    madeForKids: boolean
  }
  export interface PublishTarget {
    readonly platformId: Platform
    upload(
      req: { videoPath: string; meta: PlatformMeta; publish: PublishChannelConfig },
      accessToken: string
    ): Promise<{ postId: string; url: string }>
  }
  ```

- Produces (binding — Task 9's `oauth-flow.ts` imports `YT_UPLOAD_SCOPE` for the consent-URL `scope` param; Task 10's `publish-next.ts` imports `youtubeTarget` as the default `PublishTarget`, threads `fetchImpl` to `mintAccessToken`, and calls `ytUploadsPerDayCap()` for the quota gate; Task 14's contract test exercises the real `youtubeTarget().upload`):
  ```ts
  // src/publish/youtube.ts
  export const YT_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload'
  export const UPLOAD_TIMEOUT_MS = 300_000              // 5 min per HTTP call in the upload
  export const DEFAULT_YT_UPLOADS_PER_DAY = 6
  export function ytUploadsPerDayCap(): number
  export async function mintAccessToken(opts: {
    refreshToken: string; clientId: string; clientSecret: string; fetchImpl?: typeof fetch
  }): Promise<string>
  export function youtubeTarget(fetchImpl?: typeof fetch): PublishTarget
  ```

---

- [ ] **Step 1: Write the failing constants + `ytUploadsPerDayCap` tests**

  Create `src/publish/youtube.test.ts` (new directory `src/publish/`):

  ```ts
  import { afterEach, describe, expect, it, vi } from 'vitest'
  import { DEFAULT_YT_UPLOADS_PER_DAY, UPLOAD_TIMEOUT_MS, YT_UPLOAD_SCOPE, ytUploadsPerDayCap } from './youtube.js'

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('constants', () => {
    it('pins the upload scope, per-call timeout, and default daily cap', () => {
      expect(YT_UPLOAD_SCOPE).toBe('https://www.googleapis.com/auth/youtube.upload')
      expect(UPLOAD_TIMEOUT_MS).toBe(300_000)
      expect(DEFAULT_YT_UPLOADS_PER_DAY).toBe(6)
    })
  })

  describe('ytUploadsPerDayCap', () => {
    it('defaults to 6 when BRAINROT_YT_UPLOADS_PER_DAY is unset', () => {
      vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', undefined) // deterministic even if the shell exports it
      expect(ytUploadsPerDayCap()).toBe(6)
    })

    it('reads the env override at call time, not at import time', () => {
      vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '10')
      expect(ytUploadsPerDayCap()).toBe(10)
      vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '2')
      expect(ytUploadsPerDayCap()).toBe(2)
    })

    it('throws on a non-positive or non-numeric value', () => {
      vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '0')
      expect(() => ytUploadsPerDayCap()).toThrow(/invalid BRAINROT_YT_UPLOADS_PER_DAY/)
      vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', 'abc')
      expect(() => ytUploadsPerDayCap()).toThrow(/invalid BRAINROT_YT_UPLOADS_PER_DAY/)
    })
  })
  ```

  Run: `npx vitest run src/publish/youtube.test.ts`

  Expected failure: the whole file errors at import time — `Error: Failed to resolve import "./youtube.js" from "src/publish/youtube.test.ts". Does the file exist?` (the module does not exist yet, so this is a resolution error, not the missing-named-export TypeError).

- [ ] **Step 2: Implement the constants and `ytUploadsPerDayCap`, run green**

  Create `src/publish/youtube.ts`:

  ```ts
  // Least-privilege scope: upload-only, no read/manage access to the channel
  // (design spec §4.2).
  export const YT_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload'

  // Applies per HTTP call in the resumable upload (initiate, then the PUT of
  // the file bytes) — not to the upload as a whole.
  export const UPLOAD_TIMEOUT_MS = 300_000 // 5 min

  // YouTube quota is per Google Cloud project (~10k units/day, 1600/upload),
  // not per channel — this is the hard pre-upload gate counted across every
  // channel (design spec decision 10).
  export const DEFAULT_YT_UPLOADS_PER_DAY = 6

  // Parsed at call time (not module load) so tests and long-lived processes see
  // env changes without a re-import — same convention as costs.ts's
  // globalDailyCapMicros.
  export function ytUploadsPerDayCap(): number {
    const raw = process.env.BRAINROT_YT_UPLOADS_PER_DAY
    if (raw === undefined || raw.trim() === '') {
      return DEFAULT_YT_UPLOADS_PER_DAY
    }
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(
        `invalid BRAINROT_YT_UPLOADS_PER_DAY: ${JSON.stringify(raw)} (expected a positive number of uploads)`,
      )
    }
    return n
  }
  ```

  Run: `npx vitest run src/publish/youtube.test.ts`

  Expected: `Test Files  1 passed (1)`, `Tests  4 passed (4)`.

- [ ] **Step 3: Write the failing `mintAccessToken` tests**

  In `src/publish/youtube.test.ts`, replace the import block with:

  ```ts
  import { afterEach, describe, expect, it, vi } from 'vitest'
  import { PublishError } from './types.js'
  import {
    DEFAULT_YT_UPLOADS_PER_DAY,
    UPLOAD_TIMEOUT_MS,
    YT_UPLOAD_SCOPE,
    mintAccessToken,
    ytUploadsPerDayCap,
  } from './youtube.js'
  ```

  Then append at the end of the file:

  ```ts
  // Injectable fetch: captures every call, answers with one canned response per
  // call in sequence (used later for the resumable upload's two HTTP calls).
  function fakeFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    let i = 0
    const impl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init })
      const step = responses[i]
      i++
      return new Response(step.body === undefined ? '' : JSON.stringify(step.body), {
        status: step.status,
        headers: { 'content-type': 'application/json', ...step.headers },
      })
    }
    return { impl, calls }
  }

  describe('mintAccessToken', () => {
    it('POSTs a refresh_token grant and returns the access token', async () => {
      const { impl, calls } = fakeFetch([{ status: 200, body: { access_token: 'ya29.at-test', expires_in: 3600 } }])
      const token = await mintAccessToken({
        refreshToken: 'rt-test-token',
        clientId: 'client-id-x',
        clientSecret: 'client-secret-x',
        fetchImpl: impl,
      })
      expect(token).toBe('ya29.at-test')
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe('https://oauth2.googleapis.com/token')
      const init = calls[0].init!
      expect(init.method).toBe('POST')
      const params = new URLSearchParams(init.body as string)
      expect(params.get('grant_type')).toBe('refresh_token')
      expect(params.get('refresh_token')).toBe('rt-test-token')
      expect(params.get('client_id')).toBe('client-id-x')
      expect(params.get('client_secret')).toBe('client-secret-x')
    })

    it('maps an invalid_grant rejection to kind "auth"', async () => {
      const { impl } = fakeFetch([
        { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } },
      ])
      const err = await mintAccessToken({
        refreshToken: 'rt-test-token',
        clientId: 'client-id-x',
        clientSecret: 'client-secret-x',
        fetchImpl: impl,
      }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PublishError)
      expect((err as PublishError).kind).toBe('auth')
    })

    it('maps a 500 to kind "transient"', async () => {
      const { impl } = fakeFetch([{ status: 500, body: { error: 'server_error' } }])
      const err = await mintAccessToken({
        refreshToken: 'rt-test-token',
        clientId: 'client-id-x',
        clientSecret: 'client-secret-x',
        fetchImpl: impl,
      }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PublishError)
      expect((err as PublishError).kind).toBe('transient')
    })
  })
  ```

  Run: `npx vitest run src/publish/youtube.test.ts`

  Expected failure: 3 new tests fail with `TypeError: mintAccessToken is not a function` (missing named export → `undefined` at runtime — esbuild resolves it, does not error at import time, because the module file itself already exists from Step 2). The 4 existing tests still pass. `Tests  3 failed | 4 passed (7)`.

- [ ] **Step 4: Implement `mintAccessToken`, run green**

  At the top of `src/publish/youtube.ts`, add:

  ```ts
  import { PublishError } from './types.js'
  ```

  Then append to the end of the file:

  ```ts
  const TOKEN_URL = 'https://oauth2.googleapis.com/token'

  // A thrown fetch (network failure, or an aborted/timed-out request) always
  // maps to 'transient' — the tick's next slot is the retry (design spec
  // decision 7). Shared by mintAccessToken and youtubeTarget.upload below.
  function networkError(op: string, err: unknown): PublishError {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return new PublishError(`${op}: request timed out after ${UPLOAD_TIMEOUT_MS}ms`, 'transient')
    }
    return new PublishError(
      `${op}: request failed: ${err instanceof Error ? err.message : String(err)}`,
      'transient',
    )
  }

  export async function mintAccessToken(opts: {
    refreshToken: string
    clientId: string
    clientSecret: string
    fetchImpl?: typeof fetch
  }): Promise<string> {
    const fetchImpl = opts.fetchImpl ?? fetch
    let res: Response
    try {
      res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: opts.refreshToken,
          client_id: opts.clientId,
          client_secret: opts.clientSecret,
        }).toString(),
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      })
    } catch (err) {
      throw networkError('mintAccessToken', err)
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      // invalid_grant and every other 4xx are the caller's problem (revoked or
      // expired grant, bad client secret) — re-auth is the fix, not a retry.
      if (res.status >= 500) {
        throw new PublishError(`mintAccessToken: token endpoint responded ${res.status}: ${raw}`, 'transient')
      }
      throw new PublishError(`mintAccessToken: token endpoint responded ${res.status}: ${raw}`, 'auth')
    }
    const body = (await res.json()) as { access_token?: string }
    if (!body.access_token) {
      throw new PublishError('mintAccessToken: token response carried no access_token', 'auth')
    }
    return body.access_token
  }
  ```

  Run: `npx vitest run src/publish/youtube.test.ts`

  Expected: `Test Files  1 passed (1)`, `Tests  7 passed (7)`.

- [ ] **Step 5: Write the failing `youtubeTarget` happy-path tests**

  In `src/publish/youtube.test.ts`, replace the import block with:

  ```ts
  import { afterEach, describe, expect, it, vi } from 'vitest'
  import { mkdtempSync, writeFileSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import type { PlatformMeta, PublishChannelConfig } from './types.js'
  import { PublishError } from './types.js'
  import {
    DEFAULT_YT_UPLOADS_PER_DAY,
    UPLOAD_TIMEOUT_MS,
    YT_UPLOAD_SCOPE,
    mintAccessToken,
    youtubeTarget,
    ytUploadsPerDayCap,
  } from './youtube.js'
  ```

  Then append at the end of the file:

  ```ts
  function tempVideoFile(bytes = 'fake video bytes'): string {
    const dir = mkdtempSync(join(tmpdir(), 'brainrot-yt-'))
    const path = join(dir, 'video.mp4')
    writeFileSync(path, bytes)
    return path
  }

  const META: PlatformMeta = { title: 'A great short', description: 'Watch this.', hashtags: ['#funny', '#shorts'] }
  const META_NO_HASHTAGS: PlatformMeta = { title: 'A great short', description: 'Watch this.', hashtags: [] }
  const PUBLISH_CFG: PublishChannelConfig = {
    slots: ['10:00'],
    platforms: ['youtube'],
    privacy: 'public',
    categoryId: 24,
    madeForKids: false,
  }

  describe('youtubeTarget upload — resumable two-phase happy path', () => {
    it('POSTs the resumable-initiate metadata, then PUTs the file bytes to the Location URL', async () => {
      const videoPath = tempVideoFile('fake video bytes')
      const { impl, calls } = fakeFetch([
        { status: 200, headers: { location: 'https://upload.example.com/session/abc123' } },
        { status: 200, body: { id: 'yt-video-1' } },
      ])
      const target = youtubeTarget(impl)
      const res = await target.upload({ videoPath, meta: META, publish: PUBLISH_CFG }, 'access-token-x')

      expect(calls).toHaveLength(2)
      // Phase 1: resumable initiate — exact metadata body per the interface contract.
      expect(calls[0].url).toBe(
        'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      )
      const initInit = calls[0].init!
      expect(initInit.method).toBe('POST')
      expect((initInit.headers as Record<string, string>).Authorization).toBe('Bearer access-token-x')
      expect(JSON.parse(initInit.body as string)).toEqual({
        snippet: {
          title: 'A great short',
          description: 'Watch this.\n\n#funny #shorts',
          tags: ['funny', 'shorts'],
          categoryId: '24',
        },
        status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
      })

      // Phase 2: PUT the raw bytes to the Location URL returned by phase 1.
      expect(calls[1].url).toBe('https://upload.example.com/session/abc123')
      const putInit = calls[1].init!
      expect(putInit.method).toBe('PUT')
      expect((putInit.body as Buffer).toString()).toBe('fake video bytes')

      expect(res).toEqual({ postId: 'yt-video-1', url: 'https://youtube.com/shorts/yt-video-1' })
    })

    it('omits the separator and ships an empty tags array when hashtags is empty', async () => {
      const videoPath = tempVideoFile('x')
      const { impl, calls } = fakeFetch([
        { status: 200, headers: { location: 'https://upload.example.com/session/def456' } },
        { status: 200, body: { id: 'yt-video-2' } },
      ])
      const target = youtubeTarget(impl)
      await target.upload({ videoPath, meta: META_NO_HASHTAGS, publish: PUBLISH_CFG }, 'access-token-x')
      const body = JSON.parse(calls[0].init!.body as string)
      expect(body.snippet.description).toBe('Watch this.')
      expect(body.snippet.tags).toEqual([])
    })
  })
  ```

  Run: `npx vitest run src/publish/youtube.test.ts`

  Expected failure: 2 new tests fail with `TypeError: youtubeTarget is not a function` (missing named export → `undefined` at runtime). The 7 existing tests still pass. `Tests  2 failed | 7 passed (9)`.

- [ ] **Step 6: Implement `youtubeTarget` minimally (happy path only), run green**

  At the top of `src/publish/youtube.ts`, add `readFileSync` to the imports and add the `PublishTarget` type import:

  ```ts
  import { readFileSync } from 'node:fs'
  import { PublishError } from './types.js'
  import type { PublishTarget } from './types.js'
  ```

  Then append to the end of the file. This is the resumable protocol's happy-path shape only — the non-2xx guard, missing-Location guard, and ENOENT hardening arrive in the next cycle:

  ```ts
  const INITIATE_URL =
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status'

  export function youtubeTarget(fetchImpl: typeof fetch = fetch): PublishTarget {
    return {
      platformId: 'youtube',
      async upload(req, accessToken) {
        const { videoPath, meta, publish } = req
        const description =
          meta.hashtags.length > 0 ? `${meta.description}\n\n${meta.hashtags.join(' ')}` : meta.description
        const metadataBody = {
          snippet: {
            title: meta.title,
            description,
            tags: meta.hashtags.map((h) => h.replace(/^#/, '')),
            categoryId: String(publish.categoryId),
          },
          status: {
            privacyStatus: publish.privacy,
            selfDeclaredMadeForKids: publish.madeForKids,
            containsSyntheticMedia: true,
          },
        }

        const initiateRes = await fetchImpl(INITIATE_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(metadataBody),
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        })
        const location = initiateRes.headers.get('location')!
        const bytes = readFileSync(videoPath)
        const uploadRes = await fetchImpl(location, {
          method: 'PUT',
          body: bytes,
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        })
        const body = (await uploadRes.json()) as { id: string }
        return { postId: body.id, url: `https://youtube.com/shorts/${body.id}` }
      },
    }
  }
  ```

  Run: `npx vitest run src/publish/youtube.test.ts`

  Expected: `Test Files  1 passed (1)`, `Tests  9 passed (9)`.

- [ ] **Step 7: Write the failing error-mapping tests**

  Append to the end of `src/publish/youtube.test.ts` (no import changes needed):

  ```ts
  describe('youtubeTarget upload — error mapping', () => {
    it.each(['quotaExceeded', 'uploadLimitExceeded', 'dailyLimitExceeded'])(
      'maps a body reason of "%s" to kind "quota"',
      async (reason) => {
        const { impl } = fakeFetch([{ status: 403, body: { error: { errors: [{ reason }] } } }])
        const target = youtubeTarget(impl)
        const err = await target
          .upload({ videoPath: tempVideoFile(), meta: META, publish: PUBLISH_CFG }, 'tok')
          .catch((e: unknown) => e)
        expect(err).toBeInstanceOf(PublishError)
        expect((err as PublishError).kind).toBe('quota')
      },
    )

    it('maps HTTP 401 to kind "auth"', async () => {
      const { impl } = fakeFetch([{ status: 401, body: { error: { errors: [{ reason: 'authError' }] } } }])
      const target = youtubeTarget(impl)
      const err = await target
        .upload({ videoPath: tempVideoFile(), meta: META, publish: PUBLISH_CFG }, 'tok')
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PublishError)
      expect((err as PublishError).kind).toBe('auth')
    })

    it('maps another 4xx to kind "rejected"', async () => {
      const { impl } = fakeFetch([{ status: 400, body: { error: { errors: [{ reason: 'invalidMetadata' }] } } }])
      const target = youtubeTarget(impl)
      const err = await target
        .upload({ videoPath: tempVideoFile(), meta: META, publish: PUBLISH_CFG }, 'tok')
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PublishError)
      expect((err as PublishError).kind).toBe('rejected')
    })

    it('maps a 5xx to kind "transient"', async () => {
      const { impl } = fakeFetch([{ status: 503, body: { error: { errors: [{ reason: 'backendError' }] } } }])
      const target = youtubeTarget(impl)
      const err = await target
        .upload({ videoPath: tempVideoFile(), meta: META, publish: PUBLISH_CFG }, 'tok')
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PublishError)
      expect((err as PublishError).kind).toBe('transient')
    })

    it('maps a network failure (including an aborted/timed-out request) to kind "transient"', async () => {
      const impl: typeof fetch = async () => {
        const abortErr = new Error('fetch failed')
        abortErr.name = 'AbortError'
        throw abortErr
      }
      const target = youtubeTarget(impl)
      const err = await target
        .upload({ videoPath: tempVideoFile(), meta: META, publish: PUBLISH_CFG }, 'tok')
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PublishError)
      expect((err as PublishError).kind).toBe('transient')
    })

    it('maps a missing local video file (ENOENT) to kind "rejected"', async () => {
      const { impl } = fakeFetch([{ status: 200, headers: { location: 'https://upload.example.com/session/ghost' } }])
      const target = youtubeTarget(impl)
      const err = await target
        .upload(
          { videoPath: '/nonexistent/brainrot-yt-missing/video.mp4', meta: META, publish: PUBLISH_CFG },
          'tok',
        )
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PublishError)
      expect((err as PublishError).kind).toBe('rejected')
    })
  })
  ```

  Run: `npx vitest run src/publish/youtube.test.ts`

  Expected failure: 8 new tests fail, all on `expect(err).toBeInstanceOf(PublishError)`, but for two different reasons under the Step 6 implementation. The `quotaExceeded`/`uploadLimitExceeded`/`dailyLimitExceeded`/401/400/503 tests (6 tests) each supply only ONE queued response; Step 6's implementation never checks `initiateRes.ok`, so it reads a (missing) `location` header as `null` and calls `fetchImpl` a second time — the fake's response queue is exhausted, so `fakeFetch` itself throws `TypeError: Cannot read properties of undefined (reading 'body')`, which is not a `PublishError`. The network-failure test's raw `AbortError` and the ENOENT test's raw `Error: ENOENT: no such file or directory, open '/nonexistent/brainrot-yt-missing/video.mp4'` both propagate unwrapped for the same reason (Step 6 has no try/catch around either). The 9 existing tests still pass. `Tests  8 failed | 9 passed (17)`.

- [ ] **Step 8: Implement full error-kind mapping, run green**

  In `src/publish/youtube.ts`, insert the following two helpers immediately above the `youtubeTarget` function (after `INITIATE_URL`):

  ```ts
  // Wire shape of a YouTube Data API error body — errors[].reason is where the
  // quota-vs-everything-else distinction lives; the HTTP status alone is not
  // enough (quota errors arrive as plain 403s, same as other permission 4xxs).
  interface YoutubeErrorBody {
    error?: { errors?: Array<{ reason?: string }> }
  }
  const QUOTA_REASONS = new Set(['quotaExceeded', 'uploadLimitExceeded', 'dailyLimitExceeded'])

  async function mapUploadHttpError(op: string, res: Response): Promise<PublishError> {
    const raw = await res.text().catch(() => '')
    let reasons: string[] = []
    try {
      const parsed = JSON.parse(raw) as YoutubeErrorBody
      reasons = (parsed.error?.errors ?? []).map((e) => e.reason).filter((r): r is string => Boolean(r))
    } catch {
      // Non-JSON body: nothing to inspect, fall through to status-only mapping.
    }
    if (reasons.some((r) => QUOTA_REASONS.has(r))) {
      return new PublishError(`${op}: ${res.status} quota error: ${raw}`, 'quota')
    }
    if (res.status === 401) {
      return new PublishError(`${op}: ${res.status} auth error: ${raw}`, 'auth')
    }
    if (res.status >= 500) {
      return new PublishError(`${op}: ${res.status} server error: ${raw}`, 'transient')
    }
    return new PublishError(`${op}: ${res.status} rejected: ${raw}`, 'rejected')
  }
  ```

  Then replace the `youtubeTarget` function with the hardened version:

  ```ts
  export function youtubeTarget(fetchImpl: typeof fetch = fetch): PublishTarget {
    return {
      platformId: 'youtube',
      async upload(req, accessToken) {
        const { videoPath, meta, publish } = req
        const description =
          meta.hashtags.length > 0 ? `${meta.description}\n\n${meta.hashtags.join(' ')}` : meta.description
        const metadataBody = {
          snippet: {
            title: meta.title,
            description,
            tags: meta.hashtags.map((h) => h.replace(/^#/, '')),
            categoryId: String(publish.categoryId),
          },
          status: {
            privacyStatus: publish.privacy,
            selfDeclaredMadeForKids: publish.madeForKids,
            containsSyntheticMedia: true,
          },
        }

        let initiateRes: Response
        try {
          initiateRes = await fetchImpl(INITIATE_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(metadataBody),
            signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
          })
        } catch (err) {
          throw networkError('youtubeTarget', err)
        }
        if (!initiateRes.ok) {
          throw await mapUploadHttpError('youtubeTarget', initiateRes)
        }
        const location = initiateRes.headers.get('location')
        if (!location) {
          throw new PublishError('youtubeTarget: resumable initiate response carried no Location header', 'transient')
        }

        let bytes: Buffer
        try {
          bytes = readFileSync(videoPath)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new PublishError(`youtubeTarget: video file not found at ${videoPath}`, 'rejected')
          }
          throw err
        }

        let uploadRes: Response
        try {
          uploadRes = await fetchImpl(location, {
            method: 'PUT',
            body: bytes,
            signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
          })
        } catch (err) {
          throw networkError('youtubeTarget', err)
        }
        if (!uploadRes.ok) {
          throw await mapUploadHttpError('youtubeTarget', uploadRes)
        }
        const body = (await uploadRes.json()) as { id?: string }
        if (!body.id) {
          throw new PublishError('youtubeTarget: upload response carried no video id', 'transient')
        }
        return { postId: body.id, url: `https://youtube.com/shorts/${body.id}` }
      },
    }
  }
  ```

  Run: `npx vitest run src/publish/youtube.test.ts`

  Expected: `Test Files  1 passed (1)`, `Tests  17 passed (17)`.

- [ ] **Step 9: Run the full suite, then commit**

  ```bash
  npm test
  ```

  Expected: every test file passes, 0 failures (this task only adds new files under `src/publish/`; nothing existing is touched).

  ```bash
  git add src/publish/youtube.ts src/publish/youtube.test.ts
  git commit -m "$(cat <<'EOF'
  feat: add YouTube adapter — token mint, resumable upload, error-kind mapping

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

### Task 9: OAuth flow + auth CLI

**Files:** Create: `src/publish/oauth-flow.ts`. Modify: `src/cli.ts`. Test: `src/publish/oauth-flow.test.ts`.

**Interfaces:**
- Consumes:
  - `export const YT_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload'` — `src/publish/youtube.ts` (Task 8)
  - `export function parseTokenKey(hex: string | undefined): Buffer` — `src/publish/crypto.ts` (Task 2)
  - `export function upsertToken(db: Database, platform: Platform, channel: string, refreshToken: string, scopes: string, key: Buffer): void` — `src/publish/tokens.ts` (Task 4)
  - `export function loadChannelsDir(dir: string): ChannelConfig[]` — `src/config/channel.ts` (existing; `ChannelConfig.name: string`)
  - `export function openDb(dbPath: string): Database` — `src/db/index.ts` (existing)
  - `resolveDbPath(flagDb?: string): string` — `src/cli.ts` module-local (existing)
  - `execa` from the `execa` npm package (existing dep, already used in `src/media/ffmpeg.ts`, `src/stages/qc.ts`)
- Produces:
  - `export const AUTH_FLOW_TIMEOUT_MS = 300_000` — `src/publish/oauth-flow.ts`
  - `export async function runYoutubeAuthFlow(opts: { clientId: string; clientSecret: string; openBrowser?: (url: string) => void | Promise<void>; fetchImpl?: typeof fetch; listenPort?: number }): Promise<{ refreshToken: string; scopes: string }>` — `src/publish/oauth-flow.ts`; referenced by Task 14's README setup walkthrough
  - `brainrot auth youtube --channel <name> [--db <path>] [--channels-dir <dir>]` CLI command — writes `oauth_tokens` rows that Task 10's `publishNextTick` (via `loadRefreshToken`) later reads

- [ ] **Step 1: Write failing tests for the happy-path flow (consent URL shape, redirect page body, token exchange, returned refresh token/scopes)**

Create `src/publish/oauth-flow.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { AUTH_FLOW_TIMEOUT_MS, runYoutubeAuthFlow } from './oauth-flow.js'
import { YT_UPLOAD_SCOPE } from './youtube.js'

describe('AUTH_FLOW_TIMEOUT_MS', () => {
  it('is 5 minutes', () => {
    expect(AUTH_FLOW_TIMEOUT_MS).toBe(300_000)
  })
})

describe('runYoutubeAuthFlow', () => {
  it('drives consent -> redirect -> exchange end-to-end and returns the refresh token', async () => {
    let redirectBody = ''
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(url).toBe('https://oauth2.googleapis.com/token')
      const params = new URLSearchParams(init?.body as string)
      expect(params.get('code')).toBe('test-auth-code')
      expect(params.get('client_id')).toBe('test-client-id')
      expect(params.get('client_secret')).toBe('test-client-secret')
      expect(params.get('grant_type')).toBe('authorization_code')
      expect(params.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      return new Response(
        JSON.stringify({ refresh_token: 'rt-test-token', scope: YT_UPLOAD_SCOPE }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const openBrowser = async (url: string) => {
      const consentUrl = new URL(url)
      expect(consentUrl.origin + consentUrl.pathname).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      )
      expect(consentUrl.searchParams.get('client_id')).toBe('test-client-id')
      expect(consentUrl.searchParams.get('response_type')).toBe('code')
      expect(consentUrl.searchParams.get('scope')).toBe(YT_UPLOAD_SCOPE)
      expect(consentUrl.searchParams.get('access_type')).toBe('offline')
      expect(consentUrl.searchParams.get('prompt')).toBe('consent')
      const state = consentUrl.searchParams.get('state')
      expect(state).toMatch(/^[0-9a-f]{32}$/)
      const redirectUri = consentUrl.searchParams.get('redirect_uri')
      const res = await fetch(`${redirectUri}/?code=test-auth-code&state=${state}`)
      redirectBody = await res.text()
    }

    const result = await runYoutubeAuthFlow({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      listenPort: 0,
      openBrowser,
      fetchImpl,
    })

    expect(result).toEqual({ refreshToken: 'rt-test-token', scopes: YT_UPLOAD_SCOPE })
    expect(redirectBody).toContain('close this tab')
  })
})
```

- [ ] **Step 2: Run it, confirm it fails because the module does not exist yet**

Run: `npx vitest run src/publish/oauth-flow.test.ts`

Expected failure (import-time, module file missing):
```
FAIL  src/publish/oauth-flow.test.ts [ src/publish/oauth-flow.test.ts ]
Error: Failed to resolve import "./oauth-flow.js" from "src/publish/oauth-flow.test.ts". Does the file exist?
```

- [ ] **Step 3: Implement the happy-path flow (no state/refresh_token validation yet)**

Create `src/publish/oauth-flow.ts`:

```ts
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { execa } from 'execa'
import { YT_UPLOAD_SCOPE } from './youtube.js'

// Alex sits through this once per channel; 5 minutes covers a slow account
// picker or a 2FA prompt without leaving the loopback listener open forever.
export const AUTH_FLOW_TIMEOUT_MS = 300_000

// Desktop-app OAuth clients accept ANY loopback redirect URI (no pre-registration),
// so `open` plus a throwaway ephemeral port is the whole browser-launch story.
async function defaultOpenBrowser(url: string): Promise<void> {
  await execa('open', [url])
}

const REDIRECT_PAGE =
  '<!doctype html><html><body><p>Signed in. You can close this tab.</p></body></html>'

/**
 * One-shot interactive OAuth flow for a single YouTube channel grant:
 * loopback listener -> browser consent -> code exchange -> refresh token.
 * The server is always torn down (finally), win or lose, so a rejected or
 * timed-out flow never leaves a port open.
 */
export async function runYoutubeAuthFlow(opts: {
  clientId: string
  clientSecret: string
  openBrowser?: (url: string) => void | Promise<void>
  fetchImpl?: typeof fetch
  listenPort?: number
}): Promise<{ refreshToken: string; scopes: string }> {
  const openBrowser = opts.openBrowser ?? defaultOpenBrowser
  const fetchImpl = opts.fetchImpl ?? fetch
  const state = randomBytes(16).toString('hex')

  let resolveCode: (code: string) => void
  const codeReceived = new Promise<string>((resolve) => {
    resolveCode = resolve
  })

  const server = http.createServer((req, res) => {
    const redirectUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(REDIRECT_PAGE)
    const code = redirectUrl.searchParams.get('code')
    if (code) resolveCode(code)
  })

  try {
    await new Promise<void>((resolve) => server.listen(opts.listenPort ?? 0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const redirectUri = `http://127.0.0.1:${port}`

    const consentUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    consentUrl.searchParams.set('client_id', opts.clientId)
    consentUrl.searchParams.set('redirect_uri', redirectUri)
    consentUrl.searchParams.set('response_type', 'code')
    consentUrl.searchParams.set('scope', YT_UPLOAD_SCOPE)
    consentUrl.searchParams.set('access_type', 'offline')
    consentUrl.searchParams.set('prompt', 'consent')
    consentUrl.searchParams.set('state', state)

    await openBrowser(consentUrl.toString())

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              `runYoutubeAuthFlow: timed out waiting for consent redirect after ${AUTH_FLOW_TIMEOUT_MS}ms`,
            ),
          ),
        AUTH_FLOW_TIMEOUT_MS,
      ).unref()
    })
    const code = await Promise.race([codeReceived, timeout])

    const tokenRes = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    })
    if (!tokenRes.ok) {
      throw new Error(`runYoutubeAuthFlow: token endpoint responded ${tokenRes.status}`)
    }
    const body = (await tokenRes.json()) as { refresh_token: string; scope?: string }
    return { refreshToken: body.refresh_token, scopes: body.scope ?? YT_UPLOAD_SCOPE }
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
```

- [ ] **Step 4: Run it again, confirm the happy-path test passes**

Run: `npx vitest run src/publish/oauth-flow.test.ts`

Expected:
```
✓ src/publish/oauth-flow.test.ts (2 tests)
Test Files  1 passed (1)
     Tests  2 passed (2)
```

- [ ] **Step 5: Write a failing test for the missing-`refresh_token` case (exact contract message)**

Replace `src/publish/oauth-flow.test.ts` with (adds one `describe` block after the existing `runYoutubeAuthFlow` tests, same file otherwise unchanged):

```ts
import { describe, expect, it } from 'vitest'
import { AUTH_FLOW_TIMEOUT_MS, runYoutubeAuthFlow } from './oauth-flow.js'
import { YT_UPLOAD_SCOPE } from './youtube.js'

describe('AUTH_FLOW_TIMEOUT_MS', () => {
  it('is 5 minutes', () => {
    expect(AUTH_FLOW_TIMEOUT_MS).toBe(300_000)
  })
})

describe('runYoutubeAuthFlow', () => {
  it('drives consent -> redirect -> exchange end-to-end and returns the refresh token', async () => {
    let redirectBody = ''
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(url).toBe('https://oauth2.googleapis.com/token')
      const params = new URLSearchParams(init?.body as string)
      expect(params.get('code')).toBe('test-auth-code')
      expect(params.get('client_id')).toBe('test-client-id')
      expect(params.get('client_secret')).toBe('test-client-secret')
      expect(params.get('grant_type')).toBe('authorization_code')
      expect(params.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      return new Response(
        JSON.stringify({ refresh_token: 'rt-test-token', scope: YT_UPLOAD_SCOPE }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const openBrowser = async (url: string) => {
      const consentUrl = new URL(url)
      expect(consentUrl.origin + consentUrl.pathname).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      )
      expect(consentUrl.searchParams.get('client_id')).toBe('test-client-id')
      expect(consentUrl.searchParams.get('response_type')).toBe('code')
      expect(consentUrl.searchParams.get('scope')).toBe(YT_UPLOAD_SCOPE)
      expect(consentUrl.searchParams.get('access_type')).toBe('offline')
      expect(consentUrl.searchParams.get('prompt')).toBe('consent')
      const state = consentUrl.searchParams.get('state')
      expect(state).toMatch(/^[0-9a-f]{32}$/)
      const redirectUri = consentUrl.searchParams.get('redirect_uri')
      const res = await fetch(`${redirectUri}/?code=test-auth-code&state=${state}`)
      redirectBody = await res.text()
    }

    const result = await runYoutubeAuthFlow({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      listenPort: 0,
      openBrowser,
      fetchImpl,
    })

    expect(result).toEqual({ refreshToken: 'rt-test-token', scopes: YT_UPLOAD_SCOPE })
    expect(redirectBody).toContain('close this tab')
  })

  it('rejects with a message telling the operator to remove the prior grant when the exchange returns no refresh_token', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ scope: YT_UPLOAD_SCOPE }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

    const openBrowser = async (url: string) => {
      const consentUrl = new URL(url)
      const state = consentUrl.searchParams.get('state')
      const redirectUri = consentUrl.searchParams.get('redirect_uri')
      await fetch(`${redirectUri}/?code=test-auth-code&state=${state}`)
    }

    await expect(
      runYoutubeAuthFlow({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        listenPort: 0,
        openBrowser,
        fetchImpl,
      }),
    ).rejects.toThrow(
      'runYoutubeAuthFlow: no refresh_token in response; remove prior grant at myaccount.google.com/permissions and retry',
    )
  })
})
```

- [ ] **Step 6: Run it, confirm the new test fails (the promise resolves instead of rejecting)**

Run: `npx vitest run src/publish/oauth-flow.test.ts`

Expected failure (Step 3's implementation has no guard, so `body.refresh_token` is silently `undefined`):
```
✗ runYoutubeAuthFlow > rejects with a message telling the operator to remove the prior grant when the exchange returns no refresh_token
AssertionError: promise resolved instead of rejecting
Resolved to value: { refreshToken: undefined, scopes: "https://www.googleapis.com/auth/youtube.upload" }
```

- [ ] **Step 7: Add the missing-refresh_token guard**

Replace `src/publish/oauth-flow.ts` with (only the `body` type and the return line change — everything else is identical to Step 3):

```ts
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { execa } from 'execa'
import { YT_UPLOAD_SCOPE } from './youtube.js'

// Alex sits through this once per channel; 5 minutes covers a slow account
// picker or a 2FA prompt without leaving the loopback listener open forever.
export const AUTH_FLOW_TIMEOUT_MS = 300_000

// Desktop-app OAuth clients accept ANY loopback redirect URI (no pre-registration),
// so `open` plus a throwaway ephemeral port is the whole browser-launch story.
async function defaultOpenBrowser(url: string): Promise<void> {
  await execa('open', [url])
}

const REDIRECT_PAGE =
  '<!doctype html><html><body><p>Signed in. You can close this tab.</p></body></html>'

/**
 * One-shot interactive OAuth flow for a single YouTube channel grant:
 * loopback listener -> browser consent -> code exchange -> refresh token.
 * The server is always torn down (finally), win or lose, so a rejected or
 * timed-out flow never leaves a port open.
 */
export async function runYoutubeAuthFlow(opts: {
  clientId: string
  clientSecret: string
  openBrowser?: (url: string) => void | Promise<void>
  fetchImpl?: typeof fetch
  listenPort?: number
}): Promise<{ refreshToken: string; scopes: string }> {
  const openBrowser = opts.openBrowser ?? defaultOpenBrowser
  const fetchImpl = opts.fetchImpl ?? fetch
  const state = randomBytes(16).toString('hex')

  let resolveCode: (code: string) => void
  const codeReceived = new Promise<string>((resolve) => {
    resolveCode = resolve
  })

  const server = http.createServer((req, res) => {
    const redirectUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(REDIRECT_PAGE)
    const code = redirectUrl.searchParams.get('code')
    if (code) resolveCode(code)
  })

  try {
    await new Promise<void>((resolve) => server.listen(opts.listenPort ?? 0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const redirectUri = `http://127.0.0.1:${port}`

    const consentUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    consentUrl.searchParams.set('client_id', opts.clientId)
    consentUrl.searchParams.set('redirect_uri', redirectUri)
    consentUrl.searchParams.set('response_type', 'code')
    consentUrl.searchParams.set('scope', YT_UPLOAD_SCOPE)
    consentUrl.searchParams.set('access_type', 'offline')
    consentUrl.searchParams.set('prompt', 'consent')
    consentUrl.searchParams.set('state', state)

    await openBrowser(consentUrl.toString())

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              `runYoutubeAuthFlow: timed out waiting for consent redirect after ${AUTH_FLOW_TIMEOUT_MS}ms`,
            ),
          ),
        AUTH_FLOW_TIMEOUT_MS,
      ).unref()
    })
    const code = await Promise.race([codeReceived, timeout])

    const tokenRes = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    })
    if (!tokenRes.ok) {
      throw new Error(`runYoutubeAuthFlow: token endpoint responded ${tokenRes.status}`)
    }
    const body = (await tokenRes.json()) as { refresh_token?: string; scope?: string }
    if (!body.refresh_token) {
      throw new Error(
        'runYoutubeAuthFlow: no refresh_token in response; remove prior grant at myaccount.google.com/permissions and retry',
      )
    }
    return { refreshToken: body.refresh_token, scopes: body.scope ?? YT_UPLOAD_SCOPE }
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
```

- [ ] **Step 8: Run it again, confirm both tests pass**

Run: `npx vitest run src/publish/oauth-flow.test.ts`

Expected:
```
✓ src/publish/oauth-flow.test.ts (3 tests)
Test Files  1 passed (1)
     Tests  3 passed (3)
```

- [ ] **Step 9: Write a failing test for state-mismatch rejection**

Append this test to the `describe('runYoutubeAuthFlow', ...)` block in `src/publish/oauth-flow.test.ts` (after the missing-refresh_token test, before its closing `})`):

```ts
  it('rejects when the redirect state does not match the one sent to Google', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('fetchImpl must not be called on a state mismatch')
    }

    const openBrowser = async (url: string) => {
      const consentUrl = new URL(url)
      const redirectUri = consentUrl.searchParams.get('redirect_uri')
      await fetch(`${redirectUri}/?code=test-auth-code&state=wrong-state`)
    }

    await expect(
      runYoutubeAuthFlow({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        listenPort: 0,
        openBrowser,
        fetchImpl,
      }),
    ).rejects.toThrow('runYoutubeAuthFlow: state mismatch on redirect (possible CSRF)')
  })
```

The full file at this point is (all four tests together):

```ts
import { describe, expect, it } from 'vitest'
import { AUTH_FLOW_TIMEOUT_MS, runYoutubeAuthFlow } from './oauth-flow.js'
import { YT_UPLOAD_SCOPE } from './youtube.js'

describe('AUTH_FLOW_TIMEOUT_MS', () => {
  it('is 5 minutes', () => {
    expect(AUTH_FLOW_TIMEOUT_MS).toBe(300_000)
  })
})

describe('runYoutubeAuthFlow', () => {
  it('drives consent -> redirect -> exchange end-to-end and returns the refresh token', async () => {
    let redirectBody = ''
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(url).toBe('https://oauth2.googleapis.com/token')
      const params = new URLSearchParams(init?.body as string)
      expect(params.get('code')).toBe('test-auth-code')
      expect(params.get('client_id')).toBe('test-client-id')
      expect(params.get('client_secret')).toBe('test-client-secret')
      expect(params.get('grant_type')).toBe('authorization_code')
      expect(params.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      return new Response(
        JSON.stringify({ refresh_token: 'rt-test-token', scope: YT_UPLOAD_SCOPE }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const openBrowser = async (url: string) => {
      const consentUrl = new URL(url)
      expect(consentUrl.origin + consentUrl.pathname).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      )
      expect(consentUrl.searchParams.get('client_id')).toBe('test-client-id')
      expect(consentUrl.searchParams.get('response_type')).toBe('code')
      expect(consentUrl.searchParams.get('scope')).toBe(YT_UPLOAD_SCOPE)
      expect(consentUrl.searchParams.get('access_type')).toBe('offline')
      expect(consentUrl.searchParams.get('prompt')).toBe('consent')
      const state = consentUrl.searchParams.get('state')
      expect(state).toMatch(/^[0-9a-f]{32}$/)
      const redirectUri = consentUrl.searchParams.get('redirect_uri')
      const res = await fetch(`${redirectUri}/?code=test-auth-code&state=${state}`)
      redirectBody = await res.text()
    }

    const result = await runYoutubeAuthFlow({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      listenPort: 0,
      openBrowser,
      fetchImpl,
    })

    expect(result).toEqual({ refreshToken: 'rt-test-token', scopes: YT_UPLOAD_SCOPE })
    expect(redirectBody).toContain('close this tab')
  })

  it('rejects with a message telling the operator to remove the prior grant when the exchange returns no refresh_token', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ scope: YT_UPLOAD_SCOPE }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

    const openBrowser = async (url: string) => {
      const consentUrl = new URL(url)
      const state = consentUrl.searchParams.get('state')
      const redirectUri = consentUrl.searchParams.get('redirect_uri')
      await fetch(`${redirectUri}/?code=test-auth-code&state=${state}`)
    }

    await expect(
      runYoutubeAuthFlow({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        listenPort: 0,
        openBrowser,
        fetchImpl,
      }),
    ).rejects.toThrow(
      'runYoutubeAuthFlow: no refresh_token in response; remove prior grant at myaccount.google.com/permissions and retry',
    )
  })

  it('rejects when the redirect state does not match the one sent to Google', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('fetchImpl must not be called on a state mismatch')
    }

    const openBrowser = async (url: string) => {
      const consentUrl = new URL(url)
      const redirectUri = consentUrl.searchParams.get('redirect_uri')
      await fetch(`${redirectUri}/?code=test-auth-code&state=wrong-state`)
    }

    await expect(
      runYoutubeAuthFlow({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        listenPort: 0,
        openBrowser,
        fetchImpl,
      }),
    ).rejects.toThrow('runYoutubeAuthFlow: state mismatch on redirect (possible CSRF)')
  })
})
```

- [ ] **Step 10: Run it, confirm the new test fails (wrong error surfaces)**

Run: `npx vitest run src/publish/oauth-flow.test.ts`

Expected failure (Step 7's implementation ignores `state`, so `fetchImpl` — which throws — is reached instead of a state-mismatch rejection):
```
✗ runYoutubeAuthFlow > rejects when the redirect state does not match the one sent to Google
AssertionError: expected error message to include 'runYoutubeAuthFlow: state mismatch on redirect (possible CSRF)'
but got 'fetchImpl must not be called on a state mismatch'
```

- [ ] **Step 11: Add the state-mismatch check**

Replace `src/publish/oauth-flow.ts` with (adds a `rejectCode` branch and the state comparison inside the request handler — everything else is identical to Step 7):

```ts
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { execa } from 'execa'
import { YT_UPLOAD_SCOPE } from './youtube.js'

// Alex sits through this once per channel; 5 minutes covers a slow account
// picker or a 2FA prompt without leaving the loopback listener open forever.
export const AUTH_FLOW_TIMEOUT_MS = 300_000

// Desktop-app OAuth clients accept ANY loopback redirect URI (no pre-registration),
// so `open` plus a throwaway ephemeral port is the whole browser-launch story.
async function defaultOpenBrowser(url: string): Promise<void> {
  await execa('open', [url])
}

const REDIRECT_PAGE =
  '<!doctype html><html><body><p>Signed in. You can close this tab.</p></body></html>'

/**
 * One-shot interactive OAuth flow for a single YouTube channel grant:
 * loopback listener -> browser consent -> code exchange -> refresh token.
 * The server is always torn down (finally), win or lose, so a rejected or
 * timed-out flow never leaves a port open.
 */
export async function runYoutubeAuthFlow(opts: {
  clientId: string
  clientSecret: string
  openBrowser?: (url: string) => void | Promise<void>
  fetchImpl?: typeof fetch
  listenPort?: number
}): Promise<{ refreshToken: string; scopes: string }> {
  const openBrowser = opts.openBrowser ?? defaultOpenBrowser
  const fetchImpl = opts.fetchImpl ?? fetch
  const state = randomBytes(16).toString('hex')

  let resolveCode: (code: string) => void
  let rejectCode: (err: Error) => void
  const codeReceived = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })

  // Any mismatch between the state Google echoes back and the one this run
  // generated means the redirect did not originate from the consent screen
  // this process opened — reject before ever exchanging a code.
  const server = http.createServer((req, res) => {
    const redirectUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(REDIRECT_PAGE)
    if (redirectUrl.searchParams.get('state') !== state) {
      rejectCode(new Error('runYoutubeAuthFlow: state mismatch on redirect (possible CSRF)'))
      return
    }
    const code = redirectUrl.searchParams.get('code')
    if (code) resolveCode(code)
  })

  try {
    await new Promise<void>((resolve) => server.listen(opts.listenPort ?? 0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const redirectUri = `http://127.0.0.1:${port}`

    const consentUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    consentUrl.searchParams.set('client_id', opts.clientId)
    consentUrl.searchParams.set('redirect_uri', redirectUri)
    consentUrl.searchParams.set('response_type', 'code')
    consentUrl.searchParams.set('scope', YT_UPLOAD_SCOPE)
    consentUrl.searchParams.set('access_type', 'offline')
    consentUrl.searchParams.set('prompt', 'consent')
    consentUrl.searchParams.set('state', state)

    await openBrowser(consentUrl.toString())

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              `runYoutubeAuthFlow: timed out waiting for consent redirect after ${AUTH_FLOW_TIMEOUT_MS}ms`,
            ),
          ),
        AUTH_FLOW_TIMEOUT_MS,
      ).unref()
    })
    const code = await Promise.race([codeReceived, timeout])

    const tokenRes = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    })
    if (!tokenRes.ok) {
      throw new Error(`runYoutubeAuthFlow: token endpoint responded ${tokenRes.status}`)
    }
    const body = (await tokenRes.json()) as { refresh_token?: string; scope?: string }
    if (!body.refresh_token) {
      throw new Error(
        'runYoutubeAuthFlow: no refresh_token in response; remove prior grant at myaccount.google.com/permissions and retry',
      )
    }
    return { refreshToken: body.refresh_token, scopes: body.scope ?? YT_UPLOAD_SCOPE }
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
```

- [ ] **Step 12: Run it again, confirm all four tests pass**

Run: `npx vitest run src/publish/oauth-flow.test.ts`

Expected:
```
✓ src/publish/oauth-flow.test.ts (4 tests)
Test Files  1 passed (1)
     Tests  4 passed (4)
```

- [ ] **Step 13: Wire the `auth youtube` CLI command (glue only — no dedicated test; `runYoutubeAuthFlow` carries the behavior)**

In `src/cli.ts`, add three imports after the existing `import type { Tier } from './jobs/types.js'` line:

```ts
import { runYoutubeAuthFlow } from './publish/oauth-flow.js'
import { parseTokenKey } from './publish/crypto.js'
import { upsertToken } from './publish/tokens.js'
```

Then, after the `topics.command('reject <ids...>')` block's closing `})` and before `program.command('digest')`, insert:

```ts
// Interactive per-channel OAuth grant (design spec §4.2). Thin glue: all flow
// logic and error taxonomy live in runYoutubeAuthFlow; this action only
// resolves the channel/env inputs around it and persists the result.
const auth = program.command('auth')

auth
  .command('youtube')
  .requiredOption('--channel <name>', 'channel name to authorize')
  .option('--db <path>', 'sqlite db path')
  .option('--channels-dir <dir>', 'channel TOML directory', 'channels')
  .action(async (opts: { channel: string; db?: string; channelsDir: string }) => {
    // Channel + env checks precede any db handle or browser launch, so a typo
    // or missing credential fails clean before Alex is asked to click through
    // a Google consent screen.
    const channels = loadChannelsDir(opts.channelsDir)
    const channel = channels.find((c) => c.name === opts.channel)
    if (!channel) {
      throw new Error(`auth youtube: unknown channel "${opts.channel}" (checked ${opts.channelsDir})`)
    }
    const key = parseTokenKey(process.env.BRAINROT_TOKEN_KEY)
    const clientId = process.env.YT_CLIENT_ID
    if (!clientId) {
      throw new Error('auth youtube: YT_CLIENT_ID is not set (add it to .env)')
    }
    const clientSecret = process.env.YT_CLIENT_SECRET
    if (!clientSecret) {
      throw new Error('auth youtube: YT_CLIENT_SECRET is not set (add it to .env)')
    }
    const granted = await runYoutubeAuthFlow({ clientId, clientSecret })
    const db = openDb(resolveDbPath(opts.db))
    try {
      upsertToken(db, 'youtube', channel.name, granted.refreshToken, granted.scopes, key)
    } finally {
      db.close()
    }
    // Confirmation only — never the refresh token itself (house rule: token
    // material never touches logs or stdout).
    console.log(`authorized youtube for channel "${channel.name}" — scopes: ${granted.scopes}`)
  })
```

- [ ] **Step 14: Run the full suite, confirm no regressions**

Run: `npm test`

Expected: every existing suite still passes, plus the new `src/publish/oauth-flow.test.ts` (4 tests); exit code 0. Contract tests remain excluded (`CONTRACT` unset), matching `vitest.config.ts`.

- [ ] **Step 15: Commit**

```
git add src/publish/oauth-flow.ts src/publish/oauth-flow.test.ts src/cli.ts && git commit -m "feat: add YouTube OAuth loopback flow and auth CLI command"
```

### Task 10: publish-next tick + CLI

**Files:**
- Create: `src/loop/publish-next.ts`
- Modify: `src/loop/lease.ts` (add `PUBLISH_LEASE_TTL_MS`)
- Modify: `src/cli.ts`
- Test: `src/loop/publish-next.test.ts`, `src/loop/lease.test.ts`

**Interfaces:**

- Consumes (exact signatures — existing code and lower-numbered tasks):

```ts
// src/loop/lease.ts (existing; this task adds PUBLISH_LEASE_TTL_MS)
export function acquireLease(db: Database, name: string, holder: string, ttlMs: number): boolean
export function releaseLease(db: Database, name: string, holder: string): void

// src/db/index.ts (existing)
export function openDb(dbPath: string): Database   // ':memory:' works in tests

// src/config/channel.ts (Task 5)
export function loadChannelsDir(dir: string): ChannelConfig[]
// ChannelConfig gained: publish: PublishChannelConfig | null

// src/publish/types.ts (Task 3)
export const PUBLISH_PLATFORMS = ['youtube'] as const
export type Platform = (typeof PUBLISH_PLATFORMS)[number]
export type PublishErrorKind = 'auth' | 'quota' | 'rejected' | 'transient'
export class PublishError extends Error { constructor(message: string, public kind: PublishErrorKind) }
export interface PlatformMeta { title: string; description: string; hashtags: string[] }
export interface PublishChannelConfig {
  slots: string[]; platforms: Platform[]
  privacy: 'public' | 'unlisted' | 'private'; categoryId: number; madeForKids: boolean
}
export interface PublishTarget {
  readonly platformId: Platform
  upload(req: { videoPath: string; meta: PlatformMeta; publish: PublishChannelConfig }, accessToken: string): Promise<{ postId: string; url: string }>
}
export function resolvePlatformMeta(metadataJson: string, platform: Platform, fallbackTopic: string): PlatformMeta

// src/publish/crypto.ts (Task 2)
export function parseTokenKey(hex: string | undefined): Buffer
// throws 'BRAINROT_TOKEN_KEY must be 64 hex characters' on missing/malformed

// src/publish/tokens.ts (Task 4) — upsertToken is test-fixture-only here
export function upsertToken(db: Database, platform: Platform, channel: string, refreshToken: string, scopes: string, key: Buffer): void
export function loadRefreshToken(db: Database, platform: Platform, channel: string, key: Buffer): string | null

// src/publish/slots.ts (Task 6) — pure
export function localDay(now: Date): string
export function dueSlotsForChannel(cfg: PublishChannelConfig, consumed: Set<string>, now: Date): string[]
export interface SlotCandidate { channel: string; platform: Platform; slot: string; filledCount: number; totalSlots: number }
export function orderCandidates(candidates: SlotCandidate[]): SlotCandidate[]

// src/publish/publishes.ts (Task 7)
export function claimPublish(db: Database, opts: { jobId: string; platform: Platform; channel: string; day: string; slot: string }): number | null
export function markPublishDone(db: Database, id: number, postId: string, url: string, now: Date): void
export function markPublishFailed(db: Database, id: number, error: string, kind: PublishErrorKind, now: Date): void
export function sweepInterrupted(db: Database, olderThanMs: number, now: Date): number
export function consumedSlots(db: Database, channel: string, platform: Platform, day: string): Set<string>
export function uploadsUsedToday(db: Database, platform: Platform, day: string): number
export function eligibleVideo(db: Database, channel: string, platform: Platform): { jobId: string; videoPath: string; metadataJson: string; topic: string } | null

// src/publish/youtube.ts (Task 8) — YT_UPLOAD_SCOPE is test-fixture-only here
export const YT_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload'
export function ytUploadsPerDayCap(): number   // BRAINROT_YT_UPLOADS_PER_DAY, default 6
export async function mintAccessToken(opts: { refreshToken: string; clientId: string; clientSecret: string; fetchImpl?: typeof fetch }): Promise<string>
export function youtubeTarget(fetchImpl?: typeof fetch): PublishTarget
```

- Produces (binding — Task 14's golden-path loop test and Task 13's digest call `publishNextTick`/read `publishes` rows it wrote):

```ts
// src/loop/lease.ts (addition)
export const PUBLISH_LEASE_TTL_MS = 1_800_000   // 30 min; lease name literal: 'publish'; holder: `pid:${process.pid}`

// src/loop/publish-next.ts
export interface PublishTickResult {
  action: 'published' | 'publish-failed' | 'noop' | 'dry-run'
  reason?: 'lease-held' | 'no-due-slot' | 'platform-quota' | 'no-ready-video' | 'no-auth' | 'claim-conflict'
  channel?: string; platform?: Platform; jobId?: string; slot?: string
  postId?: string; url?: string; error?: string
  wouldPublish?: { channel: string; platform: Platform; slot: string; jobId: string; title: string } | null
}
export async function publishNextTick(db: Database, opts: {
  channelsDir: string
  target?: PublishTarget          // default youtubeTarget(); tests inject fakes
  fetchImpl?: typeof fetch        // threaded to mintAccessToken
  now?: () => Date                // default () => new Date()
  dryRun?: boolean
}): Promise<PublishTickResult>
// CLI: brainrot publish-next [--db <path>] [--channels-dir <dir>] [--dry-run]
// stdout: exactly one JSON line (PublishTickResult). exit 1 iff action === 'publish-failed'.
```

Semantics pinned by the contract and spec §6: holder is `` `pid:${process.pid}` ``, lease name `'publish'`. Dry-run performs ZERO writes: no lease, no repair sweep, no claim — it runs the same due-slot → quota-gate → fairness-order → candidate-scan selection as a real tick and stops the instant a viable candidate is found (or exhausted), returning `wouldPublish` (or `null` + `reason`) without ever calling `mintAccessToken` or `target.upload`. A non-dry-run tick wraps the whole plan-and-execute body in `try { ... } finally { releaseLease(...) }`, guarded by `acquireLease` up front exactly like `produceNextTick`. The quota gate checks `uploadsUsedToday(db, 'youtube', day)` — v1's only platform, so one check gates every candidate. Candidate iteration checks `eligibleVideo` first, then (only if a video was found) resolves auth: missing `YT_CLIENT_ID`/`YT_CLIENT_SECRET`/`BRAINROT_TOKEN_KEY` or a missing `oauth_tokens` row all map to the `no-auth` blocker; on full exhaustion the reported `reason` is the **first** candidate's blocker (the ordered list's `[0]` element), not an aggregate. `claimPublish` returning `null` (a racing tick already claimed this slot — unreachable under the lease, but a defensive exit) short-circuits to `{ action: 'noop', reason: 'claim-conflict' }`. On upload success, `markPublishDone` (one transaction: `publishes` → `done` + library → `published`); on failure, a `PublishError` carries its taxonomy `kind` straight through to `markPublishFailed`, any other thrown value maps to `kind: 'transient'` (safest default — retryable at the next slot, never silently retired via `'rejected'`).

House rules in force: ESM `.js` suffixes on relative imports; no semicolons, single quotes, trailing commas in `src/loop/` (match `src/loop/lease.ts` and `src/loop/produce-next.ts`); real SQLite via `openDb(':memory:')`; channel fixtures are TOML files in a temp dir (never `ChannelConfig` literals) exactly like `produce-next.test.ts`; conventional commits with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

---

- [ ] **Step 1: Write the failing `PUBLISH_LEASE_TTL_MS` test (red)**

  In `src/loop/lease.test.ts`, change the import line

  ```ts
  import { acquireLease, PRODUCE_LEASE_TTL_MS, releaseLease } from './lease.js'
  ```

  to

  ```ts
  import { acquireLease, PRODUCE_LEASE_TTL_MS, PUBLISH_LEASE_TTL_MS, releaseLease } from './lease.js'
  ```

  Then append at the end of the file:

  ```ts
  describe('PUBLISH_LEASE_TTL_MS', () => {
    it('is 30 minutes — a much shorter window than produce, one upload per tick', () => {
      expect(PUBLISH_LEASE_TTL_MS).toBe(1_800_000)
    })
  })
  ```

  Run it:

  ```bash
  npx vitest run src/loop/lease.test.ts
  ```

  Expected failure: `AssertionError: expected undefined to be 1800000` — the named import resolves to `undefined` because `lease.ts` does not export `PUBLISH_LEASE_TTL_MS` yet (a value import, not a call, so this surfaces as an assertion mismatch rather than a TypeError). The 12 existing tests stay green.

- [ ] **Step 2: Add the constant (green)**

  In `src/loop/lease.ts`, replace

  ```ts
  export const PRODUCE_LEASE_TTL_MS = 5_400_000 // 90 min
  ```

  with

  ```ts
  export const PRODUCE_LEASE_TTL_MS = 5_400_000 // 90 min

  // One upload per tick, so a much shorter window than produce's suffices —
  // generously above a single resumable-upload call's worst case.
  export const PUBLISH_LEASE_TTL_MS = 1_800_000 // 30 min
  ```

  Run to green:

  ```bash
  npx vitest run src/loop/lease.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  13 passed (13)`.

- [ ] **Step 3: Commit**

  ```bash
  git add src/loop/lease.ts src/loop/lease.test.ts
  git commit -m "feat(loop): add PUBLISH_LEASE_TTL_MS for the publish-next lease" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 4: Write the failing core-algorithm tests (red)**

  Create `src/loop/publish-next.test.ts` with exactly:

  ```ts
  import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
  import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import type { Database } from 'better-sqlite3'
  import { openDb } from '../db/index.js'
  import { parseTokenKey } from '../publish/crypto.js'
  import { claimPublish } from '../publish/publishes.js'
  import { upsertToken } from '../publish/tokens.js'
  import type { Platform, PublishTarget } from '../publish/types.js'
  import { YT_UPLOAD_SCOPE } from '../publish/youtube.js'
  import { acquireLease, PUBLISH_LEASE_TTL_MS } from './lease.js'
  import { publishNextTick } from './publish-next.js'

  // Spies claimPublish so the claim-conflict test can force a `null` return
  // (a racing-tick claim collision the publish lease makes unreachable in a
  // single-process run); every other test calls straight through to the real
  // DAO because vi.fn wraps actual.claimPublish as its default implementation.
  vi.mock('../publish/publishes.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../publish/publishes.js')>()
    return { ...actual, claimPublish: vi.fn(actual.claimPublish) }
  })

  // Local-time constructor (month is 0-based): 2026-07-22 14:05 machine-local.
  // Never string-parse datetimes in these tests — 'YYYY-MM-DDTHH:MM' parses
  // local while '...Z' parses UTC, and mixing the two makes assertions
  // timezone-dependent.
  const NOW = () => new Date(2026, 6, 22, 14, 5)
  const TEST_TOKEN_KEY_HEX = 'ab'.repeat(32)

  const cleanupDirs: string[] = []
  function tmpDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix))
    cleanupDirs.push(d)
    return d
  }
  afterAll(() => {
    for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true })
  })

  // Plan-1-shape channel TOML plus an optional [publish] table (spec §3.3).
  function channelToml(opts: { name: string; slots?: string[] }): string {
    const lines = [
      `name = "${opts.name}"`,
      'niche = ["space facts"]',
      'bg_dir = "assets/bg"',
      'bgm_dir = "assets/bgm"',
      '',
      '[tier_mix]',
      'volume = 2',
      'premium = 1',
      '',
      '[voice]',
      'volume = "af_heart"',
      '',
      '[caption_style]',
      'font = "Inter"',
      'font_size_px = 72',
      'active_color = "#FFD700"',
      'inactive_color = "#FFFFFF"',
      'stroke_px = 8',
      '',
      '[budget]',
      'per_video_usd = 8.0',
      'per_day_usd = 20.0',
    ]
    if (opts.slots !== undefined) {
      lines.push('', '[publish]', `slots = [${opts.slots.map((s) => `"${s}"`).join(', ')}]`)
    }
    return lines.join('\n')
  }

  function writeChannel(dir: string, opts: { name: string; slots?: string[] }): void {
    writeFileSync(join(dir, `${opts.name}.toml`), channelToml(opts))
  }

  let jobSeq = 0
  function seedReadyVideo(db: Database, opts: { channel: string; metadataJson?: string; topic?: string }): string {
    jobSeq += 1
    const jobId = `job-${jobSeq}`
    db.prepare("INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, ?, 'volume', ?, 'done')").run(
      jobId,
      opts.channel,
      opts.topic ?? 'A test topic',
    )
    db.prepare("INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, ?, ?, 'ready')").run(
      jobId,
      `/tmp/${jobId}.mp4`,
      opts.metadataJson ?? '{}',
    )
    return jobId
  }

  function seedToken(db: Database, channel: string): void {
    const key = parseTokenKey(TEST_TOKEN_KEY_HEX)
    upsertToken(db, 'youtube', channel, 'rt-test-token', YT_UPLOAD_SCOPE, key)
  }

  function seedConsumedSlot(db: Database, opts: { channel: string; platform: Platform; day: string; slot: string; status?: string }): void {
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt) VALUES (?, ?, ?, ?, ?, ?, 1)',
    ).run(`consumed-${opts.channel}-${opts.slot}`, opts.platform, opts.channel, opts.day, opts.slot, opts.status ?? 'done')
  }

  function seedQuotaRows(db: Database, opts: { count: number; status?: string }): void {
    for (let i = 0; i < opts.count; i++) {
      db.prepare(
        "INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt) VALUES (?, 'youtube', 'quota-chan', '2026-07-22', ?, ?, 1)",
      ).run(`quota-job-${i}`, `0${i}:00`, opts.status ?? 'done')
    }
  }

  function fakeTokenFetch(): typeof fetch {
    const impl: typeof fetch = async () =>
      new Response(JSON.stringify({ access_token: 'fake-access-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    return impl
  }

  function fakeTarget(upload: PublishTarget['upload']): PublishTarget {
    return { platformId: 'youtube', upload }
  }

  beforeEach(() => {
    vi.stubEnv('YT_CLIENT_ID', 'test-client-id')
    vi.stubEnv('YT_CLIENT_SECRET', 'test-client-secret')
    vi.stubEnv('BRAINROT_TOKEN_KEY', TEST_TOKEN_KEY_HEX)
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('publishNextTick — gates', () => {
    it('no-ops with reason no-due-slot when no channel has publishing configured', async () => {
      const db = openDb(':memory:')
      const channelsDir = tmpDir('brainrot-publish-nodue-')
      writeChannel(channelsDir, { name: 'chan-a' })
      const result = await publishNextTick(db, { channelsDir, now: NOW })
      expect(result).toEqual({ action: 'noop', reason: 'no-due-slot' })
      db.close()
    })

    it('no-ops with reason platform-quota once the default cap of 6 is met', async () => {
      const db = openDb(':memory:')
      const channelsDir = tmpDir('brainrot-publish-quota-')
      writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
      seedQuotaRows(db, { count: 6 })
      const result = await publishNextTick(db, { channelsDir, now: NOW })
      expect(result).toEqual({ action: 'noop', reason: 'platform-quota' })
      db.close()
    })

    it('honors the BRAINROT_YT_UPLOADS_PER_DAY override for the cap', async () => {
      const db = openDb(':memory:')
      const channelsDir = tmpDir('brainrot-publish-quota-override-')
      writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
      seedQuotaRows(db, { count: 1 })
      vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '1')
      const result = await publishNextTick(db, { channelsDir, now: NOW })
      expect(result).toEqual({ action: 'noop', reason: 'platform-quota' })
      db.close()
    })

    it('no-ops with reason no-ready-video when the channel has a due slot but an empty library', async () => {
      const db = openDb(':memory:')
      const channelsDir = tmpDir('brainrot-publish-novideo-')
      writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
      const result = await publishNextTick(db, { channelsDir, now: NOW })
      expect(result).toEqual({ action: 'noop', reason: 'no-ready-video' })
      db.close()
    })

    it('no-ops with reason no-auth when the YouTube client credentials are unset', async () => {
      const db = openDb(':memory:')
      const channelsDir = tmpDir('brainrot-publish-noauth-env-')
      writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
      seedReadyVideo(db, { channel: 'chan-a' })
      vi.stubEnv('YT_CLIENT_ID', '')
      const result = await publishNextTick(db, { channelsDir, now: NOW })
      expect(result).toEqual({ action: 'noop', reason: 'no-auth' })
      db.close()
    })

    it('no-ops with reason no-auth when no oauth token row exists for the channel', async () => {
      const db = openDb(':memory:')
      const channelsDir = tmpDir('brainrot-publish-noauth-token-')
      writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
      seedReadyVideo(db, { channel: 'chan-a' })
      const result = await publishNextTick(db, { channelsDir, now: NOW })
      expect(result).toEqual({ action: 'noop', reason: 'no-auth' })
      db.close()
    })
  })

  describe('publishNextTick — candidate selection (dry-run)', () => {
    it('skips a blocked channel and previews the next eligible one', async () => {
      const db = openDb(':memory:')
      const channelsDir = tmpDir('brainrot-publish-iter-')
      writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
      writeChannel(channelsDir, { name: 'chan-b', slots: ['14:00'] })
      const jobId = seedReadyVideo(db, { channel: 'chan-b', topic: 'Chan B topic' })
      seedToken(db, 'chan-b')
      const result = await publishNextTick(db, { channelsDir, now: NOW, dryRun: true })
      expect(result).toEqual({
        action: 'dry-run',
        wouldPublish: { channel: 'chan-b', platform: 'youtube', slot: '14:00', jobId, title: 'Chan B topic' },
      })
      db.close()
    })

    it('reports the first candidate blocker when every channel is blocked', async () => {
      const db = openDb(':memory:')
      const channelsDir = tmpDir('brainrot-publish-blocked-')
      writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
      writeChannel(channelsDir, { name: 'chan-b', slots: ['14:00'] })
      seedReadyVideo(db, { channel: 'chan-b' })
      // chan-b has a video but no token; chan-a has no video at all. chan-a
      // sorts first (tied fraction, tied slot, channel ASC) so its blocker wins.
      const result = await publishNextTick(db, { channelsDir, now: NOW, dryRun: true })
      expect(result).toEqual({ action: 'dry-run', wouldPublish: null, reason: 'no-ready-video' })
      db.close()
    })

    it('picks the emptier channel over the fuller one regardless of name order', async () => {
      const db = openDb(':memory:')
      const channelsDir = tmpDir('brainrot-publish-fair-')
      writeChannel(channelsDir, { name: 'chan-a', slots: ['09:00', '14:00'] })
      writeChannel(channelsDir, { name: 'chan-b', slots: ['14:00'] })
      seedConsumedSlot(db, { channel: 'chan-a', platform: 'youtube', day: '2026-07-22', slot: '09:00' })
      seedReadyVideo(db, { channel: 'chan-a', topic: 'Chan A topic' })
      seedToken(db, 'chan-a')
      const jobB = seedReadyVideo(db, { channel: 'chan-b', topic: 'Chan B topic' })
      seedToken(db, 'chan-b')
      const result = await publishNextTick(db, { channelsDir, now: NOW, dryRun: true })
      expect(result).toEqual({
        action: 'dry-run',
        wouldPublish: { channel: 'chan-b', platform: 'youtube', slot: '14:00', jobId: jobB, title: 'Chan B topic' },
      })
      db.close()
    })
  })

  describe('publishNextTick — publish', () => {
    it('publishes the eligible video: publishes row done, library flipped, result fields set', async () => {
      const db = openDb(':memory:')
      const channelsDir = tmpDir('brainrot-publish-happy-')
      writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
      const jobId = seedReadyVideo(db, {
        channel: 'chan-a',
        metadataJson: JSON.stringify({ youtube: { title: 'Great Video', description: 'desc', hashtags: ['#space'] } }),
      })
      seedToken(db, 'chan-a')
      const target = fakeTarget(async () => ({ postId: 'yt123', url: 'https://youtube.com/shorts/yt123' }))
      const result = await publishNextTick(db, {
        channelsDir,
        now: NOW,
        target,
        fetchImpl: fakeTokenFetch(),
      })
      expect(result).toEqual({
        action: 'published',
        channel: 'chan-a',
        platform: 'youtube',
        jobId,
        slot: '14:00',
        postId: 'yt123',
        url: 'https://youtube.com/shorts/yt123',
      })
      const row = db.prepare('SELECT status, post_id, url FROM publishes WHERE job_id = ?').get(jobId) as {
        status: string
        post_id: string
        url: string
      }
      expect(row).toEqual({ status: 'done', post_id: 'yt123', url: 'https://youtube.com/shorts/yt123' })
      const lib = db.prepare('SELECT state FROM library WHERE job_id = ?').get(jobId) as { state: string }
      expect(lib.state).toBe('published')
      expect(acquireLease(db, 'publish', 'pid:probe', PUBLISH_LEASE_TTL_MS)).toBe(true)
      db.close()
    })

    it('marks a rejected upload failed, keeps the video ready, and reports publish-failed', async () => {
      const db = openDb(':memory:')
      const channelsDir = tmpDir('brainrot-publish-fail-')
      writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
      const jobId = seedReadyVideo(db, { channel: 'chan-a' })
      seedToken(db, 'chan-a')
      const { PublishError } = await import('../publish/types.js')
      const target = fakeTarget(async () => {
        throw new PublishError('upload: invalid metadata', 'rejected')
      })
      const result = await publishNextTick(db, { channelsDir, now: NOW, target, fetchImpl: fakeTokenFetch() })
      expect(result).toEqual({
        action: 'publish-failed',
        channel: 'chan-a',
        platform: 'youtube',
        jobId,
        slot: '14:00',
        error: 'upload: invalid metadata',
      })
      const row = db.prepare('SELECT status, error_kind FROM publishes WHERE job_id = ?').get(jobId) as {
        status: string
        error_kind: string
      }
      expect(row).toEqual({ status: 'failed', error_kind: 'rejected' })
      const lib = db.prepare('SELECT state FROM library WHERE job_id = ?').get(jobId) as { state: string }
      expect(lib.state).toBe('ready')
      db.close()
    })

    it('maps a non-PublishError from the adapter to error_kind transient', async () => {
      const db = openDb(':memory:')
      const channelsDir = tmpDir('brainrot-publish-transient-')
      writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
      const jobId = seedReadyVideo(db, { channel: 'chan-a' })
      seedToken(db, 'chan-a')
      const target = fakeTarget(async () => {
        throw new Error('boom')
      })
      const result = await publishNextTick(db, { channelsDir, now: NOW, target, fetchImpl: fakeTokenFetch() })
      expect(result.action).toBe('publish-failed')
      const row = db.prepare('SELECT error_kind FROM publishes WHERE job_id = ?').get(jobId) as { error_kind: string }
      expect(row.error_kind).toBe('transient')
      db.close()
    })

    it('no-ops with reason claim-conflict when a racing tick already claimed the slot', async () => {
      const db = openDb(':memory:')
      const channelsDir = tmpDir('brainrot-publish-conflict-')
      writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
      seedReadyVideo(db, { channel: 'chan-a' })
      seedToken(db, 'chan-a')
      vi.mocked(claimPublish).mockReturnValueOnce(null)
      const result = await publishNextTick(db, { channelsDir, now: NOW })
      expect(result).toEqual({ action: 'noop', reason: 'claim-conflict' })
      db.close()
    })
  })
  ```

  Run it:

  ```bash
  npx vitest run src/loop/publish-next.test.ts
  ```

  Expected failure: the whole file fails to collect with a module-resolution error (`Cannot find module './publish-next.js'`) — `src/loop/publish-next.ts` does not exist yet. None of the 13 tests run.

- [ ] **Step 5: Implement the core selection-and-execution algorithm, no lease yet (green)**

  Create `src/loop/publish-next.ts` with exactly:

  ```ts
  import type { Database } from 'better-sqlite3'
  import { loadChannelsDir } from '../config/channel.js'
  import { parseTokenKey } from '../publish/crypto.js'
  import {
    claimPublish,
    consumedSlots,
    eligibleVideo,
    markPublishDone,
    markPublishFailed,
    uploadsUsedToday,
  } from '../publish/publishes.js'
  import { dueSlotsForChannel, localDay, orderCandidates } from '../publish/slots.js'
  import type { SlotCandidate } from '../publish/slots.js'
  import { loadRefreshToken } from '../publish/tokens.js'
  import { PublishError, resolvePlatformMeta } from '../publish/types.js'
  import type { Platform, PublishTarget } from '../publish/types.js'
  import { mintAccessToken, youtubeTarget, ytUploadsPerDayCap } from '../publish/youtube.js'

  export interface PublishTickResult {
    action: 'published' | 'publish-failed' | 'noop' | 'dry-run'
    reason?: 'lease-held' | 'no-due-slot' | 'platform-quota' | 'no-ready-video' | 'no-auth' | 'claim-conflict'
    channel?: string
    platform?: Platform
    jobId?: string
    slot?: string
    postId?: string
    url?: string
    error?: string
    wouldPublish?: { channel: string; platform: Platform; slot: string; jobId: string; title: string } | null
  }

  /**
   * Selects and executes one upload: due slots -> quota gate -> fairness order
   * -> candidate scan (video then token) -> claim -> mint -> upload -> finalize.
   * The publish lease and repair sweep wrap this in the next cycle.
   */
  export async function publishNextTick(
    db: Database,
    opts: {
      channelsDir: string
      target?: PublishTarget
      fetchImpl?: typeof fetch
      now?: () => Date
      dryRun?: boolean
    },
  ): Promise<PublishTickResult> {
    const nowFn = opts.now ?? (() => new Date())
    const dryRun = opts.dryRun ?? false
    const target = opts.target ?? youtubeTarget(opts.fetchImpl)
    const now = nowFn()
    const channels = loadChannelsDir(opts.channelsDir)
    const day = localDay(now)

    const candidates: SlotCandidate[] = []
    for (const channel of channels) {
      if (channel.publish === null) continue
      for (const platform of channel.publish.platforms) {
        const consumed = consumedSlots(db, channel.name, platform, day)
        const due = dueSlotsForChannel(channel.publish, consumed, now)
        for (const slot of due) {
          candidates.push({
            channel: channel.name,
            platform,
            slot,
            filledCount: consumed.size,
            totalSlots: channel.publish.slots.length,
          })
        }
      }
    }
    if (candidates.length === 0) {
      return { action: 'noop', reason: 'no-due-slot' }
    }

    // Quota gate: YouTube quota is per Google Cloud project, counted across
    // every channel — v1's only platform, so one check covers every candidate.
    if (uploadsUsedToday(db, 'youtube', day) >= ytUploadsPerDayCap()) {
      return { action: 'noop', reason: 'platform-quota' }
    }

    const ordered = orderCandidates(candidates)
    const clientId = process.env.YT_CLIENT_ID
    const clientSecret = process.env.YT_CLIENT_SECRET
    const tokenKeyHex = process.env.BRAINROT_TOKEN_KEY
    const tokenKey = tokenKeyHex ? parseTokenKey(tokenKeyHex) : undefined

    let firstReason: 'no-ready-video' | 'no-auth' | undefined
    let picked:
      | {
          candidate: SlotCandidate
          video: { jobId: string; videoPath: string; metadataJson: string; topic: string }
          refreshToken: string
          clientId: string
          clientSecret: string
        }
      | undefined

    for (const candidate of ordered) {
      const video = eligibleVideo(db, candidate.channel, candidate.platform)
      if (video === null) {
        if (firstReason === undefined) firstReason = 'no-ready-video'
        continue
      }
      // Missing client credentials or the token-encryption key blocks every
      // candidate identically — still evaluated per-candidate so a later
      // channel's own missing token row is never masked.
      if (!clientId || !clientSecret || tokenKey === undefined) {
        if (firstReason === undefined) firstReason = 'no-auth'
        continue
      }
      const refreshToken = loadRefreshToken(db, candidate.platform, candidate.channel, tokenKey)
      if (refreshToken === null) {
        if (firstReason === undefined) firstReason = 'no-auth'
        continue
      }
      picked = { candidate, video, refreshToken, clientId, clientSecret }
      break
    }

    if (picked === undefined) {
      return dryRun
        ? { action: 'dry-run', wouldPublish: null, reason: firstReason }
        : { action: 'noop', reason: firstReason }
    }

    const { candidate, video, refreshToken, clientId: cid, clientSecret: csec } = picked
    const meta = resolvePlatformMeta(video.metadataJson, candidate.platform, video.topic)

    if (dryRun) {
      return {
        action: 'dry-run',
        wouldPublish: {
          channel: candidate.channel,
          platform: candidate.platform,
          slot: candidate.slot,
          jobId: video.jobId,
          title: meta.title,
        },
      }
    }

    // The UNIQUE(channel, platform, day, slot) constraint is the real guard;
    // a conflict here means a racing tick won this slot — unreachable under
    // the publish lease, but a defensive exit rather than a crash.
    const claimId = claimPublish(db, {
      jobId: video.jobId,
      platform: candidate.platform,
      channel: candidate.channel,
      day,
      slot: candidate.slot,
    })
    if (claimId === null) {
      return { action: 'noop', reason: 'claim-conflict' }
    }

    const channel = channels.find((c) => c.name === candidate.channel)
    if (channel === undefined || channel.publish === null) {
      throw new Error(`publishNextTick: channel ${candidate.channel} missing publish config at claim time`)
    }

    try {
      const accessToken = await mintAccessToken({
        refreshToken,
        clientId: cid,
        clientSecret: csec,
        fetchImpl: opts.fetchImpl,
      })
      const uploaded = await target.upload({ videoPath: video.videoPath, meta, publish: channel.publish }, accessToken)
      markPublishDone(db, claimId, uploaded.postId, uploaded.url, now)
      return {
        action: 'published',
        channel: candidate.channel,
        platform: candidate.platform,
        jobId: video.jobId,
        slot: candidate.slot,
        postId: uploaded.postId,
        url: uploaded.url,
      }
    } catch (err) {
      // A PublishError carries its taxonomy kind; anything else escaping the
      // adapter (a bug, a thrown string) is treated as transient — the safest
      // default, since it leaves the video retryable at the next slot rather
      // than permanently retiring it via 'rejected'.
      const kind = err instanceof PublishError ? err.kind : 'transient'
      const message = err instanceof Error ? err.message : String(err)
      markPublishFailed(db, claimId, message, kind, now)
      return {
        action: 'publish-failed',
        channel: candidate.channel,
        platform: candidate.platform,
        jobId: video.jobId,
        slot: candidate.slot,
        error: message,
      }
    }
  }
  ```

  Run to green:

  ```bash
  npx vitest run src/loop/publish-next.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  13 passed (13)`.

- [ ] **Step 6: Run the full suite and commit the core algorithm**

  ```bash
  npx vitest run
  ```

  Expected: every test file passes, zero failures.

  ```bash
  git add src/loop/publish-next.ts src/loop/publish-next.test.ts
  git commit -m "feat(loop): publishNextTick — due-slot selection, quota gate, dry-run preview, and upload execution" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 7: Write the failing lease-and-sweep tests (red)**

  In `src/loop/publish-next.test.ts`, append at the end of the file:

  ```ts
  describe('publishNextTick — lease and sweep', () => {
    it('no-ops with reason lease-held while another process holds the lease', async () => {
      const db = openDb(':memory:')
      const channelsDir = tmpDir('brainrot-publish-lease-')
      // Deliberately an empty library: the lease gate must short-circuit BEFORE
      // due-slot/candidate work even runs, so this fixture stays safe (no
      // mintAccessToken/network reachable) whether or not the gate is wired yet.
      writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
      acquireLease(db, 'publish', 'pid:other', PUBLISH_LEASE_TTL_MS)
      const result = await publishNextTick(db, { channelsDir, now: NOW })
      expect(result).toEqual({ action: 'noop', reason: 'lease-held' })
      db.close()
    })

    it('releases the lease after a successful publish', async () => {
      const db = openDb(':memory:')
      const channelsDir = tmpDir('brainrot-publish-release-')
      writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
      seedReadyVideo(db, { channel: 'chan-a' })
      seedToken(db, 'chan-a')
      const target = fakeTarget(async () => ({ postId: 'yt1', url: 'https://youtube.com/shorts/yt1' }))
      await publishNextTick(db, { channelsDir, now: NOW, target, fetchImpl: fakeTokenFetch() })
      expect(acquireLease(db, 'publish', 'pid:probe', PUBLISH_LEASE_TTL_MS)).toBe(true)
      db.close()
    })

    it('releases the lease when the tick throws mid-flight', async () => {
      const db = openDb(':memory:')
      // an unparseable channel TOML makes loadChannelsDir throw inside the leased window
      const brokenDir = tmpDir('brainrot-publish-broken-')
      writeFileSync(join(brokenDir, 'broken.toml'), 'this is not toml [')
      await expect(publishNextTick(db, { channelsDir: brokenDir, now: NOW })).rejects.toThrow()
      expect(acquireLease(db, 'publish', 'pid:probe', PUBLISH_LEASE_TTL_MS)).toBe(true)
      db.close()
    })

    it('sweeps a stale claimed row to interrupted before planning the tick', async () => {
      const db = openDb(':memory:')
      const channelsDir = tmpDir('brainrot-publish-sweep-')
      writeChannel(channelsDir, { name: 'chan-a', slots: ['09:00'] })
      // Seed the stale claim RELATIVE to NOW (65 min ago > 30-min TTL) so the
      // age is identical in every timezone the suite runs in.
      db.prepare(
        "INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt, created_at) " +
          "VALUES ('stale-job', 'youtube', 'chan-a', '2026-07-22', '09:00', 'claimed', 1, ?)",
      ).run(new Date(NOW().getTime() - 65 * 60_000).toISOString())
      const result = await publishNextTick(db, { channelsDir, now: NOW })
      expect(result).toEqual({ action: 'noop', reason: 'no-due-slot' })
      const row = db.prepare("SELECT status FROM publishes WHERE job_id = 'stale-job'").get() as { status: string }
      expect(row.status).toBe('interrupted')
      db.close()
    })

    it('dry-run never acquires the lease, never sweeps, and writes nothing', async () => {
      const db = openDb(':memory:')
      const channelsDir = tmpDir('brainrot-publish-dryrun-')
      writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
      // Old enough that a real sweep WOULD flip it — proving dry-run skipped it.
      db.prepare(
        "INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt, created_at) " +
          "VALUES ('stale-job', 'youtube', 'chan-a', '2026-07-21', '09:00', 'claimed', 1, ?)",
      ).run(new Date(NOW().getTime() - 65 * 60_000).toISOString())
      const jobId = seedReadyVideo(db, { channel: 'chan-a', topic: 'Preview me' })
      seedToken(db, 'chan-a')
      const result = await publishNextTick(db, { channelsDir, now: NOW, dryRun: true })
      expect(result).toEqual({
        action: 'dry-run',
        wouldPublish: { channel: 'chan-a', platform: 'youtube', slot: '14:00', jobId, title: 'Preview me' },
      })
      // the stale row from a DIFFERENT day is untouched: sweep never ran
      const stale = db.prepare("SELECT status FROM publishes WHERE job_id = 'stale-job'").get() as { status: string }
      expect(stale.status).toBe('claimed')
      // no new row for today's slot, no lease taken
      const count = (db.prepare("SELECT COUNT(*) AS n FROM publishes WHERE day = '2026-07-22'").get() as { n: number }).n
      expect(count).toBe(0)
      const lease = db.prepare("SELECT * FROM leases WHERE name = 'publish'").get()
      expect(lease).toBeUndefined()
      db.close()
    })
  })
  ```

  Run it:

  ```bash
  npx vitest run src/loop/publish-next.test.ts
  ```

  Expected failure: 2 of the 5 new tests fail predictably — `no-ops with reason lease-held...` gets `{ action: 'noop', reason: 'no-ready-video' }` instead of `lease-held` (Step 5's implementation never consults the lease, so the empty-library fixture falls straight through to the real no-op it would otherwise have hit); `sweeps a stale claimed row...` fails at the `row.status` assertion — expected `'interrupted'` but received `'claimed'` (no `sweepInterrupted` call exists yet). The other 3 new tests (`releases the lease after a successful publish`, `releases the lease when the tick throws mid-flight`, `dry-run never acquires the lease...`) pass vacuously — no lease or sweep logic runs at all yet, so their assertions hold trivially; they exist to pin the release/sweep-skip behavior the moment the gate lands. The 13 existing tests stay green.

- [ ] **Step 8: Gate the tick behind the publish lease and repair sweep (green)**

  In `src/loop/publish-next.ts`, add below the `../publish/youtube.js` import:

  ```ts
  import { acquireLease, PUBLISH_LEASE_TTL_MS, releaseLease } from './lease.js'
  ```

  Add `sweepInterrupted` to the `../publish/publishes.js` import list:

  ```ts
  import {
    claimPublish,
    consumedSlots,
    eligibleVideo,
    markPublishDone,
    markPublishFailed,
    sweepInterrupted,
    uploadsUsedToday,
  } from '../publish/publishes.js'
  ```

  Replace the whole `publishNextTick` function body — from `const now = nowFn()` through the final closing `}` of the function — with:

  ```ts
  export async function publishNextTick(
    db: Database,
    opts: {
      channelsDir: string
      target?: PublishTarget
      fetchImpl?: typeof fetch
      now?: () => Date
      dryRun?: boolean
    },
  ): Promise<PublishTickResult> {
    const nowFn = opts.now ?? (() => new Date())
    const dryRun = opts.dryRun ?? false
    const target = opts.target ?? youtubeTarget(opts.fetchImpl)
    // A held lease is the NORMAL case while a previous firing's upload is still
    // in flight — benign no-op, exit 0 at the CLI. Dry-run never touches the
    // lease: it is a pure read-only preview, never a competing writer.
    const holder = `pid:${process.pid}`
    if (!dryRun && !acquireLease(db, 'publish', holder, PUBLISH_LEASE_TTL_MS)) {
      return { action: 'noop', reason: 'lease-held' }
    }
    try {
      const now = nowFn()
      if (!dryRun) {
        // Repair sweep (publish-analog of produce-next's topic sweep): a tick
        // that died mid-upload leaves a stale 'claimed' row — heal it to
        // 'interrupted' before planning this tick's slot.
        sweepInterrupted(db, PUBLISH_LEASE_TTL_MS, now)
      }
      const channels = loadChannelsDir(opts.channelsDir)
      const day = localDay(now)

      const candidates: SlotCandidate[] = []
      for (const channel of channels) {
        if (channel.publish === null) continue
        for (const platform of channel.publish.platforms) {
          const consumed = consumedSlots(db, channel.name, platform, day)
          const due = dueSlotsForChannel(channel.publish, consumed, now)
          for (const slot of due) {
            candidates.push({
              channel: channel.name,
              platform,
              slot,
              filledCount: consumed.size,
              totalSlots: channel.publish.slots.length,
            })
          }
        }
      }
      if (candidates.length === 0) {
        return dryRun
          ? { action: 'dry-run', wouldPublish: null, reason: 'no-due-slot' }
          : { action: 'noop', reason: 'no-due-slot' }
      }

      // Quota gate: YouTube quota is per Google Cloud project, counted across
      // every channel — v1's only platform, so one check covers every candidate.
      if (uploadsUsedToday(db, 'youtube', day) >= ytUploadsPerDayCap()) {
        return dryRun
          ? { action: 'dry-run', wouldPublish: null, reason: 'platform-quota' }
          : { action: 'noop', reason: 'platform-quota' }
      }

      const ordered = orderCandidates(candidates)
      const clientId = process.env.YT_CLIENT_ID
      const clientSecret = process.env.YT_CLIENT_SECRET
      const tokenKeyHex = process.env.BRAINROT_TOKEN_KEY
      const tokenKey = tokenKeyHex ? parseTokenKey(tokenKeyHex) : undefined

      let firstReason: 'no-ready-video' | 'no-auth' | undefined
      let picked:
        | {
            candidate: SlotCandidate
            video: { jobId: string; videoPath: string; metadataJson: string; topic: string }
            refreshToken: string
            clientId: string
            clientSecret: string
          }
        | undefined

      for (const candidate of ordered) {
        const video = eligibleVideo(db, candidate.channel, candidate.platform)
        if (video === null) {
          if (firstReason === undefined) firstReason = 'no-ready-video'
          continue
        }
        // Missing client credentials or the token-encryption key blocks every
        // candidate identically — still evaluated per-candidate so a later
        // channel's own missing token row is never masked.
        if (!clientId || !clientSecret || tokenKey === undefined) {
          if (firstReason === undefined) firstReason = 'no-auth'
          continue
        }
        const refreshToken = loadRefreshToken(db, candidate.platform, candidate.channel, tokenKey)
        if (refreshToken === null) {
          if (firstReason === undefined) firstReason = 'no-auth'
          continue
        }
        picked = { candidate, video, refreshToken, clientId, clientSecret }
        break
      }

      if (picked === undefined) {
        return dryRun
          ? { action: 'dry-run', wouldPublish: null, reason: firstReason }
          : { action: 'noop', reason: firstReason }
      }

      const { candidate, video, refreshToken, clientId: cid, clientSecret: csec } = picked
      const meta = resolvePlatformMeta(video.metadataJson, candidate.platform, video.topic)

      if (dryRun) {
        return {
          action: 'dry-run',
          wouldPublish: {
            channel: candidate.channel,
            platform: candidate.platform,
            slot: candidate.slot,
            jobId: video.jobId,
            title: meta.title,
          },
        }
      }

      // The UNIQUE(channel, platform, day, slot) constraint is the real guard;
      // a conflict here means a racing tick won this slot — unreachable under
      // the publish lease, but a defensive exit rather than a crash.
      const claimId = claimPublish(db, {
        jobId: video.jobId,
        platform: candidate.platform,
        channel: candidate.channel,
        day,
        slot: candidate.slot,
      })
      if (claimId === null) {
        return { action: 'noop', reason: 'claim-conflict' }
      }

      const channel = channels.find((c) => c.name === candidate.channel)
      if (channel === undefined || channel.publish === null) {
        throw new Error(`publishNextTick: channel ${candidate.channel} missing publish config at claim time`)
      }

      try {
        const accessToken = await mintAccessToken({
          refreshToken,
          clientId: cid,
          clientSecret: csec,
          fetchImpl: opts.fetchImpl,
        })
        const uploaded = await target.upload(
          { videoPath: video.videoPath, meta, publish: channel.publish },
          accessToken,
        )
        markPublishDone(db, claimId, uploaded.postId, uploaded.url, now)
        return {
          action: 'published',
          channel: candidate.channel,
          platform: candidate.platform,
          jobId: video.jobId,
          slot: candidate.slot,
          postId: uploaded.postId,
          url: uploaded.url,
        }
      } catch (err) {
        // A PublishError carries its taxonomy kind; anything else escaping the
        // adapter (a bug, a thrown string) is treated as transient — the
        // safest default, since it leaves the video retryable at the next slot
        // rather than permanently retiring it via 'rejected'.
        const kind = err instanceof PublishError ? err.kind : 'transient'
        const message = err instanceof Error ? err.message : String(err)
        markPublishFailed(db, claimId, message, kind, now)
        return {
          action: 'publish-failed',
          channel: candidate.channel,
          platform: candidate.platform,
          jobId: video.jobId,
          slot: candidate.slot,
          error: message,
        }
      }
    } finally {
      if (!dryRun) releaseLease(db, 'publish', holder)
    }
  }
  ```

  Run to green:

  ```bash
  npx vitest run src/loop/publish-next.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  18 passed (18)`.

- [ ] **Step 9: Run the full suite and commit the lease gate**

  ```bash
  npx vitest run
  ```

  Expected: every test file passes, zero failures.

  ```bash
  git add src/loop/publish-next.ts src/loop/publish-next.test.ts
  git commit -m "feat(loop): serialize publish ticks behind the publish lease and repair sweep" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 10: Write the failing CLI tests (red)**

  In `src/loop/publish-next.test.ts`, add below the vitest import:

  ```ts
  import { execa } from 'execa'
  ```

  Append at the end of the file (the subprocess runs with vitest's cwd — the repo root — so `src/cli.ts` resolves, matching `src/cli.test.ts` and `produce-next.test.ts`):

  ```ts
  describe('publish-next CLI', () => {
    it('`publish-next --help` prints usage with --db/--channels-dir/--dry-run', async () => {
      const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'publish-next', '--help'], {
        reject: false,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--db')
      expect(result.stdout).toContain('--channels-dir')
      expect(result.stdout).toContain('--dry-run')
    }, 60000)

    it('`publish-next` with no due slot prints one noop JSON line and exits 0', async () => {
      const root = tmpDir('brainrot-publish-cli-')
      const channelsDir = tmpDir('brainrot-publish-cli-channels-')
      writeChannel(channelsDir, { name: 'chan-a' })
      const result = await execa(
        'pnpm',
        ['exec', 'tsx', 'src/cli.ts', 'publish-next', '--db', join(root, 'brainrot.db'), '--channels-dir', channelsDir],
        { reject: false },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim().split('\n')).toHaveLength(1)
      expect(JSON.parse(result.stdout)).toEqual({ action: 'noop', reason: 'no-due-slot' })
    }, 60000)

    it('`publish-next --dry-run` with no due slot prints one dry-run JSON line and exits 0', async () => {
      const root = tmpDir('brainrot-publish-cli-dry-')
      const channelsDir = tmpDir('brainrot-publish-cli-dry-channels-')
      writeChannel(channelsDir, { name: 'chan-a' })
      const result = await execa(
        'pnpm',
        [
          'exec', 'tsx', 'src/cli.ts', 'publish-next',
          '--db', join(root, 'brainrot.db'), '--channels-dir', channelsDir, '--dry-run',
        ],
        { reject: false },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim().split('\n')).toHaveLength(1)
      expect(JSON.parse(result.stdout)).toEqual({ action: 'dry-run', wouldPublish: null, reason: 'no-due-slot' })
    }, 60000)
  })
  ```

  Run it:

  ```bash
  npx vitest run src/loop/publish-next.test.ts
  ```

  Expected failure: all 3 new tests fail at their first assertion with `expected 1 to be +0` — commander exits 1 and prints `error: unknown command 'publish-next'` on stderr because the command is not wired yet. The 18 existing tests stay green.

- [ ] **Step 11: Wire the `publish-next` CLI command (green)**

  In `src/cli.ts`, add to the local-import group at the top, after the `import { produceNextTick } from './loop/produce-next.js'` line:

  ```ts
  import { publishNextTick } from './loop/publish-next.js'
  ```

  Add the command block immediately before the comment beginning `// Operator gate over the scouted topic queue.` (registration order only affects `--help` listing):

  ```ts
  program
    .command('publish-next')
    .option('--db <path>', 'sqlite db path')
    .option('--channels-dir <dir>', 'channel TOML directory', 'channels')
    .option('--dry-run', 'preview the next publish without writing anything')
    .action(async (opts: { db?: string; channelsDir: string; dryRun?: boolean }) => {
      const db = openDb(resolveDbPath(opts.db))
      try {
        const result = await publishNextTick(db, { channelsDir: opts.channelsDir, dryRun: opts.dryRun })
        // One cron-greppable JSON line. Exit 1 only for a completed-but-failed
        // upload attempt (the video stays 'ready' for the next slot); every
        // noop and dry-run preview is a benign exit 0.
        process.stdout.write(JSON.stringify(result) + '\n')
        process.exitCode = result.action === 'publish-failed' ? 1 : 0
      } finally {
        db.close()
      }
    })
  ```

  Run to green:

  ```bash
  npx vitest run src/loop/publish-next.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  21 passed (21)` (the three subprocess tests take a few seconds each for tsx startup).

- [ ] **Step 12: Run the whole suite and the type gate**

  ```bash
  npx vitest run
  ```

  Expected: every test file passes (the pre-existing suite plus `src/loop/publish-next.test.ts`; contract tests stay excluded unless `CONTRACT=1`), zero failures.

  ```bash
  npx tsc --noEmit
  ```

  Expected: no output, exit code 0.

- [ ] **Step 13: Final commit**

  ```bash
  git add src/cli.ts src/loop/publish-next.test.ts
  git commit -m "feat: add brainrot publish-next CLI command" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 11: Library DAO + library CLI

**Files:**
- Create: `src/jobs/library.ts`
- Modify: `src/cli.ts`
- Test: `src/jobs/library.test.ts`

**Interfaces:**

Consumes (exact signatures from existing code — Task 1's schema is already on `main`):

```ts
// src/db/index.ts (existing)
export function openDb(dbPath: string): Database

// src/jobs/types.ts (existing)
export type Tier = 'volume' | 'premium'

// src/db/schema.sql (existing — library only carries state; channel/tier/topic live on jobs)
// CREATE TABLE jobs (
//   id TEXT PRIMARY KEY, channel TEXT NOT NULL, tier TEXT NOT NULL CHECK (tier IN ('volume','premium')),
//   topic TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued'
//     CHECK (status IN ('queued','running','failed','done','blocked')),
//   created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), finished_at TEXT
// );
// CREATE TABLE library (
//   job_id TEXT PRIMARY KEY REFERENCES jobs(id), video_path TEXT NOT NULL, metadata_json TEXT NOT NULL,
//   state TEXT NOT NULL CHECK (state IN ('ready','needs-review','published','blocked')),
//   created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
// );

// src/cli.ts (existing module-private helper, reused as-is, not re-exported)
function resolveDbPath(flagDb?: string): string   // flag ?? BRAINROT_DB ?? 'data/brainrot.db'
// src/scout/topics.ts / the topics command group in src/cli.ts is the house idiom this
// task copies verbatim: id validation before the db opens, `<verb>ed N of M` console.log,
// a `const <group> = program.command('<name>')` command-group shape, no db.close() on
// these synchronous list/approve/reject actions.
```

Produces (exact signatures — no later task in this plan imports these programmatically; `library` is an operator-facing CLI group):

```ts
// src/jobs/library.ts
export type LibraryState = 'ready' | 'needs-review' | 'published' | 'blocked'
export interface LibraryRow {
  jobId: string; channel: string; tier: Tier; topic: string
  videoPath: string; state: LibraryState; createdAt: string
}
export function listLibrary(db: Database, filter?: { state?: LibraryState; channel?: string }): LibraryRow[]
export function approveLibrary(db: Database, jobIds: string[]): number   // needs-review → ready only
export function rejectLibrary(db: Database, jobIds: string[]): number    // needs-review OR ready → blocked

// src/cli.ts
export function parseLibraryJobIds(raw: string[]): string[]
// CLI: brainrot library list    [--db <path>] [--state <s>] [--channel <c>]
//      brainrot library approve <jobIds...> [--db <path>]
//      brainrot library reject  <jobIds...> [--db <path>]
```

Context you will see in `src/cli.ts` when you start: Tasks 9 (`auth youtube` command) and 10 (`publish-next` command, plus new imports from `src/publish/` and `src/loop/lease.js`) have already landed in this file — same-file tasks never run concurrently, but they do run before this one. None of that changes this task's anchors: the `parseTopicIds` function, the exact line `import type { Tier } from './jobs/types.js'`, and the `topics` command group's `reject <ids...>` block are all still present verbatim, wherever else in the file Tasks 9/10 added their own imports/commands. Insert relative to the anchors quoted below, not relative to line numbers. All commands run from the repo root `/Users/alex/code/project-brainrot`.

- [ ] **Step 1: Write the failing `listLibrary` tests (red)**

  Create `src/jobs/library.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest'
  import type { Database } from 'better-sqlite3'
  import { openDb } from '../db/index.js'
  import { listLibrary } from './library.js'
  import type { LibraryState } from './library.js'

  // Raw-insert seed: the DAO only ever writes library.state, so tests control
  // every other column — the owning jobs row included — directly.
  let seq = 0

  function seedJob(
    db: Database,
    overrides: Partial<{ id: string; channel: string; tier: string; topic: string }> = {},
  ): string {
    seq += 1
    const row = {
      id: `job-${seq}`,
      channel: 'chan-a',
      tier: 'volume',
      topic: `Topic ${seq}`,
      ...overrides,
    }
    db.prepare('INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, ?, ?, ?, ?)').run(
      row.id,
      row.channel,
      row.tier,
      row.topic,
      'done',
    )
    return row.id
  }

  function seedLibrary(
    db: Database,
    jobId: string,
    overrides: Partial<{
      videoPath: string
      metadataJson: string
      state: LibraryState
      createdAt: string
    }> = {},
  ): void {
    const row = {
      videoPath: `runs/${jobId}/final.mp4`,
      metadataJson: '{}',
      state: 'needs-review' as LibraryState,
      createdAt: '2026-07-20T00:00:00.000Z',
      ...overrides,
    }
    db.prepare(
      'INSERT INTO library (job_id, video_path, metadata_json, state, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(jobId, row.videoPath, row.metadataJson, row.state, row.createdAt)
  }

  describe('listLibrary', () => {
    it('joins jobs for channel/tier/topic and returns newest created_at first', () => {
      const db = openDb(':memory:')
      seedLibrary(db, seedJob(db, { id: 'j-old', topic: 'old topic' }), {
        createdAt: '2026-07-19T00:00:00.000Z',
      })
      seedLibrary(
        db,
        seedJob(db, { id: 'j-new', channel: 'chan-b', tier: 'premium', topic: 'deep sea trivia' }),
        { videoPath: 'runs/j-new/final.mp4', state: 'ready', createdAt: '2026-07-20T00:00:00.000Z' },
      )
      const rows = listLibrary(db)
      expect(rows.map((r) => r.jobId)).toEqual(['j-new', 'j-old'])
      expect(rows[0]).toEqual({
        jobId: 'j-new',
        channel: 'chan-b',
        tier: 'premium',
        topic: 'deep sea trivia',
        videoPath: 'runs/j-new/final.mp4',
        state: 'ready',
        createdAt: '2026-07-20T00:00:00.000Z',
      })
      db.close()
    })

    it('filters by state and channel independently', () => {
      const db = openDb(':memory:')
      seedLibrary(db, seedJob(db, { channel: 'chan-a' }), { state: 'ready' })
      seedLibrary(db, seedJob(db, { channel: 'chan-a' }), { state: 'blocked' })
      seedLibrary(db, seedJob(db, { channel: 'chan-b' }), { state: 'ready' })
      expect(listLibrary(db, { channel: 'chan-a' })).toHaveLength(2)
      expect(listLibrary(db, { state: 'ready' })).toHaveLength(2)
      expect(listLibrary(db, { channel: 'chan-a', state: 'ready' })).toHaveLength(1)
      expect(listLibrary(db, { channel: 'chan-b', state: 'blocked' })).toEqual([])
      db.close()
    })
  })
  ```

- [ ] **Step 2: Run, observe the failure**

  ```bash
  npx vitest run src/jobs/library.test.ts
  ```

  Expected failure: the whole file fails at import time (0 tests run): `Error: Cannot find module './library.js' imported from /Users/alex/code/project-brainrot/src/jobs/library.test.ts` — `src/jobs/library.ts` does not exist yet.

- [ ] **Step 3: Create `src/jobs/library.ts` with the types and `listLibrary`**

  ```ts
  import type { Database } from 'better-sqlite3'
  import type { Tier } from './types.js'

  export type LibraryState = 'ready' | 'needs-review' | 'published' | 'blocked'

  export interface LibraryRow {
    jobId: string
    channel: string
    tier: Tier
    topic: string
    videoPath: string
    state: LibraryState
    createdAt: string
  }

  // library only carries job_id/video_path/metadata_json/state/created_at;
  // channel/tier/topic live on the owning job row, hence the JOIN.
  const LIBRARY_COLUMNS =
    'library.job_id AS job_id, jobs.channel AS channel, jobs.tier AS tier, jobs.topic AS topic, ' +
    'library.video_path AS video_path, library.state AS state, library.created_at AS created_at'

  interface DbLibraryRow {
    job_id: string
    channel: string
    tier: Tier
    topic: string
    video_path: string
    state: LibraryState
    created_at: string
  }

  function toLibraryRow(row: DbLibraryRow): LibraryRow {
    return {
      jobId: row.job_id,
      channel: row.channel,
      tier: row.tier,
      topic: row.topic,
      videoPath: row.video_path,
      state: row.state,
      createdAt: row.created_at,
    }
  }

  export function listLibrary(
    db: Database,
    filter?: { state?: LibraryState; channel?: string },
  ): LibraryRow[] {
    const where: string[] = []
    const params: string[] = []
    if (filter?.state !== undefined) {
      where.push('library.state = ?')
      params.push(filter.state)
    }
    if (filter?.channel !== undefined) {
      where.push('jobs.channel = ?')
      params.push(filter.channel)
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
    const rows = db
      .prepare(
        `SELECT ${LIBRARY_COLUMNS} FROM library JOIN jobs ON library.job_id = jobs.id${clause} ` +
          'ORDER BY created_at DESC',
      )
      .all(...params) as DbLibraryRow[]
    return rows.map(toLibraryRow)
  }
  ```

  (`ORDER BY created_at DESC` is unqualified per the binding contract; SQLite resolves it against the single `created_at` alias in the SELECT list — `jobs.created_at` is never selected, so there is no ambiguity.)

- [ ] **Step 4: Run to green**

  ```bash
  npx vitest run src/jobs/library.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  2 passed (2)`.

- [ ] **Step 5: Write the failing `approveLibrary` tests (red)**

  Extend the import line in `src/jobs/library.test.ts`:

  ```ts
  import { approveLibrary, listLibrary } from './library.js'
  ```

  Append:

  ```ts
  describe('approveLibrary', () => {
    it('flips needs-review rows to ready and reports the changed count; other ids are skipped', () => {
      const db = openDb(':memory:')
      const a = seedJob(db, { id: 'a' }) // needs-review
      seedLibrary(db, a, { state: 'needs-review' })
      const b = seedJob(db, { id: 'b' })
      seedLibrary(db, b, { state: 'ready' })
      const c = seedJob(db, { id: 'c' }) // needs-review
      seedLibrary(db, c, { state: 'needs-review' })

      // b is not needs-review and 'no-such-job' does not exist: both silently skipped
      expect(approveLibrary(db, [a, b, c, 'no-such-job'])).toBe(2)
      const states = db.prepare('SELECT job_id, state FROM library ORDER BY job_id').all() as {
        job_id: string
        state: string
      }[]
      expect(states).toEqual([
        { job_id: 'a', state: 'ready' },
        { job_id: 'b', state: 'ready' },
        { job_id: 'c', state: 'ready' },
      ])
      db.close()
    })

    it('returns 0 when no id is in needs-review state (or the batch is empty)', () => {
      const db = openDb(':memory:')
      const ready = seedJob(db, { id: 'ready-job' })
      seedLibrary(db, ready, { state: 'ready' })
      const blocked = seedJob(db, { id: 'blocked-job' })
      seedLibrary(db, blocked, { state: 'blocked' })
      const published = seedJob(db, { id: 'published-job' })
      seedLibrary(db, published, { state: 'published' })

      expect(approveLibrary(db, ['ready-job', 'blocked-job', 'published-job'])).toBe(0)
      expect(approveLibrary(db, [])).toBe(0)
      db.close()
    })
  })
  ```

- [ ] **Step 6: Run, observe the failure**

  ```bash
  npx vitest run src/jobs/library.test.ts
  ```

  Expected failure: the 2 new tests fail with `TypeError: approveLibrary is not a function` (missing named export resolves to `undefined` at runtime, not an import-time error — `library.ts` already exists after Step 3). The 2 `listLibrary` tests stay green: `Tests  2 failed | 2 passed (4)`.

- [ ] **Step 7: Implement `approveLibrary`**

  Append to `src/jobs/library.ts`:

  ```ts
  // Publish gate (design spec decision 4): only needs-review rows can be
  // promoted into the publish pool, and only into 'ready'. The status guard
  // makes this idempotent and blind to ids in the wrong state — the returned
  // count is what actually changed, which the CLI reports against jobIds.length.
  export function approveLibrary(db: Database, jobIds: string[]): number {
    if (jobIds.length === 0) return 0
    const placeholders = jobIds.map(() => '?').join(', ')
    return db
      .prepare(
        `UPDATE library SET state = 'ready' WHERE job_id IN (${placeholders}) AND state = 'needs-review'`,
      )
      .run(...jobIds).changes
  }
  ```

- [ ] **Step 8: Run to green**

  ```bash
  npx vitest run src/jobs/library.test.ts
  ```

  Expected: `Tests  4 passed (4)`.

- [ ] **Step 9: Write the failing `rejectLibrary` test (red)**

  Extend the import line:

  ```ts
  import { approveLibrary, listLibrary, rejectLibrary } from './library.js'
  ```

  Append:

  ```ts
  describe('rejectLibrary', () => {
    it('flips needs-review and ready rows to blocked; published and unknown ids are skipped', () => {
      const db = openDb(':memory:')
      const a = seedJob(db, { id: 'a' })
      seedLibrary(db, a, { state: 'needs-review' })
      const b = seedJob(db, { id: 'b' })
      seedLibrary(db, b, { state: 'ready' })
      const c = seedJob(db, { id: 'c' })
      seedLibrary(db, c, { state: 'published' })

      // c is published (immutable history) and 'no-such-job' does not exist: both skipped
      expect(rejectLibrary(db, [a, b, c, 'no-such-job'])).toBe(2)
      const states = db.prepare('SELECT job_id, state FROM library ORDER BY job_id').all() as {
        job_id: string
        state: string
      }[]
      expect(states).toEqual([
        { job_id: 'a', state: 'blocked' },
        { job_id: 'b', state: 'blocked' },
        { job_id: 'c', state: 'published' },
      ])
      expect(rejectLibrary(db, [])).toBe(0)
      db.close()
    })
  })
  ```

- [ ] **Step 10: Run, observe the failure**

  ```bash
  npx vitest run src/jobs/library.test.ts
  ```

  Expected failure: the 1 new test fails with `TypeError: rejectLibrary is not a function`. The 4 existing tests stay green: `Tests  1 failed | 4 passed (5)`.

- [ ] **Step 11: Implement `rejectLibrary`**

  Append to `src/jobs/library.ts`:

  ```ts
  // Reject retires a row from both waiting states: needs-review (never
  // promoted) or ready (pulled from the pool / an attempt-capped video).
  // published rows are immutable history and never match.
  export function rejectLibrary(db: Database, jobIds: string[]): number {
    if (jobIds.length === 0) return 0
    const placeholders = jobIds.map(() => '?').join(', ')
    return db
      .prepare(
        `UPDATE library SET state = 'blocked' WHERE job_id IN (${placeholders}) AND state IN ('needs-review', 'ready')`,
      )
      .run(...jobIds).changes
  }
  ```

- [ ] **Step 12: Run to green**

  ```bash
  npx vitest run src/jobs/library.test.ts
  ```

  Expected: `Tests  5 passed (5)`.

- [ ] **Step 13: Write the failing `parseLibraryJobIds` tests (red)**

  Add a new import line to `src/jobs/library.test.ts`, after the `openDb` import:

  ```ts
  import { parseLibraryJobIds } from '../cli.js'
  ```

  Append:

  ```ts
  describe('parseLibraryJobIds (in-process)', () => {
    it('passes non-empty tokens through unchanged, in order', () => {
      expect(parseLibraryJobIds(['V1StGXR8', 'abc123_-Z'])).toEqual(['V1StGXR8', 'abc123_-Z'])
      // commander's <jobIds...> guarantees at least one token, but the helper
      // itself is total: an empty list is an empty result, not an error.
      expect(parseLibraryJobIds([])).toEqual([])
    })

    it('throws naming the first empty/whitespace-only token', () => {
      expect(() => parseLibraryJobIds([''])).toThrow(
        'invalid job id "": ids must not be empty or whitespace',
      )
      expect(() => parseLibraryJobIds(['   '])).toThrow('invalid job id "   "')
      // the FIRST offender is the one named, even when later tokens are also bad
      expect(() => parseLibraryJobIds(['j1', '', 'j2'])).toThrow('invalid job id ""')
    })
  })
  ```

- [ ] **Step 14: Run, observe the failure**

  ```bash
  npx vitest run src/jobs/library.test.ts
  ```

  Expected failure: `cli.ts` exists (Tasks 9/10 already touched it), so the import resolves — esbuild silently binds the missing named export to `undefined`; the failure surfaces only when the tests call it. The first test hits the raw `TypeError: parseLibraryJobIds is not a function` on its first line; the second test's three `toThrow(...)` assertions each catch that same TypeError inside the matcher and report an assertion mismatch naming the TypeError message instead of the expected `invalid job id` text. Both are the same red. The 5 existing tests stay green: `Tests  2 failed | 5 passed (7)`.

- [ ] **Step 15: Implement `parseLibraryJobIds`**

  In `src/cli.ts`, insert immediately after the closing `}` of `parseTopicIds`, before the `// Moved to src/jobs/pipeline.ts` comment — i.e. this existing block:

  ```ts
  export function parseTopicIds(raw: string[]): number[] {
    return raw.map((token) => {
      if (!/^[1-9]\d*$/.test(token)) {
        throw new Error(`invalid topic id "${token}": ids must be positive integers`)
      }
      return Number(token)
    })
  }

  // Moved to src/jobs/pipeline.ts so the loop code (resume, produce-next) shares
  ```

  becomes:

  ```ts
  export function parseTopicIds(raw: string[]): number[] {
    return raw.map((token) => {
      if (!/^[1-9]\d*$/.test(token)) {
        throw new Error(`invalid topic id "${token}": ids must be positive integers`)
      }
      return Number(token)
    })
  }

  /**
   * Validate `library approve/reject` id arguments. jobIds are nanoid strings
   * (unlike topic ids, no numeric parsing) — the only invalid token is
   * empty/whitespace-only. Throws naming the FIRST bad token, BEFORE any db
   * handle exists, so one typo means exit 1 with no writes. Exported so
   * library.test.ts can assert it in-process.
   */
  export function parseLibraryJobIds(raw: string[]): string[] {
    return raw.map((token) => {
      if (/^\s*$/.test(token)) {
        throw new Error(`invalid job id "${token}": ids must not be empty or whitespace`)
      }
      return token
    })
  }

  // Moved to src/jobs/pipeline.ts so the loop code (resume, produce-next) shares
  ```

- [ ] **Step 16: Run to green**

  ```bash
  npx vitest run src/jobs/library.test.ts
  ```

  Expected: `Tests  7 passed (7)`.

- [ ] **Step 17: Write the failing `library --help` registration test (red)**

  Add a new import line to `src/jobs/library.test.ts`, immediately after the `vitest` import:

  ```ts
  import { execa } from 'execa'
  ```

  Append:

  ```ts
  describe('library CLI', () => {
    it('`library --help` lists the list/approve/reject subcommands', async () => {
      const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'library', '--help'], {
        reject: false,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('list')
      expect(result.stdout).toContain('approve')
      expect(result.stdout).toContain('reject')
    }, 60000)
  })
  ```

- [ ] **Step 18: Run, observe the failure**

  ```bash
  npx vitest run src/jobs/library.test.ts
  ```

  Expected failure: the new test's `expect(result.exitCode).toBe(0)` fails with `AssertionError: expected 1 to be 0` — the subprocess exits 1 and commander prints `error: unknown command 'library'` on stderr, because no `library` command is registered yet. The 7 existing tests stay green: `Tests  1 failed | 7 passed (8)`.

- [ ] **Step 19: Wire the `library` CLI command group (green)**

  In `src/cli.ts`, add two import lines immediately after the existing `import type { Tier } from './jobs/types.js'` line:

  ```ts
  import { approveLibrary, listLibrary, rejectLibrary } from './jobs/library.js'
  import type { LibraryState } from './jobs/library.js'
  ```

  Add the command group immediately after this existing block — the `topics` group's `reject <ids...>` command (whatever command Tasks 9/10 registered elsewhere in the file is unaffected by this anchor):

  ```ts
  topics
    .command('reject <ids...>')
    .option('--db <path>', 'sqlite db path')
    .action((rawIds: string[], opts: { db?: string }) => {
      const ids = parseTopicIds(rawIds)
      const db = openDb(resolveDbPath(opts.db))
      const changed = rejectTopics(db, ids)
      // reject takes candidate AND approved; claimed/used rows are skipped.
      console.log(`rejected ${changed} of ${ids.length}`)
    })
  ```

  insert, directly after it:

  ```ts
  // Operator gate over the produced-video library. Actions are thin: id
  // validation lives in parseLibraryJobIds, state transitions in the library DAO.
  const library = program.command('library')

  library
    .command('list')
    .option('--db <path>', 'sqlite db path')
    .option('--state <state>', 'filter by library state')
    .option('--channel <name>', 'filter by channel')
    .action((opts: { db?: string; state?: string; channel?: string }) => {
      const db = openDb(resolveDbPath(opts.db))
      // An unknown --state matches no rows (the DAO filters verbatim), so the
      // operator sees an empty table rather than an error.
      const rows = listLibrary(db, {
        state: opts.state as LibraryState | undefined,
        channel: opts.channel,
      })
      console.table(
        rows.map((r) => ({
          jobId: r.jobId,
          channel: r.channel,
          tier: r.tier,
          state: r.state,
          topic: r.topic,
          createdAt: r.createdAt,
        })),
      )
    })

  library
    .command('approve <jobIds...>')
    .option('--db <path>', 'sqlite db path')
    .action((rawIds: string[], opts: { db?: string }) => {
      // jobIds parse BEFORE the db opens: an empty/whitespace token throws to
      // the parseAsync .catch (message on stderr, exit 1) with no writes.
      const jobIds = parseLibraryJobIds(rawIds)
      const db = openDb(resolveDbPath(opts.db))
      const changed = approveLibrary(db, jobIds)
      // changed < jobIds.length flags ids that were not in 'needs-review' state.
      console.log(`approved ${changed} of ${jobIds.length}`)
    })

  library
    .command('reject <jobIds...>')
    .option('--db <path>', 'sqlite db path')
    .action((rawIds: string[], opts: { db?: string }) => {
      const jobIds = parseLibraryJobIds(rawIds)
      const db = openDb(resolveDbPath(opts.db))
      const changed = rejectLibrary(db, jobIds)
      // reject takes needs-review AND ready; published rows are skipped.
      console.log(`rejected ${changed} of ${jobIds.length}`)
    })
  ```

- [ ] **Step 20: Run to green**

  ```bash
  npx vitest run src/jobs/library.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  8 passed (8)`.

- [ ] **Step 21: Run the full suite**

  ```bash
  npm test
  ```

  Expected: every test file passes, 0 failures (contract tests stay excluded unless `CONTRACT=1`, per `vitest.config.ts`).

- [ ] **Step 22: Typecheck**

  ```bash
  npx tsc --noEmit
  ```

  Expected: no output, exit code 0.

- [ ] **Step 23: Final commit**

  ```bash
  git add src/jobs/library.ts src/jobs/library.test.ts src/cli.ts
  git commit -m "feat: add library DAO and library review CLI commands" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 12: Publish manual CLI (retry, mark-done, publishes list)

**Files:**
- Create: (none — no new module; wiring lives in `src/cli.ts` per contract)
- Modify: `src/cli.ts`, `src/cli.test.ts`
- Test: `src/cli.test.ts` — no DAO gap: `retryInterrupted`, `markInterruptedDone`, and `listPublishes` (Task 7, `src/publish/publishes.ts`) already cover everything this CLI needs one-to-one, so `src/publish/publishes.ts` / `src/publish/publishes.test.ts` are untouched by this task.

**Interfaces:**

Consumes (exact signatures from Task 7 — `src/publish/publishes.ts`, already on disk when this task starts):

```ts
export type PublishStatus = 'claimed' | 'done' | 'failed' | 'interrupted'
export interface PublishRow {
  id: number; jobId: string; platform: Platform; channel: string
  day: string; slot: string; status: PublishStatus
  postId: string | null; url: string | null; error: string | null
  errorKind: PublishErrorKind | null; attempt: number
  createdAt: string; finishedAt: string | null
}
// interrupted → failed, error_kind 'transient', error += '; manually cleared'. False if job has no interrupted row.
export function retryInterrupted(db: Database, jobId: string): boolean
// interrupted → done with postId/url AND library → 'published', one transaction. False if no interrupted row.
export function markInterruptedDone(db: Database, jobId: string, postId: string, url: string, now: Date): boolean
export function listPublishes(db: Database, opts?: { sinceDays?: number }): PublishRow[]   // default 7 (UTC created_at window)

// Existing — src/db/index.ts
export function openDb(dbPath: string): Database

// Existing module-private helper in src/cli.ts (reused as-is, not exported)
function resolveDbPath(flagDb?: string): string   // flag → BRAINROT_DB → 'data/brainrot.db'
```

Produces (operator-facing; Task 14's README documents these commands — no later task imports them programmatically):

```ts
// src/cli.ts
export function parsePublishDays(raw: string): number
// throws Error naming the value unless it is a positive decimal integer;
// "0", "-3", "3.5", "abc" all rejected

// CLI (nested commander subcommands):
//   brainrot publish retry <jobId> [--db <path>]
//     → retryInterrupted(); false → stderr `no interrupted publish for job <id>`, exit 1;
//       true → stdout confirmation line, exit 0
//   brainrot publish mark-done <jobId> <postId> [--db <path>]
//     → url = 'https://youtube.com/shorts/' + postId (v1: PUBLISH_PLATFORMS is exactly
//       ['youtube'], so every interrupted row is a YouTube upload — see the code comment);
//       markInterruptedDone(); same false/true handling as retry
//   brainrot publishes list [--days <n>] [--db <path>]  (--days default '7', validated by
//     parsePublishDays BEFORE the db opens, mirroring parseTier/parseTopicIds)
//     → one line per row: `${day} ${slot} ${channel} ${platform} ${status} attempt ${attempt} ${jobId} ${url-or-error}`;
//       empty result → `no publishes in the last ${days} days`
```

Context you will see in `src/cli.ts` when you start: Tasks 9/10/11 have already touched this file (an `auth youtube` command, a `publish-next` command, and a `library` command group with `list`/`approve`/`reject`). None of that changes this task's anchors: the `openDb` import (`import { openDb } from './db/index.js'`), the `resolveDbPath` helper, the `parseTier`/`parseTopicIds` functions, the `topics` command-group pattern, and the `isMain` guard at the bottom of the file are all still present exactly as shown above. `src/cli.test.ts` still has its `describe('brainrot CLI', () => { ... })` block (execa subprocess tests) and its trailing in-process `describe` blocks (`parseTopicIds (in-process)` is currently last, but Tasks 9–11 may have appended their own blocks after it).

Run every command from the repo root `/Users/alex/code/project-brainrot`.

- [ ] **Step 1: Write the failing `parsePublishDays` tests (red)**

  In `src/cli.test.ts`, add `parsePublishDays` to the existing in-process import from `./cli.js`, inserted alphabetically (it lands between `assertPremiumPreflight` and `parseTier`):

  ```ts
  import { assertPremiumPreflight, parsePublishDays, parseTier, parseTopicIds, stagesForTier } from './cli.js'
  ```

  Append a new top-level describe block at the very end of the file (after whatever is currently the last block):

  ```ts
  describe('parsePublishDays (in-process)', () => {
    it('parses a positive integer string', () => {
      expect(parsePublishDays('7')).toBe(7)
      expect(parsePublishDays('1')).toBe(1)
      expect(parsePublishDays('30')).toBe(30)
    })

    it('throws naming the value; "0", "-3", "3.5", "abc" all reject', () => {
      expect(() => parsePublishDays('0')).toThrow('invalid --days "0": must be a positive integer')
      expect(() => parsePublishDays('-3')).toThrow('invalid --days "-3"')
      expect(() => parsePublishDays('3.5')).toThrow('invalid --days "3.5"')
      expect(() => parsePublishDays('abc')).toThrow('invalid --days "abc"')
    })
  })
  ```

- [ ] **Step 2: Run, observe the failure**

  ```bash
  npx vitest run src/cli.test.ts
  ```

  Expected failure: both new tests fail because `parsePublishDays` is not exported from `cli.ts` yet — tsx/esbuild resolves the import (the module file exists) but binds the missing named export to `undefined`, so the failure surfaces only when a test calls it. The first test throws `TypeError: parsePublishDays is not a function` directly. The second test's `toThrow('invalid --days "0"...')` calls also throw that same TypeError — `toThrow` catches it (something was thrown) but reports an assertion mismatch, since the actual message ("parsePublishDays is not a function") does not contain the expected "invalid --days" text. Every pre-existing test in the file stays green.

- [ ] **Step 3: Implement `parsePublishDays` (green)**

  In `src/cli.ts`, add this function immediately after the ID-parsing helpers — `parseTopicIds` and the `parseLibraryJobIds` that Task 11 added below it — still before the `// Moved to src/jobs/pipeline.ts ...` re-export line:

  ```ts
  /**
   * Validate `publishes list --days` values. Same shape as parseTopicIds's
   * tokens — positive decimal integers only ("0", "-3", "3.5", "abc" all
   * reject) — but for a single flag value rather than a list of ids. Throws
   * BEFORE any db handle exists, so a bad value means exit 1 with no query.
   * Exported so cli.test.ts can assert it in-process.
   */
  export function parsePublishDays(raw: string): number {
    if (!/^[1-9]\d*$/.test(raw)) {
      throw new Error(`invalid --days "${raw}": must be a positive integer`)
    }
    return Number(raw)
  }
  ```

- [ ] **Step 4: Run to green**

  ```bash
  npx vitest run src/cli.test.ts
  ```

  Expected: `Test Files  1 passed (1)` with 0 failures (the exact test count depends on how many tests Tasks 9–11 added; the gate is 0 failures, not a specific number).

- [ ] **Step 5: Write the failing `publish retry`/`publish mark-done` tests (red)**

  In `src/cli.test.ts`, inside the `describe('brainrot CLI', () => { ... })` block, add this seeding helper (a good spot is right after the existing `countJobs` helper) — it inserts a fully-formed `publishes` row plus its parent `jobs`/`library` rows directly via SQL, since this task only exercises the CLI's thin glue over the Task 7 DAO, not the claim/sweep machinery that normally produces `interrupted` rows:

  ```ts
    function seedPublishRow(
      dbPath: string,
      opts: {
        jobId: string
        channel: string
        day: string
        slot: string
        status: string
        postId?: string | null
        url?: string | null
        error?: string | null
        errorKind?: string | null
        attempt?: number
      },
    ): void {
      const db = openDb(dbPath)
      db.prepare(
        "INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, ?, 'volume', 'test topic', 'done')",
      ).run(opts.jobId, opts.channel)
      db.prepare(
        "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, '/tmp/video.mp4', '{}', 'ready')",
      ).run(opts.jobId)
      db.prepare(
        `INSERT INTO publishes (job_id, platform, channel, day, slot, status, post_id, url, error, error_kind, attempt)
         VALUES (?, 'youtube', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        opts.jobId,
        opts.channel,
        opts.day,
        opts.slot,
        opts.status,
        opts.postId ?? null,
        opts.url ?? null,
        opts.error ?? null,
        opts.errorKind ?? null,
        opts.attempt ?? 1,
      )
      db.close()
    }
  ```

  Then append these five tests at the end of the `describe('brainrot CLI', ...)` block, after its last existing test:

  ```ts
    it('`publish --help` lists the retry/mark-done subcommands', async () => {
      const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'publish', '--help'], {
        reject: false,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('retry')
      expect(result.stdout).toContain('mark-done')
    }, 60000)

    it('`publish retry` on a job with no interrupted publish exits 1 naming the job', async () => {
      const dbPath = tmpDbPath()
      const result = await execa(
        'pnpm',
        ['exec', 'tsx', 'src/cli.ts', 'publish', 'retry', 'no-such-job', '--db', dbPath],
        { reject: false },
      )
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('no interrupted publish for job no-such-job')
    }, 60000)

    it('`publish retry` on a job with an interrupted publish clears it and returns the job to the pool', async () => {
      const dbPath = tmpDbPath()
      seedPublishRow(dbPath, {
        jobId: 'job-retry-1', channel: 'demo', day: '2026-07-22', slot: '10:00', status: 'interrupted',
      })
      const result = await execa(
        'pnpm',
        ['exec', 'tsx', 'src/cli.ts', 'publish', 'retry', 'job-retry-1', '--db', dbPath],
        { reject: false },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('job-retry-1')
      const db = openDb(dbPath)
      const row = db
        .prepare('SELECT status, error_kind, error FROM publishes WHERE job_id = ?')
        .get('job-retry-1') as { status: string; error_kind: string; error: string }
      db.close()
      expect(row.status).toBe('failed')
      expect(row.error_kind).toBe('transient')
      expect(row.error).toContain('manually cleared')
    }, 60000)

    it('`publish mark-done` on a job with no interrupted publish exits 1 naming the job', async () => {
      const dbPath = tmpDbPath()
      const result = await execa(
        'pnpm',
        ['exec', 'tsx', 'src/cli.ts', 'publish', 'mark-done', 'no-such-job', 'yt-post-1', '--db', dbPath],
        { reject: false },
      )
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('no interrupted publish for job no-such-job')
    }, 60000)

    it('`publish mark-done` on a job with an interrupted publish marks it done and flips the library row', async () => {
      const dbPath = tmpDbPath()
      seedPublishRow(dbPath, {
        jobId: 'job-done-1', channel: 'demo', day: '2026-07-22', slot: '10:00', status: 'interrupted',
      })
      const result = await execa(
        'pnpm',
        ['exec', 'tsx', 'src/cli.ts', 'publish', 'mark-done', 'job-done-1', 'yt-post-1', '--db', dbPath],
        { reject: false },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('https://youtube.com/shorts/yt-post-1')
      const db = openDb(dbPath)
      const publishRow = db
        .prepare('SELECT status, post_id, url FROM publishes WHERE job_id = ?')
        .get('job-done-1') as { status: string; post_id: string; url: string }
      const libraryRow = db
        .prepare('SELECT state FROM library WHERE job_id = ?')
        .get('job-done-1') as { state: string }
      db.close()
      expect(publishRow.status).toBe('done')
      expect(publishRow.post_id).toBe('yt-post-1')
      expect(publishRow.url).toBe('https://youtube.com/shorts/yt-post-1')
      expect(libraryRow.state).toBe('published')
    }, 60000)
  ```

- [ ] **Step 6: Run, observe the failures**

  ```bash
  npx vitest run src/cli.test.ts
  ```

  Expected failure: all 5 new tests fail because `publish` is not a registered command yet. `pnpm exec tsx src/cli.ts publish --help` falls through to commander's top-level help (exit 0, since `--help` short-circuits before the unknown-command check) — so the `--help` test's exit-code assertion passes but `expect(result.stdout).toContain('retry')` fails, because the top-level help only lists whatever commands Tasks 1–11 already registered, never a `publish` group. The other four tests invoke `publish retry`/`publish mark-done` without `--help`; commander exits 1 with `error: unknown command 'publish'` on stderr for all of them. For the two false-branch tests (no interrupted row) the exit-code assertion (`toBe(1)`) happens to already pass, but `expect(result.stderr).toContain('no interrupted publish for job ...')` fails since stderr is the unknown-command message instead. For the two true-branch tests the exit-code assertion itself fails (`expected 1 to be 0`).

- [ ] **Step 7: Wire the `publish` command group (green)**

  In `src/cli.ts`, add this import line among the existing imports near the top of the file (position among imports doesn't matter to ESM; right after `import { openDb } from './db/index.js'` is a good spot):

  ```ts
  import { markInterruptedDone, retryInterrupted } from './publish/publishes.js'
  ```

  Add this command block immediately before the `isMain` computation at the bottom of the file:

  ```ts
  // Manual repair for `interrupted` publishes (design spec decision 12):
  // publish-next's own repair sweep marks a stale claim `interrupted` — it
  // never guesses whether the upload actually landed on YouTube, so the
  // operator resolves it by hand after checking YouTube Studio. State
  // transitions live in the publishes DAO (Task 7); these actions are thin glue.
  const publish = program.command('publish')

  publish
    .command('retry <jobId>')
    .option('--db <path>', 'sqlite db path')
    .action((jobId: string, opts: { db?: string }) => {
      const db = openDb(resolveDbPath(opts.db))
      try {
        const ok = retryInterrupted(db, jobId)
        if (!ok) {
          console.error(`no interrupted publish for job ${jobId}`)
          process.exitCode = 1
          return
        }
        console.log(`job ${jobId}: interrupted publish cleared — back in the pool for the next due slot`)
      } finally {
        db.close()
      }
    })

  publish
    .command('mark-done <jobId> <postId>')
    .option('--db <path>', 'sqlite db path')
    .action((jobId: string, postId: string, opts: { db?: string }) => {
      const db = openDb(resolveDbPath(opts.db))
      try {
        // v1 platform assumption: PUBLISH_PLATFORMS is exactly ['youtube'], so
        // every interrupted row this command will ever see is a YouTube
        // upload — the Shorts URL is built here rather than threading a
        // --platform flag through for what is currently a single-member enum.
        const url = 'https://youtube.com/shorts/' + postId
        const ok = markInterruptedDone(db, jobId, postId, url, new Date())
        if (!ok) {
          console.error(`no interrupted publish for job ${jobId}`)
          process.exitCode = 1
          return
        }
        console.log(`job ${jobId}: marked done — ${url}`)
      } finally {
        db.close()
      }
    })
  ```

- [ ] **Step 8: Run to green**

  ```bash
  npx vitest run src/cli.test.ts
  ```

  Expected: `Test Files  1 passed (1)` with 0 failures.

- [ ] **Step 9: Write the failing `publishes list` tests (red)**

  Append these four tests at the end of the `describe('brainrot CLI', ...)` block (after the five tests added in Step 5):

  ```ts
    it('`publishes --help` lists the list subcommand', async () => {
      const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'publishes', '--help'], {
        reject: false,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('list')
    }, 60000)

    it('`publishes list` on an empty db prints a friendly empty message', async () => {
      const dbPath = tmpDbPath()
      const result = await execa(
        'pnpm', ['exec', 'tsx', 'src/cli.ts', 'publishes', 'list', '--db', dbPath],
        { reject: false },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('no publishes in the last 7 days')
    }, 60000)

    it('`publishes list` prints day/slot/channel/platform/status/attempt/jobId and the url or error', async () => {
      const dbPath = tmpDbPath()
      seedPublishRow(dbPath, {
        jobId: 'job-list-done', channel: 'demo', day: '2026-07-22', slot: '10:00',
        status: 'done', postId: 'yt-1', url: 'https://youtube.com/shorts/yt-1', attempt: 1,
      })
      seedPublishRow(dbPath, {
        jobId: 'job-list-failed', channel: 'demo', day: '2026-07-22', slot: '14:00',
        status: 'failed', error: 'upload rejected: bad file', errorKind: 'rejected', attempt: 2,
      })
      const result = await execa(
        'pnpm', ['exec', 'tsx', 'src/cli.ts', 'publishes', 'list', '--db', dbPath],
        { reject: false },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(
        '2026-07-22 10:00 demo youtube done attempt 1 job-list-done https://youtube.com/shorts/yt-1',
      )
      expect(result.stdout).toContain(
        '2026-07-22 14:00 demo youtube failed attempt 2 job-list-failed upload rejected: bad file',
      )
    }, 60000)

    it('`publishes list --days garbage` exits 1 before opening the db', async () => {
      const dbPath = tmpDbPath()
      const result = await execa(
        'pnpm',
        ['exec', 'tsx', 'src/cli.ts', 'publishes', 'list', '--days', 'garbage', '--db', dbPath],
        { reject: false },
      )
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('invalid --days "garbage"')
    }, 60000)
  ```

- [ ] **Step 10: Run, observe the failures**

  ```bash
  npx vitest run src/cli.test.ts
  ```

  Expected failure: all 4 new tests fail because `publishes` is not a registered command yet (distinct from `publish`, which Step 7 just added — commander treats them as two separate top-level command names). The `--help` test's exit-code assertion passes (top-level help fallback, exit 0) but `expect(result.stdout).toContain('list')` fails, since none of the top-level command names registered so far contain the substring "list". The other three tests get `error: unknown command 'publishes'` on stderr with exit 1 — the empty-db and populated-list tests fail on their `expect(result.exitCode).toBe(0)` assertion; the invalid-`--days` test's exit-code assertion happens to already pass but `expect(result.stderr).toContain('invalid --days "garbage"')` fails since stderr is the unknown-command message instead.

- [ ] **Step 11: Wire the `publishes list` command (green)**

  In `src/cli.ts`, change the import added in Step 7 to also pull in `listPublishes` (alphabetical order):

  ```ts
  import { listPublishes, markInterruptedDone, retryInterrupted } from './publish/publishes.js'
  ```

  Add this block immediately after the `publish` command group from Step 7 (still before the `isMain` computation):

  ```ts
  const publishes = program.command('publishes')

  publishes
    .command('list')
    .option('--db <path>', 'sqlite db path')
    .option('--days <n>', 'lookback window in days', '7')
    .action((opts: { db?: string; days: string }) => {
      // Validated BEFORE the db opens, mirroring parseTier/parseTopicIds.
      const days = parsePublishDays(opts.days)
      const db = openDb(resolveDbPath(opts.db))
      try {
        const rows = listPublishes(db, { sinceDays: days })
        if (rows.length === 0) {
          console.log(`no publishes in the last ${days} days`)
          return
        }
        for (const r of rows) {
          console.log(
            `${r.day} ${r.slot} ${r.channel} ${r.platform} ${r.status} attempt ${r.attempt} ${r.jobId} ${r.url ?? r.error ?? '-'}`,
          )
        }
      } finally {
        db.close()
      }
    })
  ```

- [ ] **Step 12: Run to green**

  ```bash
  npx vitest run src/cli.test.ts
  ```

  Expected: `Test Files  1 passed (1)` with 0 failures.

- [ ] **Step 13: Run the whole suite**

  ```bash
  npm test
  ```

  Expected: every test file passes, 0 failures (contract tests are excluded by `vitest.config.ts` unless `CONTRACT=1`). This task touched no schema or DAO files, so only `src/cli.ts` and `src/cli.test.ts` changed.

- [ ] **Step 14: Typecheck**

  ```bash
  npx tsc --noEmit
  ```

  Expected: no output, exit 0.

- [ ] **Step 15: Final commit**

  ```bash
  git add src/cli.ts src/cli.test.ts && git commit -m "$(cat <<'EOF'
  feat: add brainrot publish retry/mark-done and publishes list commands

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

### Task 13: Digest publishing section

**Files:** Modify: `src/loop/digest.ts`. Test: `src/loop/digest.test.ts` (extend).

**Interfaces:**
- Consumes:
  ```ts
  // src/publish/types.ts (Task 3)
  export type Platform = (typeof PUBLISH_PLATFORMS)[number]   // 'youtube'
  export function resolvePlatformMeta(metadataJson: string, platform: Platform, fallbackTopic: string): PlatformMeta
  // src/publish/publishes.ts (Task 7)
  export const MAX_PUBLISH_ATTEMPTS = 3
  export function consumedSlots(db: Database, channel: string, platform: Platform, day: string): Set<string>
  // src/publish/slots.ts (Task 6)
  export function localDay(now: Date): string
  // src/config/channel.ts (Task 5)
  export interface ChannelConfig { /* existing fields */; publish: PublishChannelConfig | null }
  export interface PublishChannelConfig {
    slots: string[]; platforms: Platform[]; privacy: 'public' | 'unlisted' | 'private'
    categoryId: number; madeForKids: boolean
  }
  // src/stages/_testkit.ts — gains `publish: null` default (Task 5)
  export function testChannel(overrides?: Partial<ChannelConfig>): ChannelConfig
  ```
- Produces: `buildDigest` signature **unchanged** — `export function buildDigest(db: Database, channels: ChannelConfig[]): string` — now emits a `Publishing (last 24h)` section between `Spend today (UTC)` and `Action items`, plus six new Action-items line types. Consumed by the existing (unmodified) `digest` command in `src/cli.ts` (`import { buildDigest } from './loop/digest.js'`).

---

- [ ] **Step 1: Write failing tests — Publishing section (published/failed rows, none-states, 24h window) + update the section-order test to five sections**

  Add a `seedPublish` helper immediately after the existing `seedLibrary` function (before `seedTopic`) in `src/loop/digest.test.ts`:

  ```ts
  // Publishes rows carry the channel/slot/status shape the publish-next tick
  // writes; day/slot default to fixed values so tests control the UNIQUE
  // (channel, platform, day, slot) constraint explicitly.
  function seedPublish(
    db: Database,
    opts: {
      jobId: string
      channel?: string
      platform?: 'youtube'
      day?: string
      slot?: string
      status?: 'claimed' | 'done' | 'failed' | 'interrupted'
      url?: string | null
      error?: string | null
      errorKind?: 'auth' | 'quota' | 'rejected' | 'transient' | null
      attempt?: number
      createdAt?: string
    },
  ): void {
    db.prepare(
      `INSERT INTO publishes
         (job_id, platform, channel, day, slot, status, url, error, error_kind, attempt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.jobId,
      opts.platform ?? 'youtube',
      opts.channel ?? 'chan-a',
      opts.day ?? '2026-07-19',
      opts.slot ?? '10:00',
      opts.status ?? 'done',
      opts.url ?? null,
      opts.error ?? null,
      opts.errorKind ?? null,
      opts.attempt ?? 1,
      opts.createdAt ?? isoAgo(HOUR_MS),
    )
  }
  ```

  Then replace the tail of the file — from the `it('prints none when there are no action items', ...)` test's closing through the end of the file — with the same test plus a new `publishing section` describe block and a **five**-section version of the section-order test. The exact block being replaced (verify it matches the current file before editing):

  ```ts
  it('prints none when there are no action items', () => {
    const db = openDb(':memory:')
    expect(buildDigest(db, [])).toContain('Action items\n  none')
    db.close()
  })
  })

  describe('buildDigest — section order', () => {
    it('emits the four sections in the pinned order', () => {
      const db = openDb(':memory:')
      const digest = buildDigest(db, [])
      const positions = [
        digest.indexOf('Topics (last 24h)'),
        digest.indexOf('Jobs (last 24h)'),
        digest.indexOf('Spend today (UTC)'),
        digest.indexOf('Action items'),
      ]
      expect(positions.every((p) => p >= 0)).toBe(true)
      expect([...positions].sort((a, b) => a - b)).toEqual(positions)
      db.close()
    })
  })
  ```

  Replace it with:

  ```ts
  it('prints none when there are no action items', () => {
    const db = openDb(':memory:')
    expect(buildDigest(db, [])).toContain('Action items\n  none')
    db.close()
  })
  })

  describe('buildDigest — publishing section', () => {
    it('lists a published video with its resolved title and url', () => {
      const db = openDb(':memory:')
      seedJob(db, { id: 'j-pub', channel: 'chan-a' })
      db.prepare(
        "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, '/tmp/out.mp4', ?, 'published')",
      ).run('j-pub', JSON.stringify({ youtube: { title: 'Moon Facts', description: 'd', hashtags: [] } }))
      seedPublish(db, {
        jobId: 'j-pub',
        channel: 'chan-a',
        slot: '10:00',
        status: 'done',
        url: 'https://youtube.com/shorts/abc123',
      })
      const digest = buildDigest(db, [])
      expect(digest).toContain('Publishing (last 24h)')
      expect(digest).toContain('  Published:')
      expect(digest).toContain('    chan-a 10:00 "Moon Facts" — https://youtube.com/shorts/abc123')
      db.close()
    })

    it('lists a failed attempt with its error kind and truncates the error to 80 chars', () => {
      const db = openDb(':memory:')
      const longError = 'x'.repeat(120)
      seedPublish(db, {
        jobId: 'j-fail',
        channel: 'chan-b',
        slot: '14:00',
        status: 'failed',
        errorKind: 'rejected',
        error: longError,
      })
      const digest = buildDigest(db, [])
      expect(digest).toContain(`    chan-b 14:00 rejected: ${'x'.repeat(80)}`)
      expect(digest).not.toContain('x'.repeat(81))
      db.close()
    })

    it('prints none for both subsections when nothing published or failed in the last 24h', () => {
      const db = openDb(':memory:')
      const digest = buildDigest(db, [])
      expect(digest).toContain('  Published:\n    none')
      expect(digest).toContain('  Failed:\n    none')
      db.close()
    })

    it('excludes publishes older than 24h', () => {
      const db = openDb(':memory:')
      seedJob(db, { id: 'j-old', channel: 'chan-a' })
      db.prepare(
        "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES ('j-old', '/tmp/out.mp4', '{}', 'published')",
      ).run()
      seedPublish(db, {
        jobId: 'j-old',
        channel: 'chan-a',
        status: 'done',
        url: 'https://youtube.com/shorts/old',
        createdAt: isoAgo(3 * DAY_MS),
      })
      const digest = buildDigest(db, [])
      expect(digest).toContain('  Published:\n    none')
      db.close()
    })
  })

  describe('buildDigest — section order', () => {
    it('emits the five sections in the pinned order', () => {
      const db = openDb(':memory:')
      const digest = buildDigest(db, [])
      const positions = [
        digest.indexOf('Topics (last 24h)'),
        digest.indexOf('Jobs (last 24h)'),
        digest.indexOf('Spend today (UTC)'),
        digest.indexOf('Publishing (last 24h)'),
        digest.indexOf('Action items'),
      ]
      expect(positions.every((p) => p >= 0)).toBe(true)
      expect([...positions].sort((a, b) => a - b)).toEqual(positions)
      db.close()
    })
  })
  ```

- [ ] **Step 2: Run it — expect failure**

  Run `npx vitest run src/loop/digest.test.ts`. Expect failures in the new `buildDigest — publishing section` tests, e.g.:
  ```
  AssertionError: expected '...Action items\n  none' to contain 'Publishing (last 24h)'
  ```
  and in `buildDigest — section order`:
  ```
  AssertionError: expected false to be true // Object.is equality
  ```
  (because `digest.indexOf('Publishing (last 24h)')` is `-1`). All previously-passing tests still pass.

- [ ] **Step 3: Minimal implementation — add the Publishing section**

  In `src/loop/digest.ts`, replace the import block:

  ```ts
  import type { Database } from 'better-sqlite3'
  import type { ChannelConfig } from '../config/channel.js'
  import {
    channelDaySpentMicros,
    globalDailyCapMicros,
    globalDaySpentMicros,
  } from '../jobs/costs.js'
  ```

  with:

  ```ts
  import type { Database } from 'better-sqlite3'
  import type { ChannelConfig } from '../config/channel.js'
  import {
    channelDaySpentMicros,
    globalDailyCapMicros,
    globalDaySpentMicros,
  } from '../jobs/costs.js'
  import { resolvePlatformMeta } from '../publish/types.js'
  import type { Platform } from '../publish/types.js'
  ```

  Replace the docstring above `buildDigest`:

  ```ts
  /**
   * Last-24h operator report, plain multi-line text (NOT JSON), sections in
   * the plan's order: topics, jobs, spend, action items. Count sections group
   * straight from sqlite so channels that vanished from the channels dir still
   * report; `channels` (the loadChannelsDir enumeration) feeds only the spend
   * section, whose caps live in the TOMLs. datetime(created_at) normalizes the
   * stored ISO-8601 'T'/'Z' format to sqlite's own datetime() format — a raw
   * string compare against datetime('now','-1 day') would widen the window to
   * the whole boundary day.
   */
  ```

  with:

  ```ts
  /**
   * Last-24h operator report, plain multi-line text (NOT JSON), sections in
   * the plan's order: topics, jobs, spend, publishing, action items. Count
   * sections group straight from sqlite so channels that vanished from the
   * channels dir still report; `channels` (the loadChannelsDir enumeration)
   * feeds the spend section and the publish-config-aware action items (ready
   * backlog, lapsed slots), both scoped to channels carrying a `[publish]`
   * table. datetime(created_at) normalizes the stored ISO-8601 'T'/'Z' format
   * to sqlite's own datetime() format — a raw string compare against
   * datetime('now','-1 day') would widen the window to the whole boundary day.
   */
  ```

  Replace:

  ```ts
    lines.push(`  global: ${usd(globalDaySpentMicros(db))} of ${usd(globalDailyCapMicros())}`)

    lines.push('', 'Action items')
  ```

  with:

  ```ts
    lines.push(`  global: ${usd(globalDaySpentMicros(db))} of ${usd(globalDailyCapMicros())}`)

    lines.push('', 'Publishing (last 24h)')
    // Same datetime() normalization as the topics/jobs sections above: stored
    // created_at is ISO-8601 with a 'T'/'Z' millis suffix, which sqlite's own
    // datetime('now', ...) doesn't emit — a raw string compare would widen
    // the window to the whole boundary day.
    const publishedRows = db
      .prepare(
        `SELECT p.channel AS channel, p.platform AS platform, p.slot AS slot,
                p.url AS url, j.topic AS topic, l.metadata_json AS metadataJson
         FROM publishes p
         JOIN jobs j ON j.id = p.job_id
         JOIN library l ON l.job_id = p.job_id
         WHERE p.status = 'done' AND datetime(p.created_at) >= datetime('now', '-1 day')
         ORDER BY p.channel, p.slot`,
      )
      .all() as {
      channel: string
      platform: Platform
      slot: string
      url: string
      topic: string
      metadataJson: string
    }[]
    lines.push('  Published:')
    if (publishedRows.length === 0) lines.push('    none')
    for (const r of publishedRows) {
      const meta = resolvePlatformMeta(r.metadataJson, r.platform, r.topic)
      lines.push(`    ${r.channel} ${r.slot} "${meta.title}" — ${r.url}`)
    }
    const failedPublishRows = db
      .prepare(
        `SELECT channel, slot, error_kind AS errorKind, error
         FROM publishes
         WHERE status = 'failed' AND datetime(created_at) >= datetime('now', '-1 day')
         ORDER BY channel, slot`,
      )
      .all() as { channel: string; slot: string; errorKind: string; error: string | null }[]
    lines.push('  Failed:')
    if (failedPublishRows.length === 0) lines.push('    none')
    for (const r of failedPublishRows) {
      lines.push(`    ${r.channel} ${r.slot} ${r.errorKind}: ${(r.error ?? '').slice(0, 80)}`)
    }

    lines.push('', 'Action items')
  ```

- [ ] **Step 4: Run it — expect pass**

  Run `npx vitest run src/loop/digest.test.ts`. All tests pass, including the four new `buildDigest — publishing section` tests and the updated five-section `buildDigest — section order` test.

- [ ] **Step 5: Write failing tests — auth-failed hint, quota-drift hint, interrupted-check instruction, attempt-capped suggestion**

  Insert a new describe block into `src/loop/digest.test.ts` immediately before the line `describe('buildDigest — section order', () => {`:

  ```ts
  describe('buildDigest — publishing action items', () => {
    it('flags channels with auth failures in the last 24h, one line per channel', () => {
      const db = openDb(':memory:')
      seedPublish(db, { jobId: 'j1', channel: 'chan-a', slot: '10:00', status: 'failed', errorKind: 'auth' })
      seedPublish(db, { jobId: 'j2', channel: 'chan-a', slot: '14:00', status: 'failed', errorKind: 'auth' })
      const digest = buildDigest(db, [])
      expect(digest).toContain(
        '  chan-a: 2 auth failures in the last 24h — run brainrot auth youtube --channel chan-a',
      )
      db.close()
    })

    it('flags quota failures distinctly — the cap estimate and reality disagree', () => {
      const db = openDb(':memory:')
      seedPublish(db, { jobId: 'j1', channel: 'chan-a', slot: '10:00', status: 'failed', errorKind: 'quota' })
      seedPublish(db, { jobId: 'j2', channel: 'chan-a', slot: '14:00', status: 'failed', errorKind: 'quota' })
      const digest = buildDigest(db, [])
      expect(digest).toContain(
        "  chan-a: 2 quota failures in the last 24h — YouTube refused the upload; check BRAINROT_YT_UPLOADS_PER_DAY against the project's real quota",
      )
      db.close()
    })

    it('instructs checking Studio for interrupted uploads of any age', () => {
      const db = openDb(':memory:')
      seedPublish(db, {
        jobId: 'j-int',
        channel: 'chan-a',
        slot: '19:00',
        status: 'interrupted',
        createdAt: isoAgo(3 * DAY_MS),
      })
      const digest = buildDigest(db, [])
      expect(digest).toContain(
        '  interrupted publish j-int (chan-a, 19:00) — check YouTube Studio, then brainrot publish retry j-int or brainrot publish mark-done j-int <postId>',
      )
      db.close()
    })

    it('suggests library reject for a job at the rejected attempt cap while still ready', () => {
      const db = openDb(':memory:')
      seedJob(db, { id: 'j-capped', channel: 'chan-a' })
      seedLibrary(db, 'j-capped', 'ready')
      seedPublish(db, { jobId: 'j-capped', channel: 'chan-a', day: '2026-07-19', slot: '08:00', status: 'failed', errorKind: 'rejected' })
      seedPublish(db, { jobId: 'j-capped', channel: 'chan-a', day: '2026-07-19', slot: '12:00', status: 'failed', errorKind: 'rejected' })
      seedPublish(db, { jobId: 'j-capped', channel: 'chan-a', day: '2026-07-19', slot: '16:00', status: 'failed', errorKind: 'rejected' })
      const digest = buildDigest(db, [])
      expect(digest).toContain(
        '  job j-capped (chan-a) hit the publish attempt cap (3 rejected) — run brainrot library reject j-capped',
      )
      db.close()
    })

    it('does not flag a job under the attempt cap', () => {
      const db = openDb(':memory:')
      seedJob(db, { id: 'j-under', channel: 'chan-a' })
      seedLibrary(db, 'j-under', 'ready')
      seedPublish(db, { jobId: 'j-under', channel: 'chan-a', day: '2026-07-19', slot: '08:00', status: 'failed', errorKind: 'rejected' })
      seedPublish(db, { jobId: 'j-under', channel: 'chan-a', day: '2026-07-19', slot: '12:00', status: 'failed', errorKind: 'rejected' })
      const digest = buildDigest(db, [])
      expect(digest).not.toContain('publish attempt cap')
      db.close()
    })
  })

  ```

- [ ] **Step 6: Run it — expect failure**

  Run `npx vitest run src/loop/digest.test.ts`. Expect failures in the five new `buildDigest — publishing action items` tests, e.g.:
  ```
  AssertionError: expected '...Action items\n  none' to contain '  chan-a: 2 auth failures in the last 24h — run brainrot auth youtube --channel chan-a'
  ```
  (the "under the attempt cap" test passes trivially since the digest doesn't yet contain the string at all — leave it, it still documents intent and will keep passing).

- [ ] **Step 7: Minimal implementation — auth-failed, quota-drift, interrupted, attempt-capped action items**

  In `src/loop/digest.ts`, add the `MAX_PUBLISH_ATTEMPTS` import. Replace:

  ```ts
  import { resolvePlatformMeta } from '../publish/types.js'
  import type { Platform } from '../publish/types.js'
  ```

  with:

  ```ts
  import { MAX_PUBLISH_ATTEMPTS } from '../publish/publishes.js'
  import { resolvePlatformMeta } from '../publish/types.js'
  import type { Platform } from '../publish/types.js'
  ```

  Then insert the four new query blocks immediately before the stable end-of-function line `if (lines.length === sectionStart) lines.push('  none')`. Replace:

  ```ts
    for (const r of candidateDepth) {
      lines.push(`  ${r.channel}: ${r.n} candidate topics awaiting approval`)
    }
    if (lines.length === sectionStart) lines.push('  none')
  ```

  with:

  ```ts
    for (const r of candidateDepth) {
      lines.push(`  ${r.channel}: ${r.n} candidate topics awaiting approval`)
    }
    // Auth failures are channel-wide (the grant, not the video) — one hint
    // per channel rather than one per failed row, so a bad afternoon doesn't
    // spam identical suggestions.
    const authFailures = db
      .prepare(
        `SELECT channel, COUNT(*) AS n FROM publishes
         WHERE status = 'failed' AND error_kind = 'auth'
           AND datetime(created_at) >= datetime('now', '-1 day')
         GROUP BY channel ORDER BY channel`,
      )
      .all() as { channel: string; n: number }[]
    for (const r of authFailures) {
      lines.push(
        `  ${r.channel}: ${r.n} auth failures in the last 24h — run brainrot auth youtube --channel ${r.channel}`,
      )
    }
    // Quota failures mean the BRAINROT_YT_UPLOADS_PER_DAY estimate and
    // YouTube's real project quota disagree (spec §5: "cap vs reality
    // drift") — a distinct line per channel, mirroring the auth hint.
    const quotaFailures = db
      .prepare(
        `SELECT channel, COUNT(*) AS n FROM publishes
         WHERE status = 'failed' AND error_kind = 'quota'
           AND datetime(created_at) >= datetime('now', '-1 day')
         GROUP BY channel ORDER BY channel`,
      )
      .all() as { channel: string; n: number }[]
    for (const r of quotaFailures) {
      lines.push(
        `  ${r.channel}: ${r.n} quota failures in the last 24h — YouTube refused the upload; check BRAINROT_YT_UPLOADS_PER_DAY against the project's real quota`,
      )
    }
    // Current state, not last-24h (mirrors the failedJobs block above): an
    // interrupted upload sits until the operator checks Studio, however old.
    const interruptedRows = db
      .prepare(
        "SELECT job_id AS jobId, channel, slot FROM publishes WHERE status = 'interrupted' ORDER BY created_at ASC",
      )
      .all() as { jobId: string; channel: string; slot: string }[]
    for (const r of interruptedRows) {
      lines.push(
        `  interrupted publish ${r.jobId} (${r.channel}, ${r.slot}) — check YouTube Studio, then brainrot publish retry ${r.jobId} or brainrot publish mark-done ${r.jobId} <postId>`,
      )
    }
    // Only 'rejected' failures count toward the cap (decision 8) — auth/
    // quota/transient failures are channel- or platform-wide, not the
    // video's fault.
    const attemptCapped = db
      .prepare(
        `SELECT p.job_id AS jobId, p.channel AS channel, COUNT(*) AS n
         FROM publishes p JOIN library l ON l.job_id = p.job_id
         WHERE p.status = 'failed' AND p.error_kind = 'rejected' AND l.state = 'ready'
         GROUP BY p.job_id, p.channel
         HAVING COUNT(*) >= ?
         ORDER BY p.job_id`,
      )
      .all(MAX_PUBLISH_ATTEMPTS) as { jobId: string; channel: string; n: number }[]
    for (const r of attemptCapped) {
      lines.push(
        `  job ${r.jobId} (${r.channel}) hit the publish attempt cap (${r.n} rejected) — run brainrot library reject ${r.jobId}`,
      )
    }
    if (lines.length === sectionStart) lines.push('  none')
  ```

- [ ] **Step 8: Run it — expect pass**

  Run `npx vitest run src/loop/digest.test.ts`. All tests pass, including the five new `buildDigest — publishing action items` tests.

- [ ] **Step 9: Write failing test — ready-backlog per channel with a publish config**

  In `src/loop/digest.test.ts`, replace the `seedLibrary` helper:

  ```ts
  // Library rows carry the ready/needs-review outcome for 'done' jobs — the
  // same insert shape the runner's library upsert writes.
  function seedLibrary(db: Database, jobId: string, state: 'ready' | 'needs-review'): void {
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, '/tmp/out.mp4', '{}', ?)",
    ).run(jobId, state)
  }
  ```

  with:

  ```ts
  // Library rows carry the ready/needs-review outcome for 'done' jobs — the
  // same insert shape the runner's library upsert writes. createdAt is
  // optional and only used by tests that need to control backlog age
  // precisely; omitting it keeps the schema default ('now') for every
  // existing caller.
  function seedLibrary(
    db: Database,
    jobId: string,
    state: 'ready' | 'needs-review',
    createdAt?: string,
  ): void {
    if (createdAt === undefined) {
      db.prepare(
        "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, '/tmp/out.mp4', '{}', ?)",
      ).run(jobId, state)
      return
    }
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state, created_at) VALUES (?, '/tmp/out.mp4', '{}', ?, ?)",
    ).run(jobId, state, createdAt)
  }
  ```

  Then insert a new describe block immediately before `describe('buildDigest — section order', () => {`:

  ```ts
  describe('buildDigest — ready-backlog action item', () => {
    it('reports ready backlog depth and oldest age only for channels with a publish config', () => {
      const db = openDb(':memory:')
      const chA = testChannel({
        name: 'chan-a',
        publish: { slots: ['10:00'], platforms: ['youtube'], privacy: 'public', categoryId: 24, madeForKids: false },
      })
      const chB = testChannel({ name: 'chan-b', publish: null })
      seedJob(db, { id: 'j-old', channel: 'chan-a' })
      seedLibrary(db, 'j-old', 'ready', isoAgo(5 * HOUR_MS))
      seedJob(db, { id: 'j-new', channel: 'chan-a' })
      seedLibrary(db, 'j-new', 'ready', isoAgo(HOUR_MS))
      seedJob(db, { id: 'j-nopublish', channel: 'chan-b' })
      seedLibrary(db, 'j-nopublish', 'ready')
      const digest = buildDigest(db, [chA, chB])
      expect(digest).toContain('  chan-a: 2 ready videos backlogged, oldest 5h old')
      expect(digest).not.toContain('chan-b: 1 ready videos backlogged')
      db.close()
    })
  })

  ```

- [ ] **Step 10: Run it — expect failure**

  Run `npx vitest run src/loop/digest.test.ts`. Expect:
  ```
  AssertionError: expected '...Action items\n  none' to contain '  chan-a: 2 ready videos backlogged, oldest 5h old'
  ```

- [ ] **Step 11: Minimal implementation — ready-backlog action item**

  In `src/loop/digest.ts`, insert the backlog block immediately before `if (lines.length === sectionStart) lines.push('  none')` (which now sits right after the `attemptCapped` loop from Step 7). Replace:

  ```ts
    for (const r of attemptCapped) {
      lines.push(
        `  job ${r.jobId} (${r.channel}) hit the publish attempt cap (${r.n} rejected) — run brainrot library reject ${r.jobId}`,
      )
    }
    if (lines.length === sectionStart) lines.push('  none')
  ```

  with:

  ```ts
    for (const r of attemptCapped) {
      lines.push(
        `  job ${r.jobId} (${r.channel}) hit the publish attempt cap (${r.n} rejected) — run brainrot library reject ${r.jobId}`,
      )
    }
    // Single now() read for the two channel-scoped items below — buildDigest
    // is not clock-injected (no other call site needs it), so this is
    // computed once here rather than threaded as a parameter.
    const now = new Date()
    // Backlog pressure only matters for channels that actually publish —
    // ready rows on a channel with no [publish] table just sit there by
    // design.
    const readyBacklog = db
      .prepare(
        `SELECT j.channel AS channel, COUNT(*) AS n, MIN(l.created_at) AS oldest
         FROM library l JOIN jobs j ON j.id = l.job_id
         WHERE l.state = 'ready'
         GROUP BY j.channel`,
      )
      .all() as { channel: string; n: number; oldest: string }[]
    const publishingChannels = new Set(
      channels.filter((c) => c.publish !== null).map((c) => c.name),
    )
    for (const r of readyBacklog) {
      if (!publishingChannels.has(r.channel)) continue
      const ageHours = Math.floor((now.getTime() - new Date(r.oldest).getTime()) / 3_600_000)
      lines.push(`  ${r.channel}: ${r.n} ready videos backlogged, oldest ${ageHours}h old`)
    }
    if (lines.length === sectionStart) lines.push('  none')
  ```

- [ ] **Step 12: Run it — expect pass**

  Run `npx vitest run src/loop/digest.test.ts`. All tests pass, including the new `buildDigest — ready-backlog action item` test.

- [ ] **Step 13: Write failing tests — slots that lapsed unfilled yesterday**

  In `src/loop/digest.test.ts`, add `localDay` to the imports. Replace:

  ```ts
  import { afterEach, describe, expect, it, vi } from 'vitest'
  import type { Database } from 'better-sqlite3'
  import { openDb } from '../db/index.js'
  import { testChannel } from '../stages/_testkit.js'
  import { buildDigest, STRANDED_QUEUED_MS, ZOMBIE_RUNNING_MS } from './digest.js'
  ```

  with:

  ```ts
  import { afterEach, describe, expect, it, vi } from 'vitest'
  import type { Database } from 'better-sqlite3'
  import { openDb } from '../db/index.js'
  import { localDay } from '../publish/slots.js'
  import { testChannel } from '../stages/_testkit.js'
  import { buildDigest, STRANDED_QUEUED_MS, ZOMBIE_RUNNING_MS } from './digest.js'
  ```

  Then insert a new describe block immediately before `describe('buildDigest — section order', () => {`:

  ```ts
  describe('buildDigest — lapsed-slots action item', () => {
    it('reports slots that lapsed unfilled yesterday for channels with a publish config', () => {
      const db = openDb(':memory:')
      const yesterday = localDay(new Date(Date.now() - DAY_MS))
      const chA = testChannel({
        name: 'chan-a',
        publish: {
          slots: ['09:00', '14:00', '19:00'],
          platforms: ['youtube'],
          privacy: 'public',
          categoryId: 24,
          madeForKids: false,
        },
      })
      seedJob(db, { id: 'j-yday', channel: 'chan-a' })
      seedPublish(db, { jobId: 'j-yday', channel: 'chan-a', day: yesterday, slot: '09:00', status: 'done' })
      const digest = buildDigest(db, [chA])
      expect(digest).toContain(`  chan-a youtube: slots 14:00, 19:00 lapsed unfilled yesterday (${yesterday})`)
      expect(digest).not.toContain('09:00 lapsed')
      db.close()
    })

    it('does not flag lapsed slots for a channel with no publish config', () => {
      const db = openDb(':memory:')
      const chB = testChannel({ name: 'chan-b', publish: null })
      const digest = buildDigest(db, [chB])
      expect(digest).not.toContain('lapsed unfilled yesterday')
      db.close()
    })
  })

  ```

- [ ] **Step 14: Run it — expect failure**

  Run `npx vitest run src/loop/digest.test.ts`. Expect:
  ```
  AssertionError: expected '...Action items\n  none' to contain '  chan-a youtube: slots 14:00, 19:00 lapsed unfilled yesterday (...)'
  ```

- [ ] **Step 15: Minimal implementation — lapsed-slots-yesterday action item**

  In `src/loop/digest.ts`, add `consumedSlots` and `localDay` to the imports. Replace:

  ```ts
  import { MAX_PUBLISH_ATTEMPTS } from '../publish/publishes.js'
  import { resolvePlatformMeta } from '../publish/types.js'
  import type { Platform } from '../publish/types.js'
  ```

  with:

  ```ts
  import { consumedSlots, MAX_PUBLISH_ATTEMPTS } from '../publish/publishes.js'
  import { localDay } from '../publish/slots.js'
  import { resolvePlatformMeta } from '../publish/types.js'
  import type { Platform } from '../publish/types.js'
  ```

  Then insert the lapsed-slots block immediately before `if (lines.length === sectionStart) lines.push('  none')` (which now sits right after the `readyBacklog` loop from Step 11). Replace:

  ```ts
    for (const r of readyBacklog) {
      if (!publishingChannels.has(r.channel)) continue
      const ageHours = Math.floor((now.getTime() - new Date(r.oldest).getTime()) / 3_600_000)
      lines.push(`  ${r.channel}: ${r.n} ready videos backlogged, oldest ${ageHours}h old`)
    }
    if (lines.length === sectionStart) lines.push('  none')
  ```

  with:

  ```ts
    for (const r of readyBacklog) {
      if (!publishingChannels.has(r.channel)) continue
      const ageHours = Math.floor((now.getTime() - new Date(r.oldest).getTime()) / 3_600_000)
      lines.push(`  ${r.channel}: ${r.n} ready videos backlogged, oldest ${ageHours}h old`)
    }
    // Local-time slot bookkeeping (decision 13): "yesterday" is the local
    // calendar day before now — local date-field math, NOT now-minus-24h,
    // which lands on the wrong local date across DST transitions.
    const yesterdayDate = new Date(now)
    yesterdayDate.setDate(yesterdayDate.getDate() - 1)
    const yesterday = localDay(yesterdayDate)
    for (const channel of channels) {
      if (channel.publish === null) continue
      for (const platform of channel.publish.platforms) {
        const consumed = consumedSlots(db, channel.name, platform, yesterday)
        const lapsed = channel.publish.slots.filter((slot) => !consumed.has(slot))
        if (lapsed.length > 0) {
          lines.push(
            `  ${channel.name} ${platform}: slots ${lapsed.join(', ')} lapsed unfilled yesterday (${yesterday})`,
          )
        }
      }
    }
    if (lines.length === sectionStart) lines.push('  none')
  ```

- [ ] **Step 16: Run it — expect pass**

  Run `npx vitest run src/loop/digest.test.ts`. All tests pass, including the two new `buildDigest — lapsed-slots action item` tests.

- [ ] **Step 17: Run the full suite**

  Run `npm test`. Confirm the whole suite passes (no regressions introduced in unrelated files by the import/section changes).

- [ ] **Step 18: Commit**

  ```bash
  git add src/loop/digest.ts src/loop/digest.test.ts && git commit -m "$(cat <<'EOF'
  feat(digest): add publishing section and publish-aware action items

  Surfaces published/failed uploads from the last 24h, plus auth-failure,
  interrupted-upload, attempt-cap, ready-backlog, and lapsed-slot hints so
  the operator sees publishing health without querying the DB by hand.
  EOF
  )"
  ```

### Task 14: README + golden path + contract test

**Files:**
- Modify: `README.md`, `src/jobs/golden-path-loop.test.ts`
- Create: `src/publish/youtube.contract.test.ts`, `src/publish/__fixtures__/tiny.mp4`

**Interfaces:**
- Consumes:
  - `openDb(dbPath: string): Database` — `src/db/index.ts`
  - `loadChannelsDir(dir: string): ChannelConfig[]` and the `[publish]` TOML table (Task 5) — `src/config/channel.ts`
  - `parseTokenKey(hex: string | undefined): Buffer` (Task 2) — `src/publish/crypto.ts`
  - `upsertToken(db: Database, platform: Platform, channel: string, refreshToken: string, scopes: string, key: Buffer): void` and `loadRefreshToken(db: Database, platform: Platform, channel: string, key: Buffer): string | null` (Task 4) — `src/publish/tokens.ts`
  - `YT_UPLOAD_SCOPE`, `mintAccessToken(opts: { refreshToken: string; clientId: string; clientSecret: string; fetchImpl?: typeof fetch }): Promise<string>`, `youtubeTarget(fetchImpl?: typeof fetch): PublishTarget` (Task 8) — `src/publish/youtube.ts`
  - `PublishTarget`, `PlatformMeta`, `PublishChannelConfig` (Task 3) — `src/publish/types.ts`
  - `publishNextTick(db: Database, opts: { channelsDir: string; target?: PublishTarget; fetchImpl?: typeof fetch; now?: () => Date; dryRun?: boolean }): Promise<PublishTickResult>` (Task 10) — `src/loop/publish-next.ts`
  - `scoutChannel`, `produceNextTick`, `STAGE_ORDER`, `loadChannelsDir`, `openDb`, `listTopics` and the existing `fakeStagesFor`/fixture machinery already in `src/jobs/golden-path-loop.test.ts` (unchanged)
- Produces: nothing — this is the terminal task in the dependency graph. The fixture and contract test are exercised only by an operator running `pnpm test:contract` (or `CONTRACT=1 npx vitest run src/publish/youtube.contract.test.ts`) by hand against real Google credentials; no later task imports anything from this one.

---

- [ ] **Step 1: Document YouTube publishing setup in README.md**

  This is a documentation-only change — there is no test to run. Replace the
  full contents of `README.md` with the text below. It is the current file
  with two changes: a new `## Publishing (YouTube)` section inserted between
  `## Inspect` and `## Automation (cron)`, and the `## Automation (cron)`
  section extended (intro sentence, crontab block, and the "Manual runs take
  no lease" caveat) to cover `publish-next`.

  ```markdown
  # Brainrot Machine

  Automated short-form video pipeline. `brainrot produce` turns a topic into a
  finished, QC-checked, word-captioned 9:16 MP4 in the library.

  ## Prerequisites

  - Node >= 22 and [pnpm](https://pnpm.io)
  - [ffmpeg](https://ffmpeg.org) + ffprobe on `PATH` (`brew install ffmpeg`)
  - Docker (for the WhisperX caption-alignment sidecar — volume tier and premium
    voice-fallback runs; a premium run whose ElevenLabs synth succeeds never
    touches it)

  ## Setup

  ```bash
  pnpm install
  cp .env.example .env          # fill in provider keys (see below)
  docker compose up -d whisperx # caption alignment sidecar
  ```

  Keys in `.env`:

  - `ANTHROPIC_API_KEY` — scripts (both tiers), premium vision checks
  - `FAL_KEY` — premium visuals (FLUX keyframes, Kling/MiniMax image-to-video)
  - `ELEVENLABS_API_KEY` — premium voice (unset: premium falls back to kokoro/edge-tts)
  - `BRAINROT_GLOBAL_DAILY_USD` — cross-channel daily spend cap in USD (default 25)

  ## Seed background footage

  Drop vertical-friendly clips into the channel's background folder (default
  `assets/bg/`) and royalty-free music into `assets/bgm/`. The volume tier picks
  a clip at random, avoiding the 5 most recently used per channel.

  ```bash
  cp ~/footage/*.mp4 assets/bg/
  cp ~/music/*.mp3  assets/bgm/
  ```

  ## Produce a video

  ```bash
  pnpm brainrot produce --channel channels/example.toml --topic "Why is Venus so hot?"
  # options: --tier volume|premium  --db data/brainrot.db  --runs-root runs
  ```

  Prints the `JobResult` as one JSON line; exit code `0` on `ready`/`needs-review`,
  `1` on `failed` or `blocked` (a `blocked` status means a budget cap was hit).

  ## Premium tier

  `--tier premium` swaps library footage for AI-generated visuals: per scene, a
  FLUX keyframe is generated, vision-checked by Claude, then animated with Kling
  image-to-video (all via fal.ai). Narration comes from ElevenLabs with
  word-level timings (no WhisperX dependency on the happy path), and QC adds
  scene-coverage and vision spot checks.

  ```bash
  pnpm brainrot produce --channel channels/example.toml \
    --topic "Why is Venus so hot?" --tier premium
  ```

  Requires `ANTHROPIC_API_KEY`, `FAL_KEY`, and `ELEVENLABS_API_KEY` in `.env`.

  Cost envelope: a typical ~35s premium video runs **typically $3.00–6.00** (5s
  scenes ~$0.42/clip, 10s scenes ~$0.84/clip; ElevenLabs + keyframes + vision
  checks add ~$0.15–0.40); the **$7.00** default per-video cap
  (`premium_per_video_usd` in the channel TOML) absorbs retries — long narrations
  (>~14 words) force 10s clips, so shorter scenes are cheaper. A breach parks the
  job `blocked` before the overspending call fires. Per-channel (`per_day_usd`)
  and global (`BRAINROT_GLOBAL_DAILY_USD`, default $25/day) daily caps stack on top.

  ## Where outputs land

  - Per-job artifacts: `runs/<jobId>/<stage>/` (`script.json`, `narration.wav`,
    `words.json`, then `background.mp4` for volume or `scene-NN.png` /
    `scene-NN.mp4` + `scenes.json` for premium, `final.mp4`, `qc.json`)
  - Finished video: `runs/<jobId>/assemble/final.mp4`
  - State + library + cost ledger: SQLite at `data/brainrot.db` (override with
    `--db` or `BRAINROT_DB`)

  ## Inspect

  ```bash
  pnpm brainrot jobs    # last 20 jobs
  pnpm brainrot costs   # per-day USD totals, last 7 days
  ```

  ## Publishing (YouTube)

  `ready` library videos upload to YouTube Shorts automatically via the
  `publish-next` cron tick (see Automation below), on a per-channel schedule
  of local-time slots.

  ### One-time setup (per Google Cloud project, not per channel)

  1. Create (or reuse) a project at
     [console.cloud.google.com](https://console.cloud.google.com).
  2. Enable the **YouTube Data API v3** for that project (APIs & Services →
     Enable APIs and Services → search "YouTube Data API v3" → Enable).
  3. APIs & Services → Credentials → Create Credentials → OAuth client ID.
     **Application type: Desktop app** — Desktop-app clients accept a
     consent redirect to any loopback port, so the CLI's flow needs no
     redirect URI registered.
  4. Add the client id/secret to `.env`:

     ```
     YT_CLIENT_ID=...
     YT_CLIENT_SECRET=...
     ```

  5. Generate a token-encryption key and add it too. Refresh tokens are
     stored AES-256-GCM-encrypted in the database — this key never leaves
     `.env`:

     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```

     ```
     BRAINROT_TOKEN_KEY=<paste the 64-hex-char output>
     ```

  ### Per-channel auth

  Each YouTube channel is its own brand account and needs its own consent
  grant — run once per channel, and again any time a grant expires or gets
  revoked:

  ```bash
  pnpm brainrot auth youtube --channel example
  ```

  This opens the system browser to Google's consent screen. **Pick the
  channel's YouTube brand account, not your personal Google account** —
  the upload-only scope this flow requests can't read back which channel
  you picked, so the CLI cannot warn you if you pick wrong. A wrong pick is
  recoverable: re-run the command and pick correctly. The first published
  URL in a wrong channel's digest is usually what surfaces the mistake.

  ### Channel config

  Add a `[publish]` table to a channel's TOML to opt it into the publish
  pool — channels without one never publish:

  ```toml
  [publish]
  slots = ["10:00", "14:00", "19:00"]  # machine-local HH:MM, unique
  platforms = ["youtube"]              # only valid value in v1
  privacy = "public"                   # 'public' | 'unlisted' | 'private'
  category_id = 24                     # YouTube category; 24 = Entertainment
  made_for_kids = false
  ```

  A slot missed while the machine was asleep fills late the same day; a
  slot still open at local midnight lapses with no makeup post — the
  digest reports lapsed slots so cadence can be adjusted.

  ### Quota

  YouTube's upload quota is per Google Cloud **project**, not per channel:
  10,000 units/day at 1,600 units/upload works out to roughly **6 uploads
  a day, project-wide, across every channel sharing that project**.
  `publish-next` enforces this with a hard pre-upload gate
  (`BRAINROT_YT_UPLOADS_PER_DAY`, default 6). If six a day isn't enough
  headroom for your channel count, request a quota increase at
  <https://support.google.com/youtube/contact/yt_api_form>.

  ## Automation (cron)

  The production loop is four cron-invoked commands: `scout` fills the topic
  queue, `produce-next` performs one unit of work per tick (resume one blocked
  job or produce one video), `publish-next` uploads one `ready` video per tick
  into its channel's next due slot (see Publishing (YouTube) above), and
  `digest` prints a daily report.

  No API keys are needed for scouting: reddit subreddits are read through their
  public `.rss` feeds and RSS sources through their own. Reddit's Data API is an
  optional upgrade — if you get a script app approved under its Responsible
  Builder Policy, set `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` in `.env` and
  the scout switches to app-only OAuth (richer JSON, mod stickies filtered out,
  100 requests/min). Without them the feed path applies, where stickied posts
  are indistinguishable from real ones and simply score low.

  Paste into `crontab -e`, adjusting the paths:

  ```cron
  # cron runs with a bare PATH (/usr/bin:/bin): pnpm, node, and ffmpeg do not
  # resolve without this line. Find your dirs with `which pnpm` / `which ffmpeg`.
  PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin

  # Digest delivery is operator wiring: cron mails each job's output to MAILTO
  # (needs working local mail), or replace the digest line with a pipe into
  # your notifier of choice.
  MAILTO=you@example.com

  # Scout trends into the topic queue, 3x/day at 07:05 / 12:05 / 17:05. Staggered
  # 5 minutes off the hour so it never co-fires with the produce-next tick at :00
  # — defense in depth on top of the DB busy_timeout, since scout and produce-next
  # are two processes writing one SQLite file.
  5 7,12,17 * * * cd /Users/alex/code/project-brainrot && pnpm brainrot scout >> logs/scout.log 2>&1

  # One unit of production per tick (*/25 fires at :00, :25 and :50 each hour).
  */25 * * * * cd /Users/alex/code/project-brainrot && pnpm brainrot produce-next >> logs/produce-next.log 2>&1

  # One publish attempt per tick, on whichever due slot is furthest behind its
  # channel's cadence (*/15 keeps slots filling within ~15 min of their
  # configured time). Unlike scout, this is deliberately NOT staggered off
  # produce-next's :00/:25/:50 — publish-next and produce-next write disjoint
  # tables (publishes/library vs jobs/topics), so a same-minute co-fire is safe
  # on the DB busy_timeout alone.
  */15 * * * * cd /Users/alex/code/project-brainrot && npx tsx src/cli.ts publish-next >> logs/publish.log 2>&1

  # Daily digest at 08:00 — stdout goes to MAILTO; nothing else delivers it.
  0 8 * * * cd /Users/alex/code/project-brainrot && pnpm brainrot digest
  ```

  - **`cd` into the repo, absolute paths only.** Every entry `cd`s to the repo
    root first so `.env` (dotenv), `channels/`, `data/brainrot.db`, `runs/`,
    and `logs/` all resolve. Replace `/Users/alex/code/project-brainrot` with
    your absolute repo path and run `mkdir -p logs` in the repo once before
    the first firing. If you would rather not set `PATH`, use the absolute
    binary path from `which pnpm` in each entry instead.
  - **The quota/cap day is UTC.** Daily tier quotas and the spend caps share
    the cost ledger's UTC day boundary, so "today" flips at midnight UTC —
    7 pm EST / 8 pm EDT, i.e. late afternoon/early evening US-Eastern — not at
    local midnight. Expect fresh quota slots and budget headroom in the early
    evening.
  - **Premium stays gated.** `produce-next` only claims premium topics you
    have approved (`pnpm brainrot topics approve <id>`) unless the channel
    TOML sets `auto_premium = true` under `[scout]`; volume flows unattended.
  - **Note (2026-07-25):** `pnpm brainrot topics approve` was removed — the
    'approved' topic status never actually gated production even before this
    doc's premium/volume tier was itself removed. See
    `docs/superpowers/specs/2026-07-25-retire-topic-approval-design.md`.
  - A `{"action":"noop","reason":"lease-held"}` tick is normal while a long
    render from the previous firing is still running.
  - **Manual runs take no lease.** `produce` and `resume` run outside the
    produce-next lease, so a hand-run invocation can execute concurrently with a
    live tick and both may act on the same job/topic. Stop the produce-next cron
    line (or wait for `lease-held` ticks to clear) before running `produce` or
    `resume` by hand. The same applies on the publishing side: `publish-next`
    takes its own `publish` lease (separate from `produce`'s), but
    `brainrot auth youtube`, `library approve`/`reject`, and
    `publish retry`/`mark-done` all run outside it — stop the publish-next
    cron line before running any of those by hand against the same channel.

  ## Tests

  ```bash
  pnpm test                   # unit + integration (mocked providers; real ffmpeg/Remotion)
  pnpm test:contract          # real paid calls, ~$0.20 total (FLUX image $0.05, MiniMax clip ~$0.10, ElevenLabs synth ~$0.01, one LLM call)
  pnpm test:contract:premium  # additionally renders one real Kling clip (~ $0.40 total)
  ```

  Media/render tests shell out to ffmpeg and run a real Remotion render; the first
  render downloads a headless Chrome shell.
  ```

  No test to run for this step — it is prose only. Move on to Step 2.

- [ ] **Step 2: Extend the golden-path loop test with the produce→publish handoff**

  This step composes units that Tasks 8–10 already implemented and
  unit-tested individually (`youtubeTarget`, the tokens DAO, `publishNextTick`
  and its lease/quota/candidate logic) — there is no new production code to
  make red-then-green here. Instead this cycle proves the composition with
  two real, distinguishable outcomes from the actual implementation: a tick
  run before any channel has a stored grant (must block on `no-auth`,
  proving the auth gate really guards the upload), then the same tick again
  after a grant is on file (must publish). Both assertions are expected to
  pass on the very first run.

  Replace the full contents of `src/jobs/golden-path-loop.test.ts` with:

  ```ts
  import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
  import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import path from 'node:path'
  import type Anthropic from '@anthropic-ai/sdk'
  import { loadChannelsDir } from '../config/channel.js'
  import { openDb } from '../db/index.js'
  import { listTopics } from '../scout/topics.js'
  import { scoutChannel } from '../scout/scout.js'
  import type { FetchLike } from '../scout/sources/types.js'
  import { produceNextTick } from '../loop/produce-next.js'
  import { publishNextTick } from '../loop/publish-next.js'
  import { parseTokenKey } from '../publish/crypto.js'
  import { upsertToken } from '../publish/tokens.js'
  import { YT_UPLOAD_SCOPE } from '../publish/youtube.js'
  import type { PlatformMeta, PublishTarget } from '../publish/types.js'
  import { STAGE_ORDER } from './types.js'
  import type { JobContext, StageDef, StageName, Tier } from './types.js'

  const cleanup: string[] = []
  function tmp(prefix: string): string {
    const d = mkdtempSync(path.join(tmpdir(), prefix))
    cleanup.push(d)
    return d
  }

  afterAll(() => {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // Reddit .rss fixture: the public Atom feed redditSource reads keylessly,
  // <entry><id> carrying the t3_ fullname. One post scores above the channel
  // threshold, one below.
  const REDDIT_FEED = `<?xml version="1.0" encoding="UTF-8"?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <id>/r/space/.rss</id>
    <title>/r/space</title>
    <entry>
      <id>t3_moon</id>
      <link href="https://www.reddit.com/r/space/comments/t3_moon/" />
      <title>Moon drifting away measured precisely</title>
    </entry>
    <entry>
      <id>t3_ad</id>
      <link href="https://www.reddit.com/r/space/comments/t3_ad/" />
      <title>Buy my telescope (ad)</title>
    </entry>
  </feed>`

  // Serves only r/space's feed; any other URL is a test bug, never a
  // silent live-network hit.
  const fetchImpl: FetchLike = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/r/space/.rss')) {
      return new Response(REDDIT_FEED, {
        status: 200,
        headers: { 'Content-Type': 'application/atom+xml' },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as FetchLike

  // The scorer's structuredCompletion consumes a forced 'emit' tool_use; the
  // response shape mirrors fakeClient in src/providers/anthropic.test.ts.
  function scoringClient(): { client: Anthropic; create: ReturnType<typeof vi.fn> } {
    const create = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          name: 'emit',
          id: 't1',
          input: {
            scores: [
              {
                candidateIndex: 0,
                score: 85,
                topic: 'The Moon is escaping Earth',
                reason: 'novel physics hook',
              },
              { candidateIndex: 1, score: 10, topic: 'Telescope ad', reason: 'commercial spam' },
            ],
          },
        },
      ],
      usage: { input_tokens: 1000, output_tokens: 200 },
    })
    return { client: { messages: { create } } as unknown as Anthropic, create }
  }

  // Fake happy-path stages (mirrors buildStages in runner.test.ts). runJob's
  // final library gate needs qc/qc.json parseable with a boolean `passed`
  // (missing or corrupt -> job 'failed', no library row), script/script.json
  // parseable when present (its platformMeta becomes library metadata), and
  // assemble/final.mp4 existing for JobResult.videoPath. passed=true ->
  // library state 'ready' (library-landed -> the claimed topic flips 'used').
  // Deliberately orchestration-scoped (spec §9): the loop invokes the same
  // runJob/stagesForTier as `produce`, so the real volume pipeline stays
  // covered by the existing golden-path test rather than re-rendered here.
  function fakeStagesFor(calls: StageName[]): (tier: Tier) => StageDef[] {
    return () =>
      STAGE_ORDER.map((name) => ({
        name,
        async run(ctx: JobContext) {
          calls.push(name)
          if (name === 'script') {
            writeFileSync(
              ctx.artifactPath('script', 'script.json'),
              JSON.stringify({
                hook: 'Did you know?',
                segments: [{ text: 'The Moon drifts away.', visualDirection: 'moon' }],
                platformMeta: {
                  youtube: { title: 'Moon', description: 'd', hashtags: ['#moon'] },
                  tiktok: { title: 'Moon', description: 'd', hashtags: ['#moon'] },
                  instagram: { title: 'Moon', description: 'd', hashtags: ['#moon'] },
                },
              }),
            )
          } else if (name === 'assemble') {
            writeFileSync(ctx.artifactPath('assemble', 'final.mp4'), 'FAKEMP4')
          } else if (name === 'qc') {
            writeFileSync(
              ctx.artifactPath('qc', 'qc.json'),
              JSON.stringify({ passed: true, checks: [] }),
            )
          } else {
            writeFileSync(ctx.artifactPath(name, `${name}.txt`), 'ok')
          }
        },
      }))
  }

  describe('golden-path loop e2e', () => {
    it('scouts a fixture feed into the topic queue, then one tick produces it into the library', async () => {
      const workspace = tmp('brainrot-loop-e2e-')
      const channelsDir = path.join(workspace, 'channels')
      const runsRoot = path.join(workspace, 'runs')
      mkdirSync(channelsDir, { recursive: true })
      mkdirSync(runsRoot, { recursive: true })

      // Real channel TOML incl. [scout] and [publish] — the same file
      // scoutChannel (loaded via loadChannelsDir here), produceNextTick, and
      // publishNextTick (via opts.channelsDir) all read. bg/bgm dirs are
      // schema-required strings; fake stages never read them. slots =
      // ["00:00"] is deliberately the earliest possible slot: it is <= any
      // local HH:MM, so the due-slot check below needs no assumption about
      // the test runner's timezone.
      writeFileSync(
        path.join(channelsDir, 'example.toml'),
        [
          'name = "example"',
          'niche = ["space facts", "astronomy"]',
          'script_model = "claude-sonnet-5"',
          // top-level keys must precede every [section] header (smol-toml scoping)
          'bg_dir = "assets/bg"',
          'bgm_dir = "assets/bgm"',
          '',
          '[tier_mix]',
          'volume = 2',
          'premium = 1',
          '',
          '[voice]',
          'volume = "af_heart"',
          '',
          '[caption_style]',
          'font = "Inter"',
          'font_size_px = 72',
          'active_color = "#FFD700"',
          'inactive_color = "#FFFFFF"',
          'stroke_px = 8',
          '',
          '[budget]',
          'per_video_usd = 8.0',
          'per_day_usd = 20.0',
          '',
          '[scout]',
          'subreddits = ["space"]',
          'min_score = 60',
          '',
          '[publish]',
          'slots = ["00:00"]',
          '',
        ].join('\n'),
      )

      // Determinism regardless of the developer shell: no FAL key (planTick
      // skips premium slots; the scouted candidate is unapproved anyway) and
      // the default global cap.
      vi.stubEnv('FAL_KEY', '')
      vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', '25')

      const db = openDb(path.join(workspace, 'brainrot.db'))
      const channels = loadChannelsDir(channelsDir)
      expect(channels.map((c) => c.name)).toEqual(['example'])

      // ── Scout: fixture feed → one batched scoring call → topic queue ────
      const { client, create } = scoringClient()
      const scout = await scoutChannel(db, channels[0], { client, fetchImpl })
      expect(scout.channel).toBe('example')
      expect(scout.fetched).toBe(2)
      expect(scout.queued).toBe(1)
      expect(scout.rejected).toBe(1)
      expect(scout.sourceErrors).toEqual([])
      expect(create).toHaveBeenCalledTimes(1)

      const candidates = listTopics(db, { channel: 'example', status: 'candidate' })
      expect(candidates).toHaveLength(1)
      const topic = candidates[0]
      // the reframed topic becomes the title; the raw headline is provenance
      expect(topic.title).toBe('The Moon is escaping Earth')
      expect(topic.rawTitle).toBe('Moon drifting away measured precisely')
      expect(topic.source).toBe('reddit:r/space')

      // scout spend ledgered under the sentinel (counts toward the global cap)
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM costs WHERE job_id = 'scout:example' AND operation = 'scout-score'",
          )
          .get(),
      ).toEqual({ n: 1 })

      // ── Produce: one tick claims the topic and lands it in the library ──
      const calls: StageName[] = []
      const tick = await produceNextTick(db, {
        channelsDir,
        runsRoot,
        stagesFor: fakeStagesFor(calls),
      })

      // Triage aid: on any non-landed outcome, surface the stage rows
      // instead of a bare field mismatch.
      if (tick.action !== 'produced' || tick.status !== 'ready') {
        const stageRows = tick.jobId
          ? db
              .prepare('SELECT stage, status, error FROM job_stages WHERE job_id = ?')
              .all(tick.jobId)
          : []
        throw new Error(`loop golden path did not land: ${JSON.stringify({ tick, stageRows })}`)
      }

      expect(tick.tier).toBe('volume')
      expect(tick.topicId).toBe(topic.id)
      expect(tick.jobId).toBeDefined()
      expect(calls).toEqual([...STAGE_ORDER])
      // the produce-next CLI prints this object verbatim as its one JSON line
      expect(JSON.parse(JSON.stringify(tick))).toEqual(tick)

      const job = db
        .prepare('SELECT channel, tier, topic, status FROM jobs WHERE id = ?')
        .get(tick.jobId!) as { channel: string; tier: string; topic: string; status: string }
      expect(job).toEqual({
        channel: 'example',
        tier: 'volume',
        topic: 'The Moon is escaping Earth',
        status: 'done',
      })

      const lib = db
        .prepare('SELECT state FROM library WHERE job_id = ?')
        .get(tick.jobId!) as { state: string } | undefined
      expect(lib?.state).toBe('ready')

      const used = db
        .prepare('SELECT status, job_id FROM topics WHERE id = ?')
        .get(topic.id) as { status: string; job_id: string }
      expect(used).toEqual({ status: 'used', job_id: tick.jobId })

      // the tick's lease was released in its finally
      expect(db.prepare('SELECT COUNT(*) AS n FROM leases').get()).toEqual({ n: 0 })

      // ── Publish: the ready video fills the channel's one due slot ───────
      // Client-credential and token-decryption env, read at call time by
      // publishNextTick exactly like every other env-sourced constant in
      // this codebase — never at module load.
      vi.stubEnv('YT_CLIENT_ID', 'test-client-id')
      vi.stubEnv('YT_CLIENT_SECRET', 'test-client-secret')
      vi.stubEnv('BRAINROT_TOKEN_KEY', 'a'.repeat(64))
      const tokenKey = parseTokenKey('a'.repeat(64))

      // slot "00:00" is due at any local wall-clock time, so this fixed
      // `now` makes no assumption about the test runner's timezone.
      const publishNow = () => new Date('2024-01-01T12:00:00Z')

      const uploadCalls: { videoPath: string; meta: PlatformMeta }[] = []
      const fakeTarget: PublishTarget = {
        platformId: 'youtube',
        async upload(req) {
          uploadCalls.push({ videoPath: req.videoPath, meta: req.meta })
          return { postId: 'fakeVideoId1', url: 'https://youtube.com/shorts/fakeVideoId1' }
        },
      }
      // Fakes only the token-mint call (threaded via opts.fetchImpl); the
      // fake target above fakes the upload itself, so no other URL is hit.
      const tokenFetchImpl = (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === 'https://oauth2.googleapis.com/token') {
          return new Response(JSON.stringify({ access_token: 'fake-access-token', expires_in: 3599 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        throw new Error(`unexpected fetch: ${url}`)
      }) as typeof fetch

      // Before any grant is on file, the due slot is blocked on auth — a
      // blocked candidate never claims its slot, so it stays open for the
      // next tick (verified below).
      const noGrant = await publishNextTick(db, {
        channelsDir,
        target: fakeTarget,
        fetchImpl: tokenFetchImpl,
        now: publishNow,
      })
      expect(noGrant).toEqual({ action: 'noop', reason: 'no-auth' })
      expect(uploadCalls).toEqual([])

      // Consent flow output (Task 9): an encrypted refresh token on file.
      upsertToken(db, 'youtube', 'example', 'rt-test-token', YT_UPLOAD_SCOPE, tokenKey)

      const published = await publishNextTick(db, {
        channelsDir,
        target: fakeTarget,
        fetchImpl: tokenFetchImpl,
        now: publishNow,
      })
      expect(published).toEqual({
        action: 'published',
        channel: 'example',
        platform: 'youtube',
        jobId: tick.jobId,
        slot: '00:00',
        postId: 'fakeVideoId1',
        url: 'https://youtube.com/shorts/fakeVideoId1',
      })
      expect(uploadCalls).toEqual([
        {
          videoPath: path.join(runsRoot, tick.jobId!, 'assemble', 'final.mp4'),
          meta: { title: 'Moon', description: 'd', hashtags: ['#moon'] },
        },
      ])

      const libAfterPublish = db
        .prepare('SELECT state FROM library WHERE job_id = ?')
        .get(tick.jobId!) as { state: string }
      expect(libAfterPublish.state).toBe('published')

      const publishRow = db
        .prepare('SELECT status, post_id, url FROM publishes WHERE job_id = ?')
        .get(tick.jobId!) as { status: string; post_id: string; url: string }
      expect(publishRow).toEqual({
        status: 'done',
        post_id: 'fakeVideoId1',
        url: 'https://youtube.com/shorts/fakeVideoId1',
      })

      // publish-next released its own lease too
      expect(db.prepare('SELECT COUNT(*) AS n FROM leases').get()).toEqual({ n: 0 })

      // ── Second tick: queue drained (the rejected topic is never eligible) ──
      const second = await produceNextTick(db, {
        channelsDir,
        runsRoot,
        stagesFor: fakeStagesFor([]),
      })
      expect(second).toEqual({ action: 'noop', reason: 'no-eligible-work' })

      db.close()
    })
  })
  ```

  Run it:

  ```bash
  npx vitest run src/jobs/golden-path-loop.test.ts
  ```

  Expected: passes on this first run — `Test Files  1 passed (1)` /
  `Tests  1 passed (1)`. A failure here means a wiring bug between the
  produce loop and the publish loop (e.g. a slot/day mismatch or a metadata
  mapping error), not missing code — every function called above already has
  its own unit tests from Tasks 2–10.

- [ ] **Step 3: Generate the tiny video fixture**

  `npx remotion ffmpeg` ships a stripped-down ffmpeg build that omits the
  `lavfi` demuxer and `testsrc` filter (`No such filter: 'testsrc'` /
  `Error opening input files: Filter not found` when tried) — it cannot
  generate a synthetic test pattern. Use the system `ffmpeg` already on
  `PATH` (a project prerequisite per the README's Prerequisites section)
  instead:

  ```bash
  mkdir -p src/publish/__fixtures__
  ffmpeg -y -f lavfi -i testsrc=duration=1:size=144x256:rate=15 -pix_fmt yuv420p src/publish/__fixtures__/tiny.mp4
  ```

  Verify it landed under the 100KB ceiling and decodes as an h264 9:16 clip
  (a fresh generation on this machine produced 4,793 bytes — exact byte
  count varies slightly by ffmpeg build, so check the ceiling, not an exact
  size):

  ```bash
  wc -c < src/publish/__fixtures__/tiny.mp4
  ffprobe -v error -show_entries stream=codec_name,width,height,duration -of default=noprint_wrappers=1 src/publish/__fixtures__/tiny.mp4
  ```

  Expected: the byte count printed is well under `100000`; ffprobe prints:

  ```
  codec_name=h264
  width=144
  height=256
  duration=1.000000
  ```

  This file is committed as a small binary fixture in Step 5 — no separate
  test exercises it in the default `npm test` run; it exists for the
  contract test in Step 4.

- [ ] **Step 4: Write the YouTube upload contract test**

  Same rationale as Step 2: this is a flag-gated live-API test with no
  implementation left to write (Task 8's `youtubeTarget`/`mintAccessToken`
  and Task 4's `loadRefreshToken` already exist and are unit-tested). Its
  only job is to skip cleanly with a clear reason when the operator hasn't
  supplied live credentials — which is exactly what happens in this
  environment (and any CI without a real Google Cloud project wired up), so
  the single run below is expected to pass via a skip, not a failure.

  Create `src/publish/youtube.contract.test.ts`:

  ```ts
  import 'dotenv/config'
  import { describe, it, expect } from 'vitest'
  import { fileURLToPath } from 'node:url'
  import { openDb } from '../db/index.js'
  import { parseTokenKey } from './crypto.js'
  import { loadRefreshToken } from './tokens.js'
  import { mintAccessToken, youtubeTarget } from './youtube.js'
  import type { PublishChannelConfig } from './types.js'

  // Runs only via `pnpm test:contract` (CONTRACT=1; excluded from default
  // `pnpm test`). Makes ONE real YouTube upload — private, ~5KB fixture —
  // then deletes it via the API, leaving the channel clean. Quota cost only
  // (~1,650 units for the upload + delete), no USD spend. Needs a real
  // per-channel grant already on file: run
  // `pnpm brainrot auth youtube --channel <CONTRACT_YT_CHANNEL>` against
  // BRAINROT_DB first (README's Publishing (YouTube) section).
  const REQUIRED_ENV = [
    'YT_CLIENT_ID',
    'YT_CLIENT_SECRET',
    'BRAINROT_TOKEN_KEY',
    'BRAINROT_DB',
    'CONTRACT_YT_CHANNEL',
  ] as const

  const fixturePath = fileURLToPath(new URL('./__fixtures__/tiny.mp4', import.meta.url))

  describe('youtube adapter (contract)', () => {
    it('uploads a private Short and deletes it via the real API', async (ctx) => {
      const missing = REQUIRED_ENV.filter((name) => !process.env[name])
      if (missing.length > 0) {
        ctx.skip(
          `youtube contract test needs ${missing.join(', ')} set — see README's Publishing (YouTube) section`,
        )
      }

      const db = openDb(process.env.BRAINROT_DB!)
      try {
        const key = parseTokenKey(process.env.BRAINROT_TOKEN_KEY)
        const channel = process.env.CONTRACT_YT_CHANNEL!
        const refreshToken = loadRefreshToken(db, 'youtube', channel, key)
        if (refreshToken === null) {
          ctx.skip(
            `no stored youtube refresh token for channel "${channel}" — run ` +
              `\`pnpm brainrot auth youtube --channel ${channel}\` against BRAINROT_DB first`,
          )
        }

        const accessToken = await mintAccessToken({
          refreshToken,
          clientId: process.env.YT_CLIENT_ID!,
          clientSecret: process.env.YT_CLIENT_SECRET!,
        })

        const publish: PublishChannelConfig = {
          slots: ['00:00'],
          platforms: ['youtube'],
          privacy: 'private',
          categoryId: 24,
          madeForKids: false,
        }
        const { postId, url } = await youtubeTarget().upload(
          {
            videoPath: fixturePath,
            meta: {
              title: 'brainrot contract test (private, auto-deleted)',
              description: '',
              hashtags: [],
            },
            publish,
          },
          accessToken,
        )

        expect(postId).toMatch(/^[A-Za-z0-9_-]{11}$/)
        expect(url).toBe(`https://youtube.com/shorts/${postId}`)

        const del = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${postId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        expect(del.status).toBe(204)
      } finally {
        db.close()
      }
    }, 120_000)
  })
  ```

  Run it exactly as an operator without live credentials would (this
  environment has none of the five env vars set):

  ```bash
  CONTRACT=1 npx vitest run src/publish/youtube.contract.test.ts
  ```

  Expected: `Test Files  1 passed (1)` / `Tests  1 skipped (1)` — the test
  skips via `ctx.skip(...)` on the missing-env check before touching the
  network or the fixture file. (An operator who has actually run
  `brainrot auth youtube --channel <name>` and exports all five vars gets a
  real upload+delete instead — that path is not exercised here.)

  Also confirm the default suite still ignores this file (contract tests are
  excluded from `include` unless `CONTRACT=1`, per `vitest.config.ts`):

  ```bash
  npx vitest run src/publish/youtube.contract.test.ts
  ```

  Expected: `No test files found, exiting with code 1` (the file is filtered
  out by the default `exclude: [..., 'src/**/*.contract.test.ts']`, same as
  every other `*.contract.test.ts` file in this repo).

- [ ] **Step 5: Full suite and commit**

  ```bash
  npm test
  ```

  Expected: every existing suite still passes, including the extended
  golden-path test from Step 2; the new contract test is excluded from this
  run (confirmed in Step 4).

  ```bash
  git add README.md src/jobs/golden-path-loop.test.ts src/publish/youtube.contract.test.ts src/publish/__fixtures__/tiny.mp4 && git commit -m "$(cat <<'EOF'
  docs: document YouTube publishing setup, cover produce->publish handoff

  README gains a Publishing (YouTube) section (Google Cloud setup, per-channel
  auth, [publish] TOML, quota) and merges publish-next into the cron block.
  The golden-path test now carries a produced video through publishNextTick
  end to end, and a CONTRACT=1-gated contract test exercises a real upload +
  delete against the live YouTube API when credentials are supplied.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```
