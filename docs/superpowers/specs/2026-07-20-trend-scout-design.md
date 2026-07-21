# Trend Scout Loop & Production Automation — Design (Plan 3)

Date: 2026-07-20
Status: Approved (brainstormed section-by-section with Alex; all five sections accepted)
Parent: `2026-07-18-brainrot-machine-design.md` §3 (scout + production loops), §7 (topics table)
Builds on: main after the Plan 2 merge and real-run shakedown fixes (`f10b50a`)

## 1. Overview

Plan 3 turns the manual `produce` pipeline into a self-feeding loop: trend sources are
scraped and scored into a topic queue, and a cron-driven production loop consumes that
queue within each channel's daily tier mix — volume unattended, premium behind an
operator approval gate. It also delivers the `brainrot resume` CLI deferred from Plan 2
and a plain-stdout daily digest.

Publishing remains Plan 4. The whole stage pipeline, runner, budget system, and
providers are reused untouched; loop code calls `createJob`/`runJob`/`stagesForTier`
exactly as `produce` does.

## 2. Decisions of record

| Decision | Choice | Why |
|---|---|---|
| Execution model | Cron-invoked CLI commands, one short-lived process per invocation | In-process budget reservations stay sound; sidesteps onnxruntime teardown noise; fresh state per run. Daemon rejected. |
| Loop granularity | `produce-next` does ONE unit of work (one resume or one produce) per invocation | Short processes, minimal lease window, output spreads across the day; cron cadence controls throughput. Batch-per-invocation and combined scout+produce tick rejected. |
| Trend sources v1 | Reddit public JSON + RSS/Atom, behind a `TrendSource` interface | Zero keys, zero flaky dependencies. Google Trends deferred (no official API; scraping libs unmaintained). |
| Scoring | One batched Haiku call per channel per scout run (`claude-haiku-4-5`, constant — not configurable; the alias, matching the provider `PRICE_TABLE` key) | Ranking/filtering task, not creative writing; cost rounds to zero. Sonnet and per-channel model knob rejected as YAGNI. |
| Autonomy | Volume auto-produces; premium requires operator-approved topics, per-channel `auto_premium = true` lifts the gate | Caps bound damage in dollars, not in wasted doomed videos; premium is only a few real runs old. |
| Auto-resume | Loop auto-resumes `blocked` (budget-parked) jobs when headroom returns; `failed` jobs are manual-only via `brainrot resume` | Blocked jobs were healthy by definition; failures deserve eyes before more spend. |
| Digest | `brainrot digest` prints to stdout only; operator wires delivery (cron MAILTO etc.) | Alex's choice — no notification integrations in v1. |

## 3. Architecture

```
cron ──▶ brainrot scout          (few times/day)
           sources → Haiku scoring → topics table (dedupe)
cron ──▶ brainrot produce-next   (every ~20–30 min)
           one unit: resume blocked job | claim topic → produce → library
operator ▶ brainrot topics list|approve|reject     (premium gate)
operator ▶ brainrot resume <jobId>                 (failed jobs, manual)
cron ──▶ brainrot digest          (daily; stdout only)
```

- **`brainrot scout`** — for each channel TOML with a `[scout]` section: fetch
  candidates from its sources, filter already-known items, score the rest in one
  batched Haiku call against the channel niche, insert into `topics`. Exits.
- **`brainrot produce-next`** — one unit of work under an overlap lease (§6). No-op
  exit when nothing is eligible.
- **`brainrot resume <jobId>`** — manual re-entry for `failed` (and `blocked`) jobs;
  reuses the runner's skip-done-stages resume and premium per-scene resume.
- **`brainrot topics`** — `list [--channel] [--status]`, `approve <id...>`,
  `reject <id...>`.
- **`brainrot digest`** — last-24h summary (§7).

All commands take `--db` (default resolution as today) and, where relevant,
`--runs-root` and `--channels-dir` (default `channels/`).

## 4. TrendSource interface, sources, channel config

New module family under `src/scout/`.

```ts
// src/scout/sources/types.ts
interface TrendCandidate {
  title: string        // raw headline/post title
  url: string          // canonical link (Reddit permalink, RSS item link)
  sourceId: string     // e.g. "reddit:r/space", "rss:feeds.sciencedaily.com"
  externalId: string   // stable per-item identity: Reddit fullname (t3_xyz), RSS guid/id, else link
}

interface TrendSource {
  readonly id: string  // = sourceId above
  fetch(opts: { limit: number; timeoutMs: number }): Promise<TrendCandidate[]>
}
```

`externalId` feeds the dedupe hash and must be stable across fetches of the same item.

**RedditSource** — hot listing per subreddit with a descriptive User-Agent.
AMENDED 2026-07-21 after live testing: reddit 403s the unauthenticated public
JSON endpoint from most residential IPs, so the adapter uses app-only OAuth
(script app, `client_credentials` grant via `REDDIT_CLIENT_ID` /
`REDDIT_CLIENT_SECRET`, token cached per process) against
`oauth.reddit.com/r/<sub>/hot?limit=<N>` when the creds are set, falling back
to `www.reddit.com/r/<sub>/hot.json` when they are absent. Extracts
`data.children[].data`: `title`, `name` (fullname → `externalId`), `permalink`
(prefixed with `https://www.reddit.com`). Skips stickied posts. (The original
"zero keys" decision survives as the fallback; the keys are free and the 100
requests/min app allowance dwarfs our 3 fetches/day.)

**RssSource** — fetches a feed URL and parses both RSS 2.0 and Atom via
`fast-xml-parser` (the one new dependency: pure, maintained; no heavyweight feed lib).
`externalId` = `guid` (RSS) / `id` (Atom), falling back to the item link.

**Fetch discipline:** per-source timeout (default 10 000 ms) and error isolation —
a source that fails or times out logs a warning and contributes zero candidates; the
run continues. A run where ALL sources across all channels fail exits 1 (systemic).
No per-source retries in v1: the next cron firing is the retry.

**Channel TOML `[scout]` section:**

```toml
[scout]
subreddits = ["space", "askscience"]
rss = ["https://www.sciencedaily.com/rss/space_time.xml"]
min_score = 60           # scoring threshold, default 60
per_source_limit = 25    # candidates fetched per source, default 25
auto_premium = false     # true lifts the premium approval gate (default false)
```

A channel with no `[scout]` section or with empty source lists is skipped by the
scout; manual `produce` still works for it. The config loader supplies a complete
default `[scout]` (empty sources, `min_score` 60, `per_source_limit` 25,
`auto_premium` false) so existing TOMLs remain valid. `auto_premium` lives in
`[scout]` because it governs how scouted topics become jobs.

## 5. Scoring, topics table, dedupe

**Scoring call** — one `structuredCompletion` per channel per scout run, model
`claude-haiku-4-5` (module constant; the alias — it is the `PRICE_TABLE` key in
`src/providers/anthropic.ts`, so cost computation resolves). Prompt inputs: the deduped candidate
list (raw title + sourceId), the channel's `niche` keywords, and the titles of the
channel's last 30 non-rejected topics labeled "recently covered — score near-duplicates 0."
Strict-schema output per candidate:

```ts
{ candidateIndex: number, score: number /* 0–100 */,
  topic: string  /* reframed as a video topic, imperative/hooky */,
  reason: string /* one line, shown in `topics list` */ }
```

The reframed `topic` becomes the eventual job topic; the raw headline is kept for
provenance. Candidates with `score < min_score` are stored as `rejected` —
remembering them means the hash filter drops them before scoring on every later run
(sources still return them; they just never reach Haiku again).

**Topics table** (appended to `schema.sql`; `CREATE TABLE IF NOT EXISTS`, so existing
DBs pick it up on next open — no migration machinery):

```sql
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL, title TEXT NOT NULL,      -- reframed topic
  raw_title TEXT NOT NULL, source TEXT NOT NULL,   -- provenance (sourceId)
  url TEXT NOT NULL, dedupe_hash TEXT NOT NULL,    -- sha256(sourceId + '\n' + externalId)
  score INTEGER NOT NULL, reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate','approved','claimed','used','rejected')),
  job_id TEXT,                                     -- set at claim
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (channel, dedupe_hash)
);
```

**Dedupe is two-layer:**
1. Exact: `INSERT OR IGNORE` on `(channel, dedupe_hash)`; additionally, known hashes
   are filtered out BEFORE the Haiku call, so scoring cost shrinks across the day and
   scout re-runs are free.
2. Semantic: the scorer's recent-topics list instructs it to score
   new-post-same-story candidates 0 (which lands them `rejected`).

No freshness TTL in v1. `produce-next` claims highest-score-first and the digest
shows queue depth; if stale topics become a real problem, expiry is a one-line WHERE
clause later.

**Lifecycle:** `candidate` → (`topics approve`) → `approved` → (claim) → `claimed` →
(job lands in library) → `used`. `topics reject` applies to `candidate`/`approved`.
Volume claims take `candidate` or `approved`; premium claims require `approved`
unless the channel sets `auto_premium`.

**Scout spend is ledgered:** the Haiku call's cost is recorded in `costs` with
sentinel `job_id = 'scout:<channel>'` (FKs are off by design, so the non-job id is
accepted). The global daily cap sums all of `costs` and therefore includes scout
spend; per-channel-day caps JOIN through `jobs` and do NOT see it — accepted at
~$0.01/day scale.

## 6. Production loop, claiming, resume

**Overlap lease** — new `leases` table: `name TEXT PRIMARY KEY, holder TEXT NOT NULL,
expires_at TEXT NOT NULL`. `produce-next` atomically acquires the `produce` lease
(acquire-if-free-or-expired in one transaction; better-sqlite3 is synchronous) and
releases it in a `finally`. TTL 90 minutes — generously above any single job — so a
crashed holder self-heals by expiry. A tick that finds the lease held exits 0
immediately; that is the NORMAL case while a premium render from the previous firing
is still running.

**`produce-next` algorithm** (one unit, then exit):

1. Acquire lease, else no-op exit (`reason: "lease-held"`).
2. **Resume pass:** the oldest `blocked` job (any channel) whose channel-day ledger
   has ≥ `RESUME_MIN_HEADROOM_USD` (constant, default 2) remaining and whose global
   cap has headroom → re-run via the existing runner (skip-done stages + per-scene
   resume recover the sunk cost). Premium `blocked` jobs are skipped when `FAL_KEY`
   is absent — resuming one without the key would only convert a healthy parked job
   into a `failed` one. That is the tick's unit.
3. **Claim pass:** channels are enumerated as `<channels-dir>/*.toml` (scout uses
   the same enumeration). Per channel, count jobs created today (UTC — the same day
   boundary as the budget code) per tier, counting ALL statuses: a failed job still
   consumed its slot, which stops a deterministic failure from burning the whole
   day's budget on retries. Pick the channel with the lowest filled fraction of its
   `tier_mix` (tie → alphabetical). Within it, fill the PREMIUM slot first when an
   eligible topic exists (`approved`, or any per `auto_premium`) — scarce quality
   slots get the day's best material early — else the volume slot with the
   highest-scored eligible topic (tie → oldest). If `FAL_KEY` is absent, premium
   slots are skipped with a log line; volume still flows.
4. Claim = one UPDATE setting `status='claimed', job_id=<new id>`, then
   `createJob` + `runJob(stagesForTier(tier))` exactly as `produce`. Outcomes:
   job lands in library → topic `used`; job `failed`/`blocked` → topic stays
   `claimed`, bound to its job — the resume path owns recovery; the topic is never
   re-claimed or lost.
5. Print exactly one JSON summary line to stdout (what happened: resumed jobId /
   produced jobId+topicId+tier / no-op reason). Exit codes mirror `produce` (0 for
   ready/needs-review and benign no-ops; 1 for failed/blocked).

**`brainrot resume <jobId>`** — loads the job row, resolves its channel config as
`<channels-dir>/<channel>.toml` (clear error if the file is missing), runs the
premium `FAL_KEY` preflight when `tier = 'premium'`, then re-runs
`runJob(stagesForTier(tier))`. Accepts `failed` and `blocked`. A job stuck in
`running` (crashed process mid-run) requires `--force` — the operator asserting no
live process holds it. On success, any topic whose `job_id` matches flips to `used`.
Exit codes mirror `produce`.

**Zombie visibility:** the digest flags jobs `running` for more than 2 hours as
"probably crashed — resume with --force". Auto-resume never touches `running` or
`failed` jobs.

## 7. Digest & scheduling

**`brainrot digest`** — plain stdout, last 24 h (UTC), all channels:

- topics scouted → queued (`candidate`/`approved`) / `rejected`, per channel
- jobs produced per tier with outcomes (ready / needs-review / failed / blocked)
- spend per channel-day and global-day, each against its cap
- action items: `failed` jobs awaiting manual resume; zombie `running` jobs (>2 h);
  `approved` premium queue depth; `candidate` topics awaiting approval

Always exits 0 — it is a report, not a check. Delivery is the operator's wiring
(cron `MAILTO`, pipe to a notifier, etc.).

**README scheduling section** — a paste-ready crontab block (scout 3×/day,
`produce-next` every 25 min, digest daily) with macOS cron realities spelled out:
absolute binary paths (cron's PATH is bare), `cd` into the repo so dotenv and
`channels/` resolve, and the note that quota/cap "today" is UTC, so the day rolls
over in the late local afternoon. No launchd plists in v1.

## 8. Hardening

- **Scout idempotency:** re-running never double-inserts (UNIQUE + INSERT OR IGNORE)
  or re-scores known items (pre-Haiku hash filter); a mid-run crash loses only that
  run's unscored candidates.
- **Bounded prompts:** per-source isolation plus the hard cap of Σ`per_source_limit`
  candidates per channel per Haiku call.
- **Scout budget gate:** the Haiku call is asserted against the GLOBAL daily cap
  before spending. `assertBudget` bundles per-video/channel-day/global-day checks
  around a real job, which the scout doesn't have — so the global-day check is
  extracted into a helper the scout calls directly (verified: the global-day query
  sums ALL `costs` rows with no jobs JOIN, so sentinel scout rows count toward it).
  A runaway cron cannot nickel-and-dime past the ceiling.
- **No orphan jobs:** `produce-next` never creates a job it cannot start; lease held /
  no eligible topic / missing FAL_KEY each produce a distinct clean no-op JSON reason.
- **Crash self-healing:** lease expiry (90 min) recovers loop overlap after a crash;
  claimed-topic ↔ job binding guarantees no topic is lost or double-produced.

## 9. Testing

House pattern throughout: real SQLite, fixture HTTP payloads, mocked providers.

- **Source parsers:** saved Reddit JSON and RSS 2.0 + Atom XML fixtures, including
  malformed-feed, stickied-post skip, and timeout paths.
- **Scorer:** batched call shape, threshold routing (`candidate` vs `rejected`),
  recent-topics dedupe instruction present in the prompt, cost ledgering under the
  `scout:<channel>` sentinel.
- **Claim logic (table-driven):** quota counting across all statuses, premium-first
  ordering, approval gate vs `auto_premium`, lowest-filled-fraction channel
  fairness, UTC day edges.
- **Lease:** contention (second acquire no-ops), expiry takeover, release on failure
  paths.
- **Resume CLI:** failed and blocked resume, `--force` for `running`, missing
  channel TOML error, topic flip to `used`.
- **Golden path extended:** scout-from-fixtures → topics rows → `produce-next`
  claims → fake stages via the loop's stage-injection seam → library `ready` +
  topic `used`. Deliberately orchestration-scoped: the loop invokes the same
  `runJob`/`stagesForTier` the `produce` command does, and the real volume
  pipeline stays covered by the existing golden-path test — a second full
  Remotion render per suite run buys little for its cost.
- **No new contract tests:** the scout reuses `structuredCompletion`, already
  contract-proven against the real API.

## 10. Out of scope (deferred)

- Publishing loop and platform adapters — Plan 4.
- Google Trends (or any additional) source — bolt onto `TrendSource` later.
- Notification delivery (macOS notify, email, etc.) — digest is stdout only.
- Analytics feedback loop biasing the scout — v2 per parent design.
- Daemon mode / launchd plists.
- Topic freshness TTL / expiry (`expired` status) — revisit if stale queues appear.
- Per-channel scout model configuration — Haiku constant for now.
