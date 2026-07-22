# Publishing Loop — Design Spec (Plan 4)

Date: 2026-07-22. Parent: `2026-07-18-brainrot-machine-design.md` §6–7. Predecessors: premium pipeline (Plan 2, merged), trend scout loop (Plan 3, merged).

## 1. Purpose

Close the machine's loop: `ready` videos in the library get uploaded to YouTube Shorts on a per-channel schedule, unattended. After this plan the system runs end-to-end — scout → produce → publish → digest — with Alex's involvement reduced to reading the digest, approving `needs-review` items, and periodic topic curation.

## 2. Decisions of record

| # | Decision | Choice |
|---|---|---|
| 1 | Platform scope | **YouTube Shorts only**, but `PublishTarget`, the `publishes` table, and the scheduler are platform-agnostic. TikTok / Instagram are separate future plans gated on Alex's external setup (TikTok audit, IG Business account). |
| 2 | Base | `main` (Plans 1–3 merged; HEAD a5c7d14 at time of writing). |
| 3 | Token storage | Refresh token encrypted with AES-256-GCM in `oauth_tokens`; key = `BRAINROT_TOKEN_KEY` (32 bytes, hex) in `.env`. `node:crypto` only — no new dependency. Alex performs all interactive consent; the assistant never handles credential values. |
| 4 | Publish gate | **Auto-publish `ready`.** `needs-review` stays parked until `brainrot library approve`. Channel cadence is the volume control. |
| 5 | Cadence | Fixed **machine-local** slot times per channel in TOML (`publish.slots = ["10:00","14:00","19:00"]`). A slot missed while the machine slept fills late the same day; unfilled slots lapse at local midnight — no makeup posts. |
| 6 | Loop shape | Separate `brainrot publish-next` cron tick (~every 15 min), its own `publish` lease row, **one upload per tick**. |
| 7 | Failure policy | Any attempt — success or failure — **consumes its slot**; a failed video retries no earlier than the next slot (parent §6). No in-tick retries: the next slot is the retry. |
| 8 | Poison-video guard | Eligibility orders by **fewest failed attempts first, then newest** (spreads attempts during channel-wide outages); a job with `MAX_PUBLISH_ATTEMPTS` (3) failures of kind **`rejected`** leaves the pool and is digest-flagged. Only `rejected` counts toward the cap — `auth`/`quota`/`transient` failures are channel- or platform-wide, not the video's fault. |
| 9 | Freshness | Within the same attempt count, **newest `ready` first** (trend content decays). Stranded old rows are reported by the digest (count + oldest age); pruning is out of scope. |
| 10 | Platform quota | `BRAINROT_YT_UPLOADS_PER_DAY` (default 6) is a hard pre-upload gate counted across **all channels** — YouTube quota is per Google Cloud project (~10k units/day, 1 600/upload), not per channel. |
| 11 | Disclosure | Every upload sets YouTube's synthetic-media disclosure. Always on; **no config to disable**. |
| 12 | Interrupted uploads | A tick that dies mid-upload leaves `interrupted` — never auto-retried (the upload may have landed; duplicates are expensive at 6/day). Digest instructs: check YouTube Studio, then `brainrot publish retry <job>` or `brainrot publish mark-done <job> <postId>`. |
| 13 | Time domains | Slot bookkeeping (`publishes.day`, due-slot math) uses the **machine-local** date/time. All existing budget/cost code stays on UTC days. Two deliberately distinct concepts — do not unify. |

## 3. Data model

### 3.1 `publishes` — one row per upload attempt

```sql
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
```

- The `UNIQUE (channel, platform, day, slot)` constraint **is** the slot bookkeeping: any attempt row consumes the slot.
- `claimed` = upload in flight. `done` = success (`post_id`, `url` set; library row flipped to `published` in the same transaction). `failed` = platform/file error; video stays `ready` and re-enters the pool per decisions 7–8. `interrupted` = repair sweep found a stale claim (decision 12).
- `attempt` = 1 + count of existing rows for that (job_id, platform).

### 3.2 `oauth_tokens` — one row per platform × channel

```sql
CREATE TABLE IF NOT EXISTS oauth_tokens (
  platform TEXT NOT NULL,
  channel TEXT NOT NULL,
  token_ciphertext BLOB NOT NULL,   -- iv (12B) || gcm tag (16B) || ciphertext
  scopes TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (platform, channel)
);
```

Only the long-lived **refresh token** is stored. Access tokens (≈1 h lifetime) are minted per tick and never persisted. Each YouTube channel is its own brand account and needs its own consent grant, hence per-channel rows.

### 3.3 Channel TOML `[publish]` section

Absent `[publish]` → the channel never publishes (same safe-default pattern as `[scout]`).

```toml
[publish]
slots = ["10:00", "14:00", "19:00"]  # required, non-empty; machine-local HH:MM, unique, zero-padded 24h
platforms = ["youtube"]              # v1: exactly ['youtube'] is the only valid value
privacy = "public"                   # 'public' | 'unlisted' | 'private'; default 'public'
category_id = 24                     # YouTube category; default 24 (Entertainment)
made_for_kids = false                # default false
```

Config validation mirrors `[scout]`: parsed into a frozen `PublishConfig` with defaults applied; malformed values are load-time errors.

## 4. Auth & token crypto

### 4.1 One-time setup (Alex, by hand)

Google Cloud project → enable YouTube Data API v3 → OAuth client type **Desktop app** → `YT_CLIENT_ID` and `YT_CLIENT_SECRET` into `.env` → generate `BRAINROT_TOKEN_KEY` (README documents: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).

### 4.2 `brainrot auth youtube --channel <name>` (interactive; run once per channel)

1. Start a loopback HTTP listener on an ephemeral `127.0.0.1` port (Desktop-app clients accept any loopback port — no redirect URI registration).
2. Open the system browser to Google's consent URL. Scope: `https://www.googleapis.com/auth/youtube.upload` only (least privilege).
3. During consent Alex picks the **brand account** for the channel — that binds the grant to the right YouTube channel. The CLI cannot verify the binding (no readonly scope); the README notes that picking the wrong account is fixed by re-running the command.
4. Exchange the code, encrypt the refresh token (fresh random 12-byte IV per encryption; store `iv || tag || ciphertext`), upsert the `oauth_tokens` row.
5. Print confirmation with scopes granted — **never token material**.

Re-running re-consents and overwrites the row; that is also the recovery path for expired/revoked grants (`invalid_grant`).

### 4.3 Crypto module

`encryptToken(plaintext, key)` / `decryptToken(blob, key)` over AES-256-GCM via `node:crypto`. Key parsed from 64-char hex; wrong length is a config error. GCM auth-tag failure (tampered/corrupt blob, wrong key) throws — surfaced as the `no-auth` noop path, never a crash.

## 5. `PublishTarget` interface & YouTube adapter

```ts
interface PublishTarget {
  readonly platformId: string   // 'youtube'
  upload(req: {
    videoPath: string
    meta: PlatformMeta            // title / description / hashtags from library.metadata_json
    publish: PublishConfig        // privacy, category_id, made_for_kids
  }, accessToken: string): Promise<{ postId: string; url: string }>
}
```

YouTube implementation — direct HTTPS (fetch), **no Google SDK** (consistent with every other provider adapter):

- `mintAccessToken(refreshToken, env)` — exported separately from `upload`; the tick calls it first (POST to Google's token endpoint), then passes the access token into `upload()`. Refresh rejection maps to `kind: 'auth'`.
- `videos.insert` with the resumable-upload protocol: initiate (metadata JSON + `uploadType=resumable`), then PUT the video bytes. A failed upload is abandoned, not resumed — the next slot starts a clean session (decision 7).
- Metadata mapping: `snippet.title` = `meta.title` as-is (already ≤90 chars); `snippet.description` = description + blank line + hashtags space-joined; `snippet.tags` = hashtags with `#` stripped; `snippet.categoryId`; `status.privacyStatus`; `status.selfDeclaredMadeForKids`; synthetic-media disclosure field set true (exact field name pinned at implementation against current API docs — it postdates older client examples).
- Returns `postId` = video id, `url` = `https://youtube.com/shorts/<id>`.

**Error taxonomy** — `PublishError` with `kind`:

| kind | Trigger | Tick handling |
|---|---|---|
| `auth` | token refresh rejected (`invalid_grant`, 401) | attempt `failed` with `auth:` prefix; digest says re-run `brainrot auth` |
| `quota` | `uploadLimitExceeded` / `quotaExceeded` | attempt `failed`; digest flags distinctly (cap vs reality drift) |
| `rejected` | 4xx: invalid metadata, unsupported file | attempt `failed`; permanent in practice — attempt cap (decision 8) retires it |
| `transient` | 5xx, network, timeouts | attempt `failed`; next slot retries |

Local file missing (`ENOENT` on the video path) maps to `rejected`.

## 6. The `publish-next` tick

Cron: `*/15 * * * *`. One JSON line on stdout, always (same contract as `produce-next`): `{outcome: 'published'|'publish-failed'|'noop'|'dry-run', reason?, channel?, jobId?, slot?, postId?, url?, error?}` (`dry-run` only under `--dry-run`). Exit 0 for `published` and every noop; exit 1 for `publish-failed`. Config/DB errors: stderr, nonzero, no JSON line.

Order of operations:

1. **Lease** — acquire `publish` lease (`PUBLISH_LEASE_TTL_MS = 1_800_000`). Held → noop `lease-held`.
2. **Repair sweep** — `claimed` rows older than the TTL → `interrupted` (idempotent; publish-analog of the topic repair sweep).
3. **Due slots** — for each channel with `[publish]` and each configured platform: slots with time ≤ local now and no `publishes` row for (channel, platform, local-today, slot). None anywhere → noop `no-due-slot`.
4. **Platform quota gate** — today's youtube rows that plausibly hit the upload endpoint — `claimed`/`done`/`interrupted` plus `failed` rows whose `error_kind` is not `auth` (auth failures never reach `videos.insert`; a failed insert still burns its 1 600 units) — ≥ `BRAINROT_YT_UPLOADS_PER_DAY` → noop `platform-quota`.
5. **Channel pick** — lowest filled-fraction (slot-consuming rows today, any status, ÷ slots), tie → earliest due slot, tie → channel name ASC (determinism).
6. **Video pick** — `library.state = 'ready'`, job's channel matches; exclude jobs with any `done`/`claimed`/`interrupted` row for this platform; exclude jobs with ≥ `MAX_PUBLISH_ATTEMPTS` (3) `failed` rows of `error_kind = 'rejected'`. Order: fewest `failed` rows (any kind) ASC, then `created_at` DESC, then `job_id` ASC. None → noop `no-ready-video` (slot stays open for later ticks today).
7. **Token** — load + decrypt for (platform, channel). Missing row or decrypt failure → noop `no-auth` (nothing consumed; digest-visible).
8. **Claim** — insert `claimed` row (slot consumed by the UNIQUE constraint; a conflict here means a racing tick won — noop `claim-conflict`, a defensive exit that should be unreachable under the lease).
9. **Upload** via adapter. **Success**: one transaction sets `done` + `post_id`/`url` + `finished_at` and flips library → `published` (no crash window between the two facts). **Failure**: `failed` + error + `finished_at`; library stays `ready`.
10. Emit the JSON line, release the lease (finally-style, as `produce-next` does).

Time is injected (`now: () => Date` seam) — slot logic fully testable with a fake clock. Slot comparison is string `HH:MM` against local wall-clock; local date via local-timezone formatting of `now()`. DST notes: slots are daytime posting times; the 02:00–03:00 anomalies are documented as out of blast radius, not handled specially.

**Dry-run**: `brainrot publish-next --dry-run` computes steps 3–7 **with zero DB writes** (no lease, no repair sweep, no claim) and prints one JSON line `{outcome:'dry-run', wouldPublish: {channel, slot, jobId, title} | null, reason?}`.

## 7. CLI surface (additions to `src/cli.ts`)

| Command | Behavior |
|---|---|
| `brainrot auth youtube --channel <name>` | Interactive consent flow (§4.2). |
| `brainrot publish-next [--dry-run]` | The tick (§6). |
| `brainrot publish retry <jobId>` | `interrupted` → `failed` (error annotated `manually cleared`), returning the job to the pool. Refuses if the job has no `interrupted` row. |
| `brainrot publish mark-done <jobId> <postId>` | `interrupted` → `done` with the given post id (URL derived), library → `published`, same-transaction. For when Studio shows the upload landed. |
| `brainrot publishes list [--day N]` | Attempt history (default last 7 days): job, channel, day+slot, status, attempt, URL/error. |
| `brainrot library list [--state <s>] [--channel <c>]` | Library rows with state, age, title. |
| `brainrot library approve <jobId...>` | `needs-review` → `ready` (enters publish pool). Parse/validate conventions of `topics approve`. |
| `brainrot library reject <jobId...>` | `needs-review` → `blocked`. Also accepts `ready` (pull a video from the pool / retire an attempt-capped one). |

## 8. Digest additions

New "Publishing" section in `brainrot digest` (same always-exit-0 contract):

- Published today: channel, title, slot, URL.
- Failed attempts with error kind; `auth` failures get an explicit "run `brainrot auth youtube --channel <x>`" line; `quota` failures flagged distinctly.
- `interrupted` rows with the check-Studio instruction (decision 12).
- Attempt-capped jobs (≥3 `rejected` failures, still `ready`): suggest `library reject <job>` to retire them.
- Ready-backlog pressure: count of unpublished `ready` rows + oldest age (LIFO strand visibility).
- Slots that lapsed unfilled yesterday (cadence outrunning production).

## 9. Testing

TDD throughout, per house rules. No new test infrastructure.

- **Unit**: slot due-logic with a fake clock (before/after slot, day rollover, late fill, all consumed); claim uniqueness under conflict; repair-sweep idempotency; token crypto round-trip + GCM tamper rejection + wrong-key-length config error; error-taxonomy mapping from canned YouTube error bodies; metadata mapping (hashtag folding into description and tags, title passthrough); `[publish]` config validation and freezing.
- **Tick-level**: `publish-next` against a temp DB with a fake adapter — every noop reason, success transaction (publishes + library flip atomically), failure path, attempt-cap exclusion, fairness pick, `--dry-run` writes nothing (assert via DB snapshot).
- **Contract test** (flag-gated, manually run): one real upload of a tiny fixture video as **private**, assert post id returned, then delete it via the API (≈1 650 units total). This is the Plan-3 lesson: the live API is where the surprises are — field names, disclosure flag, resumable handshake.
- **Golden-path loop test**: extend to produce → publish handoff with the fake adapter (library `ready` row from a real produce path gets published by a tick).

## 10. Out of scope (v1 of this plan)

TikTok and Instagram adapters (interface ready; each a future plan gated on Alex's external setup — apply for the TikTok audit early); analytics/view-count feedback; thumbnail generation; YouTube quota-increase request (README links the form); `library prune`; makeup posts for lapsed slots; multi-account-per-channel; daemon/web UI.

## 11. Risks & notes

- **YouTube quota** (~6/day project-wide) is the binding constraint on total cadence across channels; the README says so next to the crontab.
- **Synthetic-media disclosure field name** must be pinned against live API docs at implementation time (§5); the contract test asserts it round-trips.
- **Brand-account binding** is unverifiable with the upload-only scope (§4.2); wrong-account mistakes are recoverable by re-auth, and the first digest with a wrong channel URL makes them visible.
- **Encryption honesty**: AES-GCM with the key in `.env` protects a copied DB file, not an attacker with full machine access — the same trust level as `.env` itself (decision 3).
- **Clock skew / sleep**: a Mac asleep across a slot publishes late the same day by design; a Mac asleep past midnight lapses the slot — the digest's lapsed-slot line is the signal to adjust cadence or wake settings.
