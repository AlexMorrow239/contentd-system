# Trend Scout Loop & Production Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the manual `produce` pipeline into a self-feeding loop: cron-driven trend scouting into a scored topic queue, a one-unit-per-tick production loop with an operator approval gate on premium, the `brainrot resume` CLI deferred from Plan 2, and a stdout daily digest.

**Architecture:** Two new module families — `src/scout/` (TrendSource adapters, batched Haiku scoring, topics DAO) and `src/loop/` (lease, tick planner, produce-next executor, digest) — plus small extractions from existing modules (`costs.ts` day-spend helpers, `cli.ts` → `src/jobs/pipeline.ts`). All loop code calls the existing `createJob`/`runJob`/`stagesForTier` pipeline unchanged. Every command is a short-lived cron-invoked process; a DB lease serializes production ticks.

**Tech Stack:** TypeScript ^5.9 (pinned — TS7 breaks Remotion's esbuild-loader), strict ESM NodeNext (`.js` suffixes on relative imports in src/), vitest 4, better-sqlite3 v12 (synchronous; FKs deliberately OFF), zod v4, commander, `fast-xml-parser` (the ONE new dependency), existing `structuredCompletion` Anthropic machinery.

**Spec:** `docs/superpowers/specs/2026-07-20-trend-scout-design.md` (binding; parent design `2026-07-18-brainrot-machine-design.md` §3/§7 for background).

## Global Constraints

Every task's requirements implicitly include all of these.

- **TDD every task:** write the failing test, run it and observe the failure, implement minimally, run to green, commit. Test commands: `pnpm vitest run <file>` (never watch mode). Whole-suite + `pnpm tsc --noEmit` gates at each task's end.
- **ESM discipline:** relative imports inside `src/` carry `.js` suffixes. NodeNext resolution.
- **Money is integer micro-USD everywhere.** Never floats in ledgers or comparisons.
- **UTC day boundaries:** "today" is `substr(created_at, 1, 10) = strftime('%Y-%m-%d','now')` — identical to the existing budget code in `src/jobs/costs.ts`.
- **Model constant:** `SCOUT_MODEL = 'claude-haiku-4-5'` — the alias, because it is the `PRICE_TABLE` key in `src/providers/anthropic.ts`. NOT the dated id.
- **Defaults (exact values):** `min_score` 60, `per_source_limit` 25, source fetch timeout 10_000 ms, `RECENT_TITLES_LIMIT` 30, `ESTIMATED_SCOUT_COST_MICROS` 20_000, `PRODUCE_LEASE_TTL_MS` 5_400_000 (90 min), `RESUME_MIN_HEADROOM_USD_MICROS` 2_000_000, `ZOMBIE_RUNNING_MS` 7_200_000 (2 h), global daily cap env `BRAINROT_GLOBAL_DAILY_USD` (existing, default 25).
- **Scout ledger sentinel:** scout scoring cost is recorded via existing `recordCost(db, jobId, provider, operation, usdMicros)` with `jobId = 'scout:<channel name>'`, `provider = 'anthropic'`, `operation = 'scout-score'`. FKs are off by design; the global-day query sums ALL costs rows (verified: no jobs JOIN), so sentinel rows count toward the global cap. Ledger-complete error paths: if the scoring call throws after spending (ZodError with `costUsdMicros`, or any error where `errorCostUsdMicros(err)` from `src/providers/errors.ts` returns a number), that cost MUST still be recorded.
- **Dedupe:** `dedupe_hash = sha256 hex of `${sourceId}\n${externalId}``. Uniqueness is `UNIQUE (channel, dedupe_hash)` + `INSERT OR IGNORE`; known hashes are filtered BEFORE the Haiku call.
- **Topic lifecycle:** `candidate → approved → claimed → used`, plus `rejected` (operator or scorer-below-threshold). Volume claims take `candidate|approved`; premium claims require `approved` unless the channel's `auto_premium` is true (then `candidate|approved`).
- **Quota counting:** jobs created today (UTC) per (channel, tier), counting ALL statuses — a failed job still consumed its slot.
- **"Library-landed"** means `JobResult.status` is `'ready' | 'needs-review'` — the condition for flipping a claimed topic to `used`.
- **CLI exit codes:** `produce-next` and `resume` mirror `produce` (0 for ready/needs-review and benign no-ops; 1 for failed/blocked and errors). `digest` always exits 0. `scout` exits 1 only when EVERY source across ALL channels failed, or on config/db errors.
- **JSON output discipline:** `produce-next` and `scout` print exactly one JSON line to stdout (cron-greppable) on every run that gets past argument/config/db validation — including failure outcomes (a produced job that failed, an all-sources-failed scout run). Hard config/db errors (bad --channels-dir, unreadable db) follow the house parseAsync error path: message on stderr, exit 1, no JSON line. Diagnostics always go to stderr.
- **No new contract tests.** The scout reuses `structuredCompletion`, already contract-proven.
- **House test pattern:** real SQLite via `openDb(':memory:')` or temp file, fixture HTTP payloads (stub `fetchImpl`, never live network), mocked Anthropic client via the `client` injection seam. vitest constructor mocks need `function`/`class` (not arrow) — prefer factory-function seams as pinned below.
- **Commit style:** conventional commits, one per task step where the plan says so, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

## Interface Contract (binding)

Existing signatures consumed (verbatim from current main — do not redesign):

```ts
// src/providers/anthropic.ts
export interface LlmUsageCost { usdMicros: number }
export async function structuredCompletion<T>(opts: {
  model: string; system: string; prompt: string; schema: z.ZodType<T>;
  maxTokens?: number; client?: Anthropic;
}): Promise<{ data: T; cost: LlmUsageCost }>
export const PRICE_TABLE: Record<string, {...}>  // keys include 'claude-haiku-4-5'

// src/providers/errors.ts
export function errorCostUsdMicros(err: unknown): number | undefined

// src/jobs/costs.ts (existing)
export class BudgetExceededError extends Error { constructor(public reason: string) }
export function recordCost(db, jobId, provider, operation, usdMicros): void
export function assertBudget(db, channel: ChannelConfig, jobId: string, upcomingUsdMicros: number, tier: Tier): void

// src/jobs/runner.ts
export interface JobResult { jobId: string; status: 'ready' | 'needs-review' | 'failed' | 'blocked'; videoPath?: string }
export function createJob(db, channel: ChannelConfig, opts: { topic: string; tier: Tier }, _options?): string
export async function runJob(db, channel: ChannelConfig, jobId: string, stages: StageDef[], options?: { runsRoot?: string }): Promise<JobResult>

// src/jobs/types.ts
export type Tier = 'volume' | 'premium'
export interface StageDef { name: StageName; run(ctx: JobContext): Promise<void> }

// src/config/channel.ts
export interface ChannelConfig { name: string; niche: string[]; tierMix: { volume: number; premium: number }; /* ...voice, premium, captionStyle, bgDir, bgmDir, scriptModel... */ budget: { perVideoUsdMicros: number; premiumPerVideoUsdMicros: number; perDayUsdMicros: number } }
export function loadChannelConfig(path: string): ChannelConfig

// src/cli.ts (existing exports that stay)
export function parseTier(raw: string): Tier
export function stagesForTier(tier: Tier): StageDef[]        // Task 9 MOVES the implementation to src/jobs/pipeline.ts; cli.ts re-exports
export function assertPremiumPreflight(tier: Tier): void     // same move
```

New interfaces produced by this plan (binding names, parameters, return types):

```ts
// ── Task 1: src/scout/topics.ts + schema.sql topics table ──────────────
export type TopicStatus = 'candidate' | 'approved' | 'claimed' | 'used' | 'rejected'
export interface TopicRow {
  id: number; channel: string; title: string; rawTitle: string; source: string;
  url: string; dedupeHash: string; score: number; reason: string;
  status: TopicStatus; jobId: string | null; createdAt: string
}
export interface NewTopic {
  channel: string; title: string; rawTitle: string; source: string; url: string;
  dedupeHash: string; score: number; reason: string; status: 'candidate' | 'rejected'
}
export function insertTopics(db: Database, rows: NewTopic[]): number   // INSERT OR IGNORE; returns actually-inserted count
export function knownHashes(db: Database, channel: string, hashes: string[]): Set<string>
export function recentTopicTitles(db: Database, channel: string, limit?: number): string[]  // default 30; status != 'rejected'; newest first
export function approveTopics(db: Database, ids: number[]): number     // candidate→approved only; returns changed count
export function rejectTopics(db: Database, ids: number[]): number      // candidate|approved→rejected; returns changed count
export function claimTopic(db: Database, topicId: number, jobId: string): boolean
// guarded: UPDATE ... SET status='claimed', job_id=? WHERE id=? AND status IN ('candidate','approved');
// returns true iff a row changed — a rejected/used/claimed topic is never revived
export function markTopicUsedByJob(db: Database, jobId: string): void  // claimed row with matching job_id → 'used'; silent no-op when none
export function listTopics(db: Database, filter?: { channel?: string; status?: TopicStatus }): TopicRow[]  // newest first
export function eligibleTopic(db: Database, channel: string, tier: Tier, opts: { autoPremium: boolean }): TopicRow | null
// volume: status IN ('candidate','approved'); premium: 'approved' only, or IN ('candidate','approved') when opts.autoPremium
// ORDER BY score DESC, created_at ASC, id ASC LIMIT 1

// schema.sql appends (verbatim):
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

// ── Task 2: src/config/channel.ts additions ────────────────────────────
export interface ScoutConfig { subreddits: string[]; rss: string[]; minScore: number; perSourceLimit: number; autoPremium: boolean }
export const DEFAULT_SCOUT: ScoutConfig  // { subreddits: [], rss: [], minScore: 60, perSourceLimit: 25, autoPremium: false }
// ChannelConfig gains: scout: ScoutConfig
// TOML: [scout] subreddits (string[], default []), rss (string[], default []),
//        min_score (int 0..100, default 60), per_source_limit (int 1..100, default 25),
//        auto_premium (bool, default false). Absent [scout] table → DEFAULT_SCOUT whole.
export function loadChannelsDir(dir: string): ChannelConfig[]  // all <dir>/*.toml, sorted by channel name; throws on unparseable file

// ── Task 3: src/scout/sources/types.ts + reddit.ts ─────────────────────
export interface TrendCandidate { title: string; url: string; sourceId: string; externalId: string }
export interface TrendSourceFetchOpts { limit: number; timeoutMs: number }
export interface TrendSource { readonly id: string; fetch(opts: TrendSourceFetchOpts): Promise<TrendCandidate[]> }
export type FetchLike = typeof globalThis.fetch
export function dedupeHash(sourceId: string, externalId: string): string  // sha256 hex of `${sourceId}\n${externalId}` (node:crypto)
export const SOURCE_FETCH_TIMEOUT_MS = 10_000

export const REDDIT_USER_AGENT = 'brainrot-machine/0.1 (personal short-form pipeline; single operator)'
export function redditSource(subreddit: string, fetchImpl?: FetchLike): TrendSource
// id/sourceId = `reddit:r/${subreddit}`
// GET https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}&raw_json=1
// headers: { 'User-Agent': REDDIT_USER_AGENT }; AbortSignal.timeout(timeoutMs)
// non-2xx → throw; children[].data: skip stickied === true;
// externalId = data.name (t3_xyz fullname); url = 'https://www.reddit.com' + data.permalink

// ── Task 4: src/scout/sources/rss.ts ───────────────────────────────────
export function rssSource(feedUrl: string, fetchImpl?: FetchLike): TrendSource
// id/sourceId = `rss:${new URL(feedUrl).hostname}`
// Parses RSS 2.0 (rss.channel.item[]) AND Atom (feed.entry[]) via fast-xml-parser;
// single-item feeds (parser yields object, not array) MUST be normalized.
// externalId: RSS guid (string or {'#text'}) → Atom id → item link. Missing title or resolvable id → skip item.
// AbortSignal.timeout(timeoutMs); non-2xx → throw.

// ── Task 5: src/jobs/costs.ts extraction (behavior-preserving refactor) ─
export function channelDaySpentMicros(db: Database, channel: string): number  // today UTC, JOIN through jobs (existing query verbatim)
export function globalDaySpentMicros(db: Database): number                    // today UTC, all costs rows, no JOIN (existing query verbatim)
export function globalDailyCapMicros(): number                                // existing private fn exported unchanged
export function assertGlobalDayBudget(db: Database, upcomingUsdMicros: number): void  // throws BudgetExceededError('global-day ...') — the exact check assertBudget performs today, extracted; assertBudget delegates to it

// ── Task 6: src/scout/score.ts ─────────────────────────────────────────
export const SCOUT_MODEL = 'claude-haiku-4-5'
export const SCOUT_MAX_TOKENS = 4096
export const ESTIMATED_SCOUT_COST_MICROS = 20_000
export interface ScoredCandidate { candidateIndex: number; score: number; topic: string; reason: string }
export async function scoreCandidates(opts: {
  candidates: TrendCandidate[]; niche: string[]; recentTitles: string[]; client?: Anthropic;
}): Promise<{ scored: ScoredCandidate[]; costUsdMicros: number }>
// One structuredCompletion call, SCOUT_MODEL, zod schema:
//   z.object({ scores: z.array(z.object({ candidateIndex: z.number().int().min(0),
//     score: z.number().int().min(0).max(100), topic: z.string().min(1), reason: z.string().min(1) })) })
// Prompt: numbered candidate list (index, raw title, sourceId), niche keywords,
// recentTitles labeled "recently covered — score near-duplicates 0".
// Result normalization: entries matched to candidates by candidateIndex; out-of-range
// indexes dropped; duplicate indexes → first wins; candidates absent from the model
// output are returned as { score: 0, topic: rawTitle, reason: 'not scored' }.
// scoreCandidates does NOT touch the db — gating and ledgering live in scoutChannel.

// ── Task 7: src/scout/scout.ts + CLI `scout` ───────────────────────────
export interface ScoutChannelResult {
  channel: string; fetched: number; alreadyKnown: number; scored: number;
  queued: number; rejected: number; sourceErrors: string[]; costUsdMicros: number;
  scoringError?: string   // set when the Haiku call threw (message); queued/rejected are 0 then
}
export class AllSourcesFailedError extends Error {
  // Carries the per-channel results so the CLI can still print its one JSON
  // line (Global Constraints: JSON even on failure outcomes) before exit 1.
  constructor(message: string, public results: ScoutChannelResult[]) {
    super(message)
    this.name = 'AllSourcesFailedError'
  }
}
export async function scoutChannel(db: Database, channel: ChannelConfig, opts?: {
  client?: Anthropic; fetchImpl?: FetchLike;
}): Promise<ScoutChannelResult>
// sources = channel.scout.subreddits.map(redditSource) + channel.scout.rss.map(rssSource)
// fetch all with per-source isolation (failure → sourceErrors entry, zero candidates);
// hash-filter via knownHashes BEFORE scoring; empty remainder → NO Haiku call, zero cost;
// assertGlobalDayBudget(db, ESTIMATED_SCOUT_COST_MICROS) BEFORE the call;
// recordCost under sentinel 'scout:<name>' on success AND on thrown-with-cost errors
// (errorCostUsdMicros) — then rethrow; score >= channel.scout.minScore → 'candidate'
// with title = scored.topic, else 'rejected'; insertTopics once, batched.
export async function scoutAll(db: Database, channels: ChannelConfig[], opts?): Promise<ScoutChannelResult[]>
// channels with no scout sources are skipped entirely; a channel whose scoring call
// throws (incl. BudgetExceededError from the gate) logs to stderr, yields its
// ScoutChannelResult with scoringError set, and CONTINUES (per-channel isolation);
// throws AllSourcesFailedError only when every source of every scouted channel errored
// (the error carries `results` so the CLI still prints its JSON line before exit 1).
// CLI: brainrot scout [--db <path>] [--channels-dir <dir>]  (default channels/)
// stdout: one JSON line { channels: ScoutChannelResult[] } — on success AND on
// AllSourcesFailedError; config/db errors take the parseAsync path (stderr, exit 1, no JSON)

// ── Task 8: src/loop/lease.ts + schema.sql leases table ────────────────
export const PRODUCE_LEASE_TTL_MS = 5_400_000
export function acquireLease(db: Database, name: string, holder: string, ttlMs: number): boolean
// one synchronous transaction: free row OR expires_at <= now → upsert(name, holder, now+ttl), true; else false
export function releaseLease(db: Database, name: string, holder: string): void
// deletes only when holder matches (a takeover must not be released by the evicted holder)

// schema.sql appends (verbatim):
CREATE TABLE IF NOT EXISTS leases (
  name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at TEXT NOT NULL
);

// ── Task 9: src/jobs/pipeline.ts + src/jobs/resume.ts + CLI `resume` ───
// pipeline.ts: MOVE stagesForTier + assertPremiumPreflight bodies from cli.ts, verbatim;
// cli.ts replaces bodies with `export { stagesForTier, assertPremiumPreflight } from './jobs/pipeline.js'`
// (existing cli.test.ts in-process imports keep passing untouched).
export class ResumeError extends Error {}  // src/jobs/resume.ts; message carries the refusal reason
export async function resumeJob(db: Database, jobId: string, opts: {
  runsRoot: string; channelsDir: string; force?: boolean;
  stagesFor?: (tier: Tier) => StageDef[];   // test seam; default stagesForTier
}): Promise<JobResult>
// job missing → ResumeError; status 'done'/'queued' → ResumeError;
// 'running' without force → ResumeError telling the operator to pass --force;
// channel TOML resolved as `${channelsDir}/${job.channel}.toml`, missing → ResumeError;
// premium → assertPremiumPreflight; runJob(...); library-landed → markTopicUsedByJob.
// CLI: brainrot resume <jobId> [--db] [--runs-root] [--channels-dir] [--force]
// stdout: the JobResult JSON line; exit codes mirror produce.

// ── Task 10: src/loop/plan-tick.ts ─────────────────────────────────────
export const RESUME_MIN_HEADROOM_USD_MICROS = 2_000_000
export type TickPlan =
  | { kind: 'resume'; jobId: string; channel: string; tier: Tier }
  | { kind: 'produce'; channel: string; topicId: number; topic: string; tier: Tier }
  | { kind: 'noop'; reason: 'no-eligible-work' | 'no-fal-key' }
export function planTick(db: Database, channels: ChannelConfig[], opts: { falKeyPresent: boolean }): TickPlan
// 'no-fal-key' is returned instead of 'no-eligible-work' when the tick found premium
// work but skipped it for falKeyPresent=false (a blocked premium job skipped at the
// key check, or an open premium slot with an eligible approved/auto_premium topic)
// and nothing else was runnable — so an operator with an unset FAL_KEY can tell a
// starved queue from a key problem (spec §8's distinct no-op reasons).
// RESUME PASS: blocked jobs oldest-first (created_at ASC, id ASC tiebreak); take the first where
//   - its channel is present in `channels` (else skip)
//   - tier 'premium' → opts.falKeyPresent (else skip)
//   - channel-day remaining (perDayUsdMicros − channelDaySpentMicros) ≥ RESUME_MIN_HEADROOM_USD_MICROS
//   - global-day remaining (globalDailyCapMicros() − globalDaySpentMicros) ≥ RESUME_MIN_HEADROOM_USD_MICROS
// CLAIM PASS: candidates = channels with ANY open slot today (quota counting per
// Global Constraints); sort by (filledFraction = jobsToday / (mix.volume + mix.premium)) ASC,
// then name ASC; first channel that yields a unit wins:
//   premium slot open AND falKeyPresent AND eligibleTopic(premium, {autoPremium}) → premium produce
//   else volume slot open AND eligibleTopic(volume) → volume produce
//   else next channel.
// Nothing anywhere → { kind: 'noop', reason: 'no-eligible-work' }. Pure decision fn: no writes.

// ── Task 11: src/loop/produce-next.ts + CLI `produce-next` ─────────────
export interface TickResult {
  action: 'resumed' | 'produced' | 'noop'
  reason?: 'lease-held' | 'no-eligible-work' | 'no-fal-key'
  jobId?: string; topicId?: number; tier?: Tier; status?: JobResult['status']
}
export async function produceNextTick(db: Database, opts: {
  channelsDir: string; runsRoot: string;
  stagesFor?: (tier: Tier) => StageDef[];   // test seam; default stagesForTier
}): Promise<TickResult>
// holder = `pid:${process.pid}`; acquireLease(db,'produce',holder,PRODUCE_LEASE_TTL_MS)
// or → { action:'noop', reason:'lease-held' }; try/finally releaseLease.
// channels = loadChannelsDir(opts.channelsDir); plan = planTick(db, channels,
// { falKeyPresent: !!process.env.FAL_KEY });
// resume → resumeJob (force never set; blocked jobs only per planTick; the
//   stagesFor seam is FORWARDED into resumeJob so tests can fake both paths);
// produce → in ONE db.transaction: jobId = createJob(...topic title, tier) then
//   claimTopic(topicId, jobId) — claimTopic returning false throws (invariant
//   breach: planTick selected it moments ago; nested transaction rolls the job
//   row back, no orphan). better-sqlite3 nests transactions as savepoints, so
//   createJob's internal transaction is safe. Then runJob(stagesFor(tier));
//   library-landed → markTopicUsedByJob(db, jobId).
// CLI: brainrot produce-next [--db] [--channels-dir] [--runs-root]
// stdout: one JSON line (TickResult). exit 1 iff status 'failed' | 'blocked'.

// ── Task 12: CLI `topics` subcommands (no new module; wiring in cli.ts) ─
export function parseTopicIds(raw: string[]): number[]  // in cli.ts; throws Error naming the bad token unless every entry is a positive integer
// brainrot topics list [--db] [--channel <name>] [--status <status>] → console.table of
//   { id, channel, score, status, title, reason } (listTopics)
// brainrot topics approve <id...> / brainrot topics reject <id...>
//   ids via parseTopicIds (throw → error message, exit 1, no writes);
//   prints `approved ${changed} of ${ids.length}` / `rejected ${changed} of ${ids.length}`; exit 0.

// ── Task 13: src/loop/digest.ts + CLI `digest` ─────────────────────────
export const ZOMBIE_RUNNING_MS = 7_200_000
export function buildDigest(db: Database, channels: ChannelConfig[]): string
// Human-readable multi-line report (NOT JSON). Sections in order:
// 1. Topics last 24h (created_at >= datetime('now','-1 day')): per channel scouted → candidate/approved/rejected counts
// 2. Jobs last 24h per channel×tier with outcome counts (ready/needs-review/failed/blocked via library+jobs)
// 3. Spend today (UTC): per channel channelDaySpentMicros vs budget.perDayUsdMicros; global vs globalDailyCapMicros — dollars formatted $X.XX
// 4. Action items: failed jobs (id, channel, tier); running jobs older than ZOMBIE_RUNNING_MS
//    ("probably crashed — resume with --force"); count of approved premium topics per channel;
//    count of candidate topics awaiting approval per channel
// CLI: brainrot digest [--db] [--channels-dir]; prints buildDigest; ALWAYS exit 0.

// ── Task 14: README scheduling section + golden-path extension ─────────
// README gains "## Automation (cron)" with a paste-ready crontab block (scout 3×/day,
// produce-next every 25 min, digest daily 8am) using absolute paths + `cd` into the
// repo, and the UTC-day note. Golden-path test extends: fixture scout (stub fetchImpl
// + stub Anthropic client) → topics rows → produceNextTick with fake stages → library
// (deliberately orchestration-scoped: the loop calls the same runJob/stagesForTier as
// `produce`, and the real volume pipeline stays covered by the existing golden-path
// test — a second full Remotion render per suite run buys little for its cost)
// row 'ready' + topic 'used'. File: src/jobs/golden-path-loop.test.ts.
```

## Task Overview

| # | Task | Files (create/modify) |
|---|---|---|
| 1 | Topics table + DAO | C `src/scout/topics.ts`, `src/scout/topics.test.ts`; M `src/db/schema.sql` |
| 2 | Channel `[scout]` config + `loadChannelsDir` | M `src/config/channel.ts`, `src/config/channel.test.ts` |
| 3 | TrendSource types + dedupeHash + RedditSource | C `src/scout/sources/types.ts`, `src/scout/sources/reddit.ts`, `src/scout/sources/reddit.test.ts` |
| 4 | RssSource (fast-xml-parser) | C `src/scout/sources/rss.ts`, `src/scout/sources/rss.test.ts`; M `package.json` |
| 5 | costs.ts day-spend helpers extraction | M `src/jobs/costs.ts`, `src/jobs/costs.test.ts` |
| 6 | Scorer | C `src/scout/score.ts`, `src/scout/score.test.ts` |
| 7 | Scout orchestrator + `scout` CLI | C `src/scout/scout.ts`, `src/scout/scout.test.ts`; M `src/cli.ts`, `src/cli.test.ts` |
| 8 | Lease | C `src/loop/lease.ts`, `src/loop/lease.test.ts`; M `src/db/schema.sql` |
| 9 | pipeline.ts move + resumeJob + `resume` CLI | C `src/jobs/pipeline.ts`, `src/jobs/resume.ts`, `src/jobs/resume.test.ts`; M `src/cli.ts` |
| 10 | Tick planner | C `src/loop/plan-tick.ts`, `src/loop/plan-tick.test.ts` |
| 11 | produce-next executor + CLI | C `src/loop/produce-next.ts`, `src/loop/produce-next.test.ts`; M `src/cli.ts` |
| 12 | `topics` CLI subcommands | M `src/cli.ts`, `src/cli.test.ts` |
| 13 | Digest + CLI | C `src/loop/digest.ts`, `src/loop/digest.test.ts`; M `src/cli.ts` |
| 14 | README cron docs + golden-path loop test | C `src/jobs/golden-path-loop.test.ts`; M `README.md` |

Execution order is 1→14 (each task may consume interfaces from lower-numbered tasks only). Only Tasks 5/6 may run in parallel (disjoint files, no imports between them). 3→4 is a hard dependency (rss.ts imports Task 3's types.ts), and 12→13 must stay sequential — both modify src/cli.ts and src/cli.test.ts, and Task 13's edit anchors assume Task 12's edits are already present.

---

## Tasks

### Task 1: Topics table + DAO

**Files:**
- Create: `src/scout/topics.ts`, `src/scout/topics.test.ts`
- Modify: `src/db/schema.sql`
- Test: `src/scout/topics.test.ts`

**Interfaces:**

Consumes (existing code — verbatim):
```ts
// src/db/index.ts
export function openDb(dbPath: string): Database   // better-sqlite3; FKs OFF by design

// src/jobs/types.ts
export type Tier = 'volume' | 'premium'
```

Produces (later tasks — scout orchestrator, plan-tick, produce-next, topics CLI, digest — rely on these exact signatures):
```ts
// src/scout/topics.ts
export type TopicStatus = 'candidate' | 'approved' | 'claimed' | 'used' | 'rejected'
export interface TopicRow {
  id: number; channel: string; title: string; rawTitle: string; source: string;
  url: string; dedupeHash: string; score: number; reason: string;
  status: TopicStatus; jobId: string | null; createdAt: string
}
export interface NewTopic {
  channel: string; title: string; rawTitle: string; source: string; url: string;
  dedupeHash: string; score: number; reason: string; status: 'candidate' | 'rejected'
}
export const RECENT_TITLES_LIMIT = 30
export function insertTopics(db: Database, rows: NewTopic[]): number   // INSERT OR IGNORE; returns actually-inserted count
export function knownHashes(db: Database, channel: string, hashes: string[]): Set<string>
export function recentTopicTitles(db: Database, channel: string, limit?: number): string[]  // default 30; status != 'rejected'; newest first
export function approveTopics(db: Database, ids: number[]): number     // candidate→approved only; returns changed count
export function rejectTopics(db: Database, ids: number[]): number      // candidate|approved→rejected; returns changed count
export function claimTopic(db: Database, topicId: number, jobId: string): boolean  // guarded; true iff claimed
export function markTopicUsedByJob(db: Database, jobId: string): void  // claimed row with matching job_id → 'used'; silent no-op when none
export function listTopics(db: Database, filter?: { channel?: string; status?: TopicStatus }): TopicRow[]  // newest first
export function eligibleTopic(db: Database, channel: string, tier: Tier, opts: { autoPremium: boolean }): TopicRow | null
```
Plus the `topics` table in `src/db/schema.sql` (DDL below, verbatim per contract). `CREATE TABLE IF NOT EXISTS` means existing DBs pick it up on next `openDb` — no migration machinery.

House rules in force: ESM `.js` suffixes on relative imports; real SQLite in tests via `openDb(':memory:')`; no floats anywhere near money (this task stores only integer scores); conventional commits with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

---

- [ ] **Step 1: Write the failing schema test**

  Create `src/scout/topics.test.ts` (new directory `src/scout/`). The `seedTopic` helper does raw inserts with explicit `created_at` so later ordering tests are deterministic (the schema default has millisecond resolution — same-tick inserts would collide):

  ```ts
  import { describe, expect, it } from 'vitest'
  import type { Database } from 'better-sqlite3'
  import { openDb } from '../db/index.js'

  // Raw-insert seed: the DAO only ever writes status/job_id transitions, so
  // tests control every column (created_at included) directly.
  let seq = 0
  function seedTopic(
    db: Database,
    overrides: Partial<{
      channel: string
      title: string
      rawTitle: string
      source: string
      url: string
      dedupeHash: string
      score: number
      reason: string
      status: string
      jobId: string | null
      createdAt: string
    }> = {},
  ): number {
    seq += 1
    const row = {
      channel: 'chan-a',
      title: `Topic ${seq}`,
      rawTitle: `Raw ${seq}`,
      source: 'reddit:r/space',
      url: `https://example.com/${seq}`,
      dedupeHash: `hash-${seq}`,
      score: 50,
      reason: 'seeded',
      status: 'candidate',
      jobId: null,
      createdAt: '2026-07-20T00:00:00.000Z',
      ...overrides,
    }
    const res = db
      .prepare(
        'INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status, job_id, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.channel,
        row.title,
        row.rawTitle,
        row.source,
        row.url,
        row.dedupeHash,
        row.score,
        row.reason,
        row.status,
        row.jobId,
        row.createdAt,
      )
    return Number(res.lastInsertRowid)
  }

  describe('topics table schema', () => {
    it('creates the table with candidate default and UNIQUE (channel, dedupe_hash)', () => {
      const db = openDb(':memory:')
      db.prepare(
        "INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason) VALUES ('chan-a', 'T', 'R', 's', 'u', 'h1', 80, 'r')",
      ).run()
      const row = db.prepare('SELECT status, job_id, created_at FROM topics').get() as {
        status: string
        job_id: string | null
        created_at: string
      }
      expect(row.status).toBe('candidate')
      expect(row.job_id).toBeNull()
      expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      // same (channel, dedupe_hash) is ignored; same hash on another channel inserts
      const dup = db
        .prepare(
          "INSERT OR IGNORE INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason) VALUES ('chan-a', 'T2', 'R2', 's', 'u', 'h1', 10, 'r')",
        )
        .run()
      expect(dup.changes).toBe(0)
      const other = db
        .prepare(
          "INSERT OR IGNORE INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason) VALUES ('chan-b', 'T', 'R', 's', 'u', 'h1', 80, 'r')",
        )
        .run()
      expect(other.changes).toBe(1)
      db.close()
    })

    it('rejects a status outside the lifecycle CHECK', () => {
      const db = openDb(':memory:')
      expect(() => seedTopic(db, { status: 'simmering' })).toThrow(/CHECK/)
      db.close()
    })
  })
  ```

- [ ] **Step 2: Run the schema test, observe the failure**

  ```bash
  pnpm vitest run src/scout/topics.test.ts
  ```

  Expected failure: both tests fail with `SqliteError: no such table: topics` (the schema has no topics table yet).

- [ ] **Step 3: Append the topics table to schema.sql**

  In `src/db/schema.sql`, replace the final comment line

  ```sql
  -- topics & publishes tables arrive in Plans 2 and 3.
  ```

  with the topics DDL (verbatim from the contract) and an updated forward-pointer:

  ```sql
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
  -- publishes table arrives in Plan 4.
  ```

- [ ] **Step 4: Run to green**

  ```bash
  pnpm vitest run src/scout/topics.test.ts
  ```

  Expected: `2 passed`.

- [ ] **Step 5: Commit the schema**

  ```bash
  git add src/db/schema.sql src/scout/topics.test.ts
  git commit -m "feat: add topics table for the scouted topic queue" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 6: Write the failing insertTopics test**

  Add to `src/scout/topics.test.ts` — a new import line after the `openDb` import:

  ```ts
  import { insertTopics } from './topics.js'
  ```

  and a new describe block at the bottom:

  ```ts
  describe('insertTopics', () => {
    it('inserts a batch and reports only rows actually written', () => {
      const db = openDb(':memory:')
      const base = {
        title: 'Why the Moon is drifting away',
        rawTitle: 'Moon drifting 3.8cm/yr',
        source: 'reddit:r/space',
        url: 'https://www.reddit.com/r/space/1',
        score: 82,
        reason: 'high novelty',
      }
      const first = insertTopics(db, [
        { ...base, channel: 'chan-a', dedupeHash: 'h1', status: 'candidate' },
        { ...base, channel: 'chan-a', dedupeHash: 'h2', status: 'rejected' },
      ])
      expect(first).toBe(2)
      // re-run overlap: h1 already known, h3 is new
      const second = insertTopics(db, [
        { ...base, channel: 'chan-a', dedupeHash: 'h1', status: 'candidate' },
        { ...base, channel: 'chan-a', dedupeHash: 'h3', status: 'candidate' },
      ])
      expect(second).toBe(1)
      const rows = db
        .prepare('SELECT dedupe_hash, status FROM topics ORDER BY id')
        .all() as { dedupe_hash: string; status: string }[]
      expect(rows).toEqual([
        { dedupe_hash: 'h1', status: 'candidate' },
        { dedupe_hash: 'h2', status: 'rejected' },
        { dedupe_hash: 'h3', status: 'candidate' },
      ])
      db.close()
    })

    it('returns 0 for an empty batch', () => {
      const db = openDb(':memory:')
      expect(insertTopics(db, [])).toBe(0)
      db.close()
    })
  })
  ```

- [ ] **Step 7: Run, observe the failure**

  ```bash
  pnpm vitest run src/scout/topics.test.ts
  ```

  Expected failure: `Error: Failed to resolve import "./topics.js" from "src/scout/topics.test.ts". Does the file exist?` — the module does not exist yet. (From the next cycle onward the file DOES exist, so a missing named export will instead surface at runtime as `TypeError: <name> is not a function` — esbuild resolves missing named exports to `undefined`, not an import-time error.)

- [ ] **Step 8: Create src/scout/topics.ts with the types and insertTopics**

  ```ts
  import type { Database } from 'better-sqlite3'
  import type { Tier } from '../jobs/types.js'

  export type TopicStatus = 'candidate' | 'approved' | 'claimed' | 'used' | 'rejected'

  export interface TopicRow {
    id: number
    channel: string
    title: string
    rawTitle: string
    source: string
    url: string
    dedupeHash: string
    score: number
    reason: string
    status: TopicStatus
    jobId: string | null
    createdAt: string
  }

  // Scorer output lands as 'candidate' (score >= min_score) or 'rejected';
  // the operator lifecycle states are reached only via the transition fns below.
  export interface NewTopic {
    channel: string
    title: string
    rawTitle: string
    source: string
    url: string
    dedupeHash: string
    score: number
    reason: string
    status: 'candidate' | 'rejected'
  }

  // INSERT OR IGNORE on UNIQUE (channel, dedupe_hash): re-inserting a known item
  // is a no-op, so the returned count is rows actually written. One transaction —
  // a mid-run crash loses the whole batch, never half of it.
  export function insertTopics(db: Database, rows: NewTopic[]): number {
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    const insertAll = db.transaction((batch: NewTopic[]) => {
      let inserted = 0
      for (const t of batch) {
        inserted += stmt.run(
          t.channel,
          t.title,
          t.rawTitle,
          t.source,
          t.url,
          t.dedupeHash,
          t.score,
          t.reason,
          t.status,
        ).changes
      }
      return inserted
    })
    return insertAll(rows)
  }
  ```

  (`Tier` is imported now because `eligibleTopic` needs it later in this task; TypeScript flags unused imports only under lint, not tsc, so this compiles clean.)

- [ ] **Step 9: Run to green**

  ```bash
  pnpm vitest run src/scout/topics.test.ts
  ```

  Expected: `4 passed`.

- [ ] **Step 10: Commit insertTopics**

  ```bash
  git add src/scout/topics.ts src/scout/topics.test.ts
  git commit -m "feat: add topics DAO types and batched insertTopics" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 11: Write the failing knownHashes test**

  Extend the import line in `src/scout/topics.test.ts`:

  ```ts
  import { insertTopics, knownHashes } from './topics.js'
  ```

  Append:

  ```ts
  describe('knownHashes', () => {
    it('returns only hashes already stored for that channel', () => {
      const db = openDb(':memory:')
      seedTopic(db, { channel: 'chan-a', dedupeHash: 'h1' })
      // rejected rows are still "known" — they must never reach the scorer again
      seedTopic(db, { channel: 'chan-a', dedupeHash: 'h2', status: 'rejected' })
      seedTopic(db, { channel: 'chan-b', dedupeHash: 'h3' })
      expect(knownHashes(db, 'chan-a', ['h1', 'h2', 'h3', 'h9'])).toEqual(new Set(['h1', 'h2']))
      expect(knownHashes(db, 'chan-a', [])).toEqual(new Set())
      db.close()
    })
  })
  ```

- [ ] **Step 12: Run, observe the failure**

  ```bash
  pnpm vitest run src/scout/topics.test.ts
  ```

  Expected failure: `TypeError: knownHashes is not a function` (missing named export → `undefined` at runtime).

- [ ] **Step 13: Implement knownHashes**

  Append to `src/scout/topics.ts`:

  ```ts
  // Pre-Haiku hash filter: any status counts as known (a rejected item must
  // never be re-scored). IN-list size is bounded by the scout's per-source
  // candidate caps, far under SQLite's bound-variable limit.
  export function knownHashes(db: Database, channel: string, hashes: string[]): Set<string> {
    if (hashes.length === 0) return new Set()
    const placeholders = hashes.map(() => '?').join(', ')
    const rows = db
      .prepare(
        `SELECT dedupe_hash FROM topics WHERE channel = ? AND dedupe_hash IN (${placeholders})`,
      )
      .all(channel, ...hashes) as { dedupe_hash: string }[]
    return new Set(rows.map((r) => r.dedupe_hash))
  }
  ```

- [ ] **Step 14: Run to green, commit**

  ```bash
  pnpm vitest run src/scout/topics.test.ts
  ```

  Expected: `5 passed`. Then:

  ```bash
  git add src/scout/topics.ts src/scout/topics.test.ts
  git commit -m "feat: add knownHashes pre-scoring dedupe filter" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 15: Write the failing recentTopicTitles test**

  Extend the import line:

  ```ts
  import { insertTopics, knownHashes, RECENT_TITLES_LIMIT, recentTopicTitles } from './topics.js'
  ```

  Append:

  ```ts
  describe('recentTopicTitles', () => {
    it('returns non-rejected titles newest first, capped at the limit', () => {
      const db = openDb(':memory:')
      seedTopic(db, { title: 'oldest', createdAt: '2026-07-18T00:00:00.000Z' })
      seedTopic(db, { title: 'skipped', createdAt: '2026-07-19T00:00:00.000Z', status: 'rejected' })
      seedTopic(db, { title: 'middle', createdAt: '2026-07-19T12:00:00.000Z', status: 'used' })
      seedTopic(db, { title: 'newest', createdAt: '2026-07-20T00:00:00.000Z', status: 'approved' })
      seedTopic(db, { title: 'other channel', channel: 'chan-b', createdAt: '2026-07-20T06:00:00.000Z' })
      expect(recentTopicTitles(db, 'chan-a')).toEqual(['newest', 'middle', 'oldest'])
      expect(recentTopicTitles(db, 'chan-a', 2)).toEqual(['newest', 'middle'])
      db.close()
    })

    it('defaults the limit to RECENT_TITLES_LIMIT (30)', () => {
      const db = openDb(':memory:')
      expect(RECENT_TITLES_LIMIT).toBe(30)
      for (let i = 0; i < 35; i++) {
        seedTopic(db, { createdAt: `2026-07-19T00:00:${String(i).padStart(2, '0')}.000Z` })
      }
      expect(recentTopicTitles(db, 'chan-a')).toHaveLength(30)
      db.close()
    })
  })
  ```

- [ ] **Step 16: Run, observe the failure**

  ```bash
  pnpm vitest run src/scout/topics.test.ts
  ```

  Expected failure: `TypeError: recentTopicTitles is not a function` (and `RECENT_TITLES_LIMIT` resolves to `undefined`, so `expect(RECENT_TITLES_LIMIT).toBe(30)` would fail if reached first).

- [ ] **Step 17: Implement recentTopicTitles**

  Append to `src/scout/topics.ts`:

  ```ts
  // Scorer prompt context: how many recent titles feed the "recently covered —
  // score near-duplicates 0" instruction (design spec §5).
  export const RECENT_TITLES_LIMIT = 30

  // Rejected topics are noise (near-duplicates, off-niche); the scorer only
  // needs what the channel actually covered or queued.
  export function recentTopicTitles(
    db: Database,
    channel: string,
    limit = RECENT_TITLES_LIMIT,
  ): string[] {
    const rows = db
      .prepare(
        "SELECT title FROM topics WHERE channel = ? AND status != 'rejected' " +
          'ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(channel, limit) as { title: string }[]
    return rows.map((r) => r.title)
  }
  ```

- [ ] **Step 18: Run to green, commit**

  ```bash
  pnpm vitest run src/scout/topics.test.ts
  ```

  Expected: `7 passed`. Then:

  ```bash
  git add src/scout/topics.ts src/scout/topics.test.ts
  git commit -m "feat: add recentTopicTitles for the scorer dedupe context" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 19: Write the failing approve/reject tests**

  Extend the import line:

  ```ts
  import {
    approveTopics,
    insertTopics,
    knownHashes,
    RECENT_TITLES_LIMIT,
    recentTopicTitles,
    rejectTopics,
  } from './topics.js'
  ```

  Append:

  ```ts
  describe('approveTopics / rejectTopics', () => {
    it('approve flips candidates only and reports the changed count', () => {
      const db = openDb(':memory:')
      const a = seedTopic(db) // candidate
      const b = seedTopic(db, { status: 'used' })
      const c = seedTopic(db) // candidate
      // b is not a candidate and 9999 does not exist: both silently skipped
      expect(approveTopics(db, [a, b, c, 9999])).toBe(2)
      const statuses = db.prepare('SELECT id, status FROM topics ORDER BY id').all() as {
        id: number
        status: string
      }[]
      expect(statuses).toEqual([
        { id: a, status: 'approved' },
        { id: b, status: 'used' },
        { id: c, status: 'approved' },
      ])
      expect(approveTopics(db, [])).toBe(0)
      db.close()
    })

    it('reject flips candidate and approved, leaves claimed/used alone', () => {
      const db = openDb(':memory:')
      const a = seedTopic(db) // candidate
      const b = seedTopic(db, { status: 'approved' })
      const c = seedTopic(db, { status: 'claimed', jobId: 'job-1' })
      const d = seedTopic(db, { status: 'used' })
      expect(rejectTopics(db, [a, b, c, d])).toBe(2)
      const statuses = db.prepare('SELECT id, status FROM topics ORDER BY id').all() as {
        id: number
        status: string
      }[]
      expect(statuses).toEqual([
        { id: a, status: 'rejected' },
        { id: b, status: 'rejected' },
        { id: c, status: 'claimed' },
        { id: d, status: 'used' },
      ])
      expect(rejectTopics(db, [])).toBe(0)
      db.close()
    })
  })
  ```

- [ ] **Step 20: Run, observe the failure**

  ```bash
  pnpm vitest run src/scout/topics.test.ts
  ```

  Expected failure: `TypeError: approveTopics is not a function`.

- [ ] **Step 21: Implement approveTopics and rejectTopics**

  Append to `src/scout/topics.ts`:

  ```ts
  // Operator gate transitions. The status guard in the WHERE clause makes both
  // idempotent and blind to ids in the wrong state — the returned count is what
  // actually changed, which the CLI reports against ids.length.
  export function approveTopics(db: Database, ids: number[]): number {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(', ')
    return db
      .prepare(
        `UPDATE topics SET status = 'approved' WHERE id IN (${placeholders}) AND status = 'candidate'`,
      )
      .run(...ids).changes
  }

  export function rejectTopics(db: Database, ids: number[]): number {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(', ')
    return db
      .prepare(
        `UPDATE topics SET status = 'rejected' WHERE id IN (${placeholders}) AND status IN ('candidate','approved')`,
      )
      .run(...ids).changes
  }
  ```

- [ ] **Step 22: Run to green, commit**

  ```bash
  pnpm vitest run src/scout/topics.test.ts
  ```

  Expected: `9 passed`. Then:

  ```bash
  git add src/scout/topics.ts src/scout/topics.test.ts
  git commit -m "feat: add approve/reject topic transitions" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 23: Write the failing claim/markUsed tests**

  Extend the import line (alphabetical, matching house style):

  ```ts
  import {
    approveTopics,
    claimTopic,
    insertTopics,
    knownHashes,
    markTopicUsedByJob,
    RECENT_TITLES_LIMIT,
    recentTopicTitles,
    rejectTopics,
  } from './topics.js'
  ```

  Append:

  ```ts
  describe('claimTopic / markTopicUsedByJob', () => {
    it('claim binds the topic to its job and reports success', () => {
      const db = openDb(':memory:')
      const id = seedTopic(db, { status: 'approved' })
      expect(claimTopic(db, id, 'job-42')).toBe(true)
      const row = db.prepare('SELECT status, job_id FROM topics WHERE id = ?').get(id) as {
        status: string
        job_id: string | null
      }
      expect(row).toEqual({ status: 'claimed', job_id: 'job-42' })
      db.close()
    })

    it('claim never revives a rejected, used, or already-claimed topic', () => {
      const db = openDb(':memory:')
      for (const status of ['rejected', 'used', 'claimed'] as const) {
        const id = seedTopic(db, { status, jobId: 'job-old' })
        expect(claimTopic(db, id, 'job-new')).toBe(false)
        const row = db.prepare('SELECT status, job_id FROM topics WHERE id = ?').get(id) as {
          status: string
          job_id: string | null
        }
        expect(row).toEqual({ status, job_id: 'job-old' })
      }
      db.close()
    })

    it('markTopicUsedByJob flips only the claimed row with that job id', () => {
      const db = openDb(':memory:')
      const claimed = seedTopic(db, { status: 'claimed', jobId: 'job-42' })
      const other = seedTopic(db, { status: 'claimed', jobId: 'job-7' })
      markTopicUsedByJob(db, 'job-42')
      const statuses = db.prepare('SELECT id, status FROM topics ORDER BY id').all() as {
        id: number
        status: string
      }[]
      expect(statuses).toEqual([
        { id: claimed, status: 'used' },
        { id: other, status: 'claimed' },
      ])
      // manual `produce` jobs have no claimed topic: silent no-op
      expect(() => markTopicUsedByJob(db, 'job-unknown')).not.toThrow()
      db.close()
    })
  })
  ```

- [ ] **Step 24: Run, observe the failure**

  ```bash
  pnpm vitest run src/scout/topics.test.ts
  ```

  Expected failure: `TypeError: claimTopic is not a function`.

- [ ] **Step 25: Implement claimTopic and markTopicUsedByJob**

  Append to `src/scout/topics.ts`:

  ```ts
  // Claim = bind topic to job. Guarded so a rejected/used/claimed topic is
  // never revived even if a caller slips outside the produce lease; the boolean
  // lets produce-next treat a failed claim as the invariant breach it is.
  export function claimTopic(db: Database, topicId: number, jobId: string): boolean {
    const info = db
      .prepare(
        "UPDATE topics SET status = 'claimed', job_id = ? WHERE id = ? AND status IN ('candidate','approved')",
      )
      .run(jobId, topicId)
    return info.changes === 1
  }

  // Called when a job lands in the library; a job with no claimed topic
  // (manual `produce`) is a silent no-op.
  export function markTopicUsedByJob(db: Database, jobId: string): void {
    db.prepare("UPDATE topics SET status = 'used' WHERE job_id = ? AND status = 'claimed'").run(jobId)
  }
  ```

- [ ] **Step 26: Run to green, commit**

  ```bash
  pnpm vitest run src/scout/topics.test.ts
  ```

  Expected: `12 passed`. Then:

  ```bash
  git add src/scout/topics.ts src/scout/topics.test.ts
  git commit -m "feat: add topic claim and job-landed transitions" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 27: Write the failing listTopics tests**

  Add `listTopics` to the import list:

  ```ts
  import {
    approveTopics,
    claimTopic,
    insertTopics,
    knownHashes,
    listTopics,
    markTopicUsedByJob,
    RECENT_TITLES_LIMIT,
    recentTopicTitles,
    rejectTopics,
  } from './topics.js'
  ```

  Append:

  ```ts
  describe('listTopics', () => {
    it('maps rows to camelCase and returns newest first', () => {
      const db = openDb(':memory:')
      seedTopic(db, { title: 'old', createdAt: '2026-07-19T00:00:00.000Z' })
      const newestId = seedTopic(db, {
        title: 'new',
        rawTitle: 'raw new',
        source: 'rss:example.com',
        url: 'https://example.com/new',
        dedupeHash: 'h-new',
        score: 91,
        reason: 'hooky',
        status: 'claimed',
        jobId: 'job-1',
        createdAt: '2026-07-20T00:00:00.000Z',
      })
      const rows = listTopics(db)
      expect(rows.map((r) => r.title)).toEqual(['new', 'old'])
      expect(rows[0]).toEqual({
        id: newestId,
        channel: 'chan-a',
        title: 'new',
        rawTitle: 'raw new',
        source: 'rss:example.com',
        url: 'https://example.com/new',
        dedupeHash: 'h-new',
        score: 91,
        reason: 'hooky',
        status: 'claimed',
        jobId: 'job-1',
        createdAt: '2026-07-20T00:00:00.000Z',
      })
      db.close()
    })

    it('filters by channel and status independently', () => {
      const db = openDb(':memory:')
      seedTopic(db, { channel: 'chan-a', status: 'candidate' })
      seedTopic(db, { channel: 'chan-a', status: 'approved' })
      seedTopic(db, { channel: 'chan-b', status: 'approved' })
      expect(listTopics(db, { channel: 'chan-a' })).toHaveLength(2)
      expect(listTopics(db, { status: 'approved' })).toHaveLength(2)
      expect(listTopics(db, { channel: 'chan-a', status: 'approved' })).toHaveLength(1)
      db.close()
    })
  })
  ```

- [ ] **Step 28: Run, observe the failure**

  ```bash
  pnpm vitest run src/scout/topics.test.ts
  ```

  Expected failure: `TypeError: listTopics is not a function`.

- [ ] **Step 29: Implement listTopics (and the shared row mapper)**

  Add to `src/scout/topics.ts` — the mapper goes right after the `NewTopic` interface (it is shared with `eligibleTopic` next), `listTopics` at the bottom:

  ```ts
  const TOPIC_COLUMNS =
    'id, channel, title, raw_title, source, url, dedupe_hash, score, reason, status, job_id, created_at'

  interface DbTopicRow {
    id: number
    channel: string
    title: string
    raw_title: string
    source: string
    url: string
    dedupe_hash: string
    score: number
    reason: string
    status: TopicStatus
    job_id: string | null
    created_at: string
  }

  function toTopicRow(row: DbTopicRow): TopicRow {
    return {
      id: row.id,
      channel: row.channel,
      title: row.title,
      rawTitle: row.raw_title,
      source: row.source,
      url: row.url,
      dedupeHash: row.dedupe_hash,
      score: row.score,
      reason: row.reason,
      status: row.status,
      jobId: row.job_id,
      createdAt: row.created_at,
    }
  }
  ```

  ```ts
  export function listTopics(
    db: Database,
    filter?: { channel?: string; status?: TopicStatus },
  ): TopicRow[] {
    const where: string[] = []
    const params: string[] = []
    if (filter?.channel !== undefined) {
      where.push('channel = ?')
      params.push(filter.channel)
    }
    if (filter?.status !== undefined) {
      where.push('status = ?')
      params.push(filter.status)
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
    const rows = db
      .prepare(`SELECT ${TOPIC_COLUMNS} FROM topics${clause} ORDER BY created_at DESC, id DESC`)
      .all(...params) as DbTopicRow[]
    return rows.map(toTopicRow)
  }
  ```

- [ ] **Step 30: Run to green, commit**

  ```bash
  pnpm vitest run src/scout/topics.test.ts
  ```

  Expected: `14 passed`. Then:

  ```bash
  git add src/scout/topics.ts src/scout/topics.test.ts
  git commit -m "feat: add listTopics with channel/status filters" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 31: Write the failing eligibleTopic tests**

  Add `eligibleTopic` to the import list:

  ```ts
  import {
    approveTopics,
    claimTopic,
    eligibleTopic,
    insertTopics,
    knownHashes,
    listTopics,
    markTopicUsedByJob,
    RECENT_TITLES_LIMIT,
    recentTopicTitles,
    rejectTopics,
  } from './topics.js'
  ```

  Append:

  ```ts
  describe('eligibleTopic', () => {
    it('volume takes candidate or approved, highest score first', () => {
      const db = openDb(':memory:')
      seedTopic(db, { score: 70, status: 'candidate', title: 'runner-up' })
      seedTopic(db, { score: 90, status: 'approved', title: 'winner' })
      seedTopic(db, { score: 95, status: 'rejected', title: 'rejected' })
      seedTopic(db, { score: 99, status: 'used', title: 'used' })
      seedTopic(db, { score: 99, status: 'claimed', title: 'claimed', jobId: 'job-1' })
      const pick = eligibleTopic(db, 'chan-a', 'volume', { autoPremium: false })
      expect(pick?.title).toBe('winner')
      db.close()
    })

    it('premium requires approved unless autoPremium lifts the gate', () => {
      const db = openDb(':memory:')
      seedTopic(db, { score: 95, status: 'candidate', title: 'unapproved' })
      seedTopic(db, { score: 60, status: 'approved', title: 'approved' })
      expect(eligibleTopic(db, 'chan-a', 'premium', { autoPremium: false })?.title).toBe('approved')
      expect(eligibleTopic(db, 'chan-a', 'premium', { autoPremium: true })?.title).toBe('unapproved')
      db.close()
    })

    it('breaks score ties oldest first and returns null on an empty queue', () => {
      const db = openDb(':memory:')
      seedTopic(db, { score: 80, createdAt: '2026-07-20T02:00:00.000Z', title: 'later' })
      seedTopic(db, { score: 80, createdAt: '2026-07-20T01:00:00.000Z', title: 'earlier' })
      expect(eligibleTopic(db, 'chan-a', 'volume', { autoPremium: false })?.title).toBe('earlier')
      expect(eligibleTopic(db, 'chan-b', 'volume', { autoPremium: false })).toBeNull()
      db.close()
    })
  })
  ```

- [ ] **Step 32: Run, observe the failure**

  ```bash
  pnpm vitest run src/scout/topics.test.ts
  ```

  Expected failure: `TypeError: eligibleTopic is not a function`.

- [ ] **Step 33: Implement eligibleTopic**

  Append to `src/scout/topics.ts`:

  ```ts
  // Volume consumes the whole queue; premium takes operator-approved topics
  // only, unless the channel lifts the gate with auto_premium (design spec §5).
  export function eligibleTopic(
    db: Database,
    channel: string,
    tier: Tier,
    opts: { autoPremium: boolean },
  ): TopicRow | null {
    const statuses =
      tier === 'premium' && !opts.autoPremium ? ['approved'] : ['candidate', 'approved']
    const placeholders = statuses.map(() => '?').join(', ')
    const row = db
      .prepare(
        `SELECT ${TOPIC_COLUMNS} FROM topics WHERE channel = ? AND status IN (${placeholders}) ` +
          'ORDER BY score DESC, created_at ASC, id ASC LIMIT 1',
      )
      .get(channel, ...statuses) as DbTopicRow | undefined
    return row === undefined ? null : toTopicRow(row)
  }
  ```

- [ ] **Step 34: Run the task file to green**

  ```bash
  pnpm vitest run src/scout/topics.test.ts
  ```

  Expected: `17 passed`.

- [ ] **Step 35: Run the whole suite**

  ```bash
  pnpm vitest run
  ```

  Expected: every existing test file still green (the schema change is additive — `CREATE TABLE IF NOT EXISTS`), plus the new `src/scout/topics.test.ts` with 16 tests. 0 failures.

- [ ] **Step 36: Typecheck**

  ```bash
  pnpm tsc --noEmit
  ```

  Expected: no output, exit 0.

- [ ] **Step 37: Final commit**

  ```bash
  git add src/scout/topics.ts src/scout/topics.test.ts
  git commit -m "feat: add eligibleTopic tier-gated queue selection" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```


### Task 2: Channel `[scout]` config + `loadChannelsDir`

**Files:**
- Create: (none)
- Modify: `src/config/channel.ts`, `src/config/channel.test.ts`
- Modify (fixture propagation — the new required `ChannelConfig.scout` field breaks `pnpm tsc --noEmit` at every literal construction site): `src/stages/_testkit.ts`, `src/jobs/runner.test.ts`, `src/stages/visuals-volume.test.ts`, `src/stages/assemble.test.ts`
- Test: `src/config/channel.test.ts`

**Interfaces:**

Consumes (existing code in `src/config/channel.ts` — extended in place, existing exports unchanged):

```ts
export interface ChannelConfig {
  name: string; niche: string[]; tierMix: { volume: number; premium: number };
  voice: { volume: string; premium?: PremiumVoiceConfig }; premium: PremiumConfig;
  captionStyle: CaptionStyle; bgDir: string; bgmDir: string;
  budget: { perVideoUsdMicros: number; premiumPerVideoUsdMicros: number; perDayUsdMicros: number };
  scriptModel: string
}
export function loadChannelConfig(path: string): ChannelConfig
```

Produces (binding — Tasks 7, 10, 11, 13, 14 import these):

```ts
// src/config/channel.ts
export interface ScoutConfig {
  subreddits: string[]
  rss: string[]
  minScore: number
  perSourceLimit: number
  autoPremium: boolean
}
export const DEFAULT_SCOUT: ScoutConfig  // { subreddits: [], rss: [], minScore: 60, perSourceLimit: 25, autoPremium: false }
// ChannelConfig gains a REQUIRED member: scout: ScoutConfig
// TOML: [scout] subreddits (string[], default []), rss (string[], default []),
//        min_score (int 0..100, default 60), per_source_limit (int 1..100, default 25),
//        auto_premium (bool, default false). Absent [scout] table → DEFAULT_SCOUT whole.
export function loadChannelsDir(dir: string): ChannelConfig[]  // all <dir>/*.toml, sorted by channel name; throws on unparseable file
```

House style notes (match them): no semicolons in `src/config/` and `src/jobs/` (`src/stages/_testkit.ts` DOES use semicolons — keep its style when editing it), single quotes, trailing commas, zod raw schema in snake_case mapped to camelCase in the return object, defaults referenced from the exported default const (see `DEFAULT_PREMIUM`). ESM: relative imports end in `.js`.

- [ ] **Step 1: Failing test — `[scout]` table parsing, defaults, and validation**

  In `src/config/channel.test.ts`, change the import of the module under test to:

  ```ts
  import { DEFAULT_SCOUT, loadChannelConfig } from './channel.js'
  ```

  Append at the end of the file (`PLAN1_LINES` and `writeToml` already exist there; `PLAN1_LINES` ends with an empty string, so appended `[scout]` table lines start cleanly after `[budget]`):

  ```ts
  describe('[scout] config', () => {
    it('applies DEFAULT_SCOUT whole when the [scout] table is absent', () => {
      const cfg = loadChannelConfig(writeToml(PLAN1_LINES))
      expect(cfg.scout).toEqual({
        subreddits: [],
        rss: [],
        minScore: 60,
        perSourceLimit: 25,
        autoPremium: false,
      })
      expect(DEFAULT_SCOUT).toEqual({
        subreddits: [],
        rss: [],
        minScore: 60,
        perSourceLimit: 25,
        autoPremium: false,
      })
    })

    it('parses a full [scout] table into camelCase', () => {
      const cfg = loadChannelConfig(
        writeToml([
          ...PLAN1_LINES,
          '[scout]',
          'subreddits = ["space", "askscience"]',
          'rss = ["https://www.sciencedaily.com/rss/space_time.xml"]',
          'min_score = 75',
          'per_source_limit = 10',
          'auto_premium = true',
        ]),
      )
      expect(cfg.scout).toEqual({
        subreddits: ['space', 'askscience'],
        rss: ['https://www.sciencedaily.com/rss/space_time.xml'],
        minScore: 75,
        perSourceLimit: 10,
        autoPremium: true,
      })
    })

    it('applies per-field defaults inside a partial [scout] table', () => {
      const cfg = loadChannelConfig(writeToml([...PLAN1_LINES, '[scout]', 'subreddits = ["space"]']))
      expect(cfg.scout).toEqual({
        subreddits: ['space'],
        rss: [],
        minScore: 60,
        perSourceLimit: 25,
        autoPremium: false,
      })
    })

    it('rejects out-of-range scout numbers', () => {
      expect(() =>
        loadChannelConfig(writeToml([...PLAN1_LINES, '[scout]', 'min_score = 101'])),
      ).toThrow()
      expect(() =>
        loadChannelConfig(writeToml([...PLAN1_LINES, '[scout]', 'min_score = -1'])),
      ).toThrow()
      expect(() =>
        loadChannelConfig(writeToml([...PLAN1_LINES, '[scout]', 'per_source_limit = 0'])),
      ).toThrow()
      expect(() =>
        loadChannelConfig(writeToml([...PLAN1_LINES, '[scout]', 'per_source_limit = 101'])),
      ).toThrow()
    })
  })
  ```

  Run: `pnpm vitest run src/config/channel.test.ts`

  Expected failure: 4 new tests fail, 8 pre-existing tests still pass.
  - Tests 1–3: `AssertionError: expected undefined to deeply equal { subreddits: [], ... }` — `ChannelConfig` has no `scout` member yet (and `DEFAULT_SCOUT` is a missing named export, which esbuild resolves to `undefined` at runtime rather than failing the import).
  - Test 4: `expected [Function] to throw an error` — the zod raw schema strips the unknown `scout` key, so out-of-range values parse fine today.

- [ ] **Step 2: Implement — ScoutConfig, DEFAULT_SCOUT, `[scout]` schema + mapping**

  Four edits inside `src/config/channel.ts`:

  (a) After the `PremiumConfig` interface (before `ChannelConfig`), add:

  ```ts
  export interface ScoutConfig {
    subreddits: string[]
    rss: string[]
    minScore: number
    perSourceLimit: number
    autoPremium: boolean
  }
  ```

  (b) In `ChannelConfig`, add a final member after `scriptModel: string`:

  ```ts
    scout: ScoutConfig
  ```

  (c) After the `DEFAULT_PREMIUM` const, add:

  ```ts
  /**
   * Defaults for the [scout] TOML table: applied whole when the table is
   * absent, per-field (via the zod defaults below) when it is partial. Empty
   * source lists mean the scout skips this channel; manual produce still works.
   */
  export const DEFAULT_SCOUT: ScoutConfig = {
    subreddits: [],
    rss: [],
    minScore: 60,
    perSourceLimit: 25,
    autoPremium: false,
  }
  ```

  (d) In `rawSchema`, after the `premium` field (before `caption_style`), add:

  ```ts
    scout: z
      .object({
        subreddits: z.array(z.string()).default([]),
        rss: z.array(z.string()).default([]),
        min_score: z.number().int().min(0).max(100).default(DEFAULT_SCOUT.minScore),
        per_source_limit: z.number().int().min(1).max(100).default(DEFAULT_SCOUT.perSourceLimit),
        auto_premium: z.boolean().default(DEFAULT_SCOUT.autoPremium),
      })
      .optional(),
  ```

  (e) In the `loadChannelConfig` return object, after `scriptModel: raw.script_model,`, add:

  ```ts
      scout: raw.scout
        ? {
            subreddits: raw.scout.subreddits,
            rss: raw.scout.rss,
            minScore: raw.scout.min_score,
            perSourceLimit: raw.scout.per_source_limit,
            autoPremium: raw.scout.auto_premium,
          }
        : { ...DEFAULT_SCOUT },
  ```

  Run: `pnpm vitest run src/config/channel.test.ts` — expect `Test Files  1 passed (1)`, `Tests  12 passed (12)`.

- [ ] **Step 3: Propagate the required `scout` field to the ChannelConfig fixtures**

  Run: `pnpm tsc --noEmit`

  Expected failure: 4 errors, all `Property 'scout' is missing in type '{ ... }' but required in type 'ChannelConfig'`, at the literal construction sites in `src/stages/_testkit.ts` (`testChannel`), `src/jobs/runner.test.ts` (`testChannel`), `src/stages/visuals-volume.test.ts` (`makeChannel`), and `src/stages/assemble.test.ts` (`makeChannel`).

  Fix all four (each fixture gets the defaults, mirroring how `testChannel` already spreads `DEFAULT_PREMIUM`):

  (a) `src/stages/_testkit.ts` — this file uses semicolons; keep them. Change

  ```ts
  import { DEFAULT_PREMIUM } from '../config/channel.js';
  ```

  to

  ```ts
  import { DEFAULT_PREMIUM, DEFAULT_SCOUT } from '../config/channel.js';
  ```

  and in the `testChannel` return object, after `scriptModel: 'claude-sonnet-5',` (before `...overrides,`), add:

  ```ts
      scout: { ...DEFAULT_SCOUT },
  ```

  (b) `src/jobs/runner.test.ts` — directly above the line `import type { ChannelConfig } from '../config/channel.js'`, add:

  ```ts
  import { DEFAULT_SCOUT } from '../config/channel.js'
  ```

  and in the `testChannel()` return object, after `scriptModel: 'claude-sonnet-5',`, add:

  ```ts
      scout: { ...DEFAULT_SCOUT },
  ```

  (c) `src/stages/visuals-volume.test.ts` — directly above the line `import type { ChannelConfig } from '../config/channel.js'`, add:

  ```ts
  import { DEFAULT_SCOUT } from '../config/channel.js'
  ```

  and in the `makeChannel` return object, after `scriptModel: 'claude-sonnet-5',`, add:

  ```ts
      scout: { ...DEFAULT_SCOUT },
  ```

  (d) `src/stages/assemble.test.ts` — directly above the line `import type { ChannelConfig } from '../config/channel.js'`, add:

  ```ts
  import { DEFAULT_SCOUT } from '../config/channel.js'
  ```

  and in the `makeChannel` return object, after `scriptModel: 'claude-sonnet-5',`, add:

  ```ts
      scout: { ...DEFAULT_SCOUT },
  ```

  Run: `pnpm tsc --noEmit` — expect no output, exit 0.
  Run: `pnpm vitest run` — expect every test file to pass, zero failures (fixtures were only missing a type-level field; runtime behavior is unchanged).

- [ ] **Step 4: Commit the `[scout]` config**

  ```bash
  git add src/config/channel.ts src/config/channel.test.ts src/stages/_testkit.ts src/jobs/runner.test.ts src/stages/visuals-volume.test.ts src/stages/assemble.test.ts
  git commit -m "$(cat <<'EOF'
  feat: add [scout] channel config table with defaults

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 5: Failing test — loadChannelsDir**

  In `src/config/channel.test.ts`, change the import of the module under test to its final form:

  ```ts
  import { DEFAULT_SCOUT, loadChannelConfig, loadChannelsDir } from './channel.js'
  ```

  Append at the end of the file:

  ```ts
  describe('loadChannelsDir', () => {
    function writeDir(files: Record<string, string[]>): string {
      const dir = mkdtempSync(join(tmpdir(), 'chans-'))
      for (const [name, lines] of Object.entries(files)) {
        writeFileSync(join(dir, name), lines.join('\n'))
      }
      return dir
    }

    function named(name: string): string[] {
      return PLAN1_LINES.map((l) => (l === 'name = "legacy"' ? `name = "${name}"` : l))
    }

    it('loads every *.toml sorted by channel name, ignoring other files', () => {
      const dir = writeDir({
        'zzz.toml': named('alpha'), // filename order deliberately ≠ channel-name order
        'aaa.toml': named('zeta'),
        'notes.txt': ['not a channel'],
      })
      const configs = loadChannelsDir(dir)
      expect(configs.map((c) => c.name)).toEqual(['alpha', 'zeta'])
      expect(configs[0].scout).toEqual(DEFAULT_SCOUT)
    })

    it('returns [] for an empty directory', () => {
      expect(loadChannelsDir(mkdtempSync(join(tmpdir(), 'chans-')))).toEqual([])
    })

    it('throws naming the unparseable file', () => {
      const dir = writeDir({
        'good.toml': named('good'),
        'bad.toml': ['name = "broken"', 'niche = "not-an-array"'],
      })
      expect(() => loadChannelsDir(dir)).toThrow(/bad\.toml/)
    })

    it('throws when the directory does not exist', () => {
      expect(() => loadChannelsDir('/nope/definitely/missing')).toThrow()
    })
  })
  ```

  Run: `pnpm vitest run src/config/channel.test.ts`

  Expected failure: all 4 new tests fail because the named export does not exist yet (esbuild resolves it to `undefined` at runtime) — but the failure TEXT differs by call shape: the direct calls surface the raw `TypeError: loadChannelsDir is not a function`, while the two `expect(() => …).toThrow(…)` tests catch that TypeError inside the matcher and report it as an assertion mismatch naming the TypeError message instead of the expected pattern. Both shapes are the same red. The 12 earlier tests still pass.

- [ ] **Step 6: Implement — loadChannelsDir**

  In `src/config/channel.ts`, change the node imports at the top to:

  ```ts
  import { readdirSync, readFileSync } from 'node:fs'
  import { join } from 'node:path'
  ```

  Append at the end of the file:

  ```ts
  /**
   * Loads every channel TOML in a directory — the scout/loop enumeration.
   * Sorted by channel name (code-unit order, locale-independent) so tick
   * planning is deterministic. An unparseable file throws, naming the file:
   * a broken channel config is a config error, not a channel to skip.
   */
  export function loadChannelsDir(dir: string): ChannelConfig[] {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.toml'))
      .sort()
    const configs = files.map((file) => {
      const path = join(dir, file)
      try {
        return loadChannelConfig(path)
      } catch (err) {
        throw new Error(`failed to load channel config ${path}: ${(err as Error).message}`)
      }
    })
    return configs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }
  ```

  Run: `pnpm vitest run src/config/channel.test.ts` — expect `Test Files  1 passed (1)`, `Tests  16 passed (16)`.

- [ ] **Step 7: Whole-suite gate**

  Run: `pnpm vitest run`

  Expected: every test file passes, zero failures. Contract tests are excluded by default (`CONTRACT` unset) — do not set it.

- [ ] **Step 8: Typecheck gate**

  Run: `pnpm tsc --noEmit`

  Expected: no output, exit 0.

- [ ] **Step 9: Commit loadChannelsDir and close the task**

  ```bash
  git add src/config/channel.ts src/config/channel.test.ts
  git commit -m "$(cat <<'EOF'
  feat: add loadChannelsDir channel enumeration

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```


### Task 3: TrendSource types + dedupeHash + RedditSource

**Files:**
- Create: `src/scout/sources/types.ts`, `src/scout/sources/reddit.ts`, `src/scout/sources/reddit.test.ts`
- Modify: none
- Test: `src/scout/sources/reddit.test.ts`

**Interfaces:**

Consumes: nothing from earlier plan tasks — only runtime globals (`fetch`, `AbortSignal`, `Response` are native in Node >= 22; the tsconfig `lib` includes DOM so they typecheck) and `node:crypto`. Creating the first file creates the `src/scout/sources/` directory.

Produces (binding — Task 4's `rssSource` implements `TrendSource` and reuses `FetchLike`; Task 7's `scoutChannel` builds sources via `redditSource`, hashes candidates via `dedupeHash`, and passes `SOURCE_FETCH_TIMEOUT_MS`):

```ts
// src/scout/sources/types.ts
export interface TrendCandidate { title: string; url: string; sourceId: string; externalId: string }
export interface TrendSourceFetchOpts { limit: number; timeoutMs: number }
export interface TrendSource { readonly id: string; fetch(opts: TrendSourceFetchOpts): Promise<TrendCandidate[]> }
export type FetchLike = typeof globalThis.fetch
export function dedupeHash(sourceId: string, externalId: string): string  // sha256 hex of `${sourceId}\n${externalId}` (node:crypto)
export const SOURCE_FETCH_TIMEOUT_MS = 10_000

// src/scout/sources/reddit.ts
export const REDDIT_USER_AGENT = 'brainrot-machine/0.1 (personal short-form pipeline; single operator)'
export function redditSource(subreddit: string, fetchImpl?: FetchLike): TrendSource
// id/sourceId = `reddit:r/${subreddit}`
// GET https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}&raw_json=1
// headers: { 'User-Agent': REDDIT_USER_AGENT }; AbortSignal.timeout(timeoutMs)
// non-2xx → throw; children[].data: skip stickied === true;
// externalId = data.name (t3_xyz fullname); url = 'https://www.reddit.com' + data.permalink
```

House test pattern applies: injectable `fetchImpl` with canned `Response` objects, never live network — same shape as `src/providers/elevenlabs.test.ts`'s `fakeFetch`.

---

- [ ] **Step 1: Write the failing dedupeHash + timeout-constant tests**

  Create `src/scout/sources/reddit.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest'
  import { SOURCE_FETCH_TIMEOUT_MS, dedupeHash } from './types.js'

  describe('dedupeHash', () => {
    it('is the sha256 hex of sourceId + newline + externalId', () => {
      // printf 'reddit:r/space\nt3_abc' | shasum -a 256
      expect(dedupeHash('reddit:r/space', 't3_abc')).toBe(
        '543177266c3fc519b4f49513548b8109762f1e86010a941570d86885ac5b0f0a',
      )
    })

    it('is stable across calls, distinct across items, and lowercase hex', () => {
      expect(dedupeHash('rss:example.com', 'guid-1')).toBe(dedupeHash('rss:example.com', 'guid-1'))
      expect(dedupeHash('rss:example.com', 'guid-1')).not.toBe(
        dedupeHash('rss:example.com', 'guid-2'),
      )
      expect(dedupeHash('rss:example.com', 'guid-1')).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('SOURCE_FETCH_TIMEOUT_MS', () => {
    it('defaults to 10 seconds', () => {
      expect(SOURCE_FETCH_TIMEOUT_MS).toBe(10_000)
    })
  })
  ```

  Run: `pnpm vitest run src/scout/sources/reddit.test.ts`

  Expected failure: the whole file errors at import time — `Error: Failed to resolve import "./types.js" from "src/scout/sources/reddit.test.ts". Does the file exist?` (the module does not exist yet, so this is a resolution error, not the missing-named-export TypeError).

- [ ] **Step 2: Implement types.ts, run green, commit**

  Create `src/scout/sources/types.ts`:

  ```ts
  import { createHash } from 'node:crypto'

  export interface TrendCandidate {
    title: string
    url: string
    sourceId: string
    externalId: string
  }

  export interface TrendSourceFetchOpts {
    limit: number
    timeoutMs: number
  }

  export interface TrendSource {
    readonly id: string
    fetch(opts: TrendSourceFetchOpts): Promise<TrendCandidate[]>
  }

  export type FetchLike = typeof globalThis.fetch

  // A hung feed must not wedge the scout; the next cron firing is the retry.
  export const SOURCE_FETCH_TIMEOUT_MS = 10_000

  // Stable per-item identity feeding UNIQUE (channel, dedupe_hash) in topics.
  // The newline delimiter keeps the sourceId/externalId concatenation unambiguous.
  export function dedupeHash(sourceId: string, externalId: string): string {
    return createHash('sha256').update(`${sourceId}\n${externalId}`).digest('hex')
  }
  ```

  Run: `pnpm vitest run src/scout/sources/reddit.test.ts`

  Expected: `Test Files  1 passed (1)`, `Tests  3 passed (3)`.

  Commit:

  ```bash
  git add src/scout/sources/types.ts src/scout/sources/reddit.test.ts
  git commit -m "$(cat <<'EOF'
  feat: TrendSource types and sha256 dedupe identity

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 3: Write the failing redditSource happy-path tests**

  In `src/scout/sources/reddit.test.ts`, replace the import block with:

  ```ts
  import { afterEach, describe, expect, it, vi } from 'vitest'
  import { SOURCE_FETCH_TIMEOUT_MS, dedupeHash } from './types.js'
  import { REDDIT_USER_AGENT, redditSource } from './reddit.js'

  afterEach(() => {
    vi.restoreAllMocks()
  })
  ```

  Then append at the end of the file:

  ```ts
  // Trimmed /r/space/hot.json listing: one stickied mod post, two real posts.
  const HOT_FIXTURE = {
    kind: 'Listing',
    data: {
      children: [
        {
          kind: 't3',
          data: {
            name: 't3_sticky',
            title: 'Monthly launch discussion thread',
            permalink: '/r/space/comments/sticky/monthly/',
            stickied: true,
          },
        },
        {
          kind: 't3',
          data: {
            name: 't3_abc',
            title: 'JWST finds water ice in a protoplanetary disk',
            permalink: '/r/space/comments/abc/jwst_finds_water_ice/',
            stickied: false,
          },
        },
        {
          kind: 't3',
          data: {
            name: 't3_def',
            title: 'Starship booster catch, third attempt',
            permalink: '/r/space/comments/def/starship_booster_catch/',
            stickied: false,
          },
        },
      ],
    },
  }

  // Injectable fetch: captures every call, answers with one canned JSON response.
  function fakeFetch(status: number, body: unknown) {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const impl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }
    return { impl, calls }
  }

  describe('redditSource', () => {
    it('GETs hot.json with the descriptive UA and a timeout signal', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
      const { impl, calls } = fakeFetch(200, HOT_FIXTURE)
      const source = redditSource('space', impl)
      expect(source.id).toBe('reddit:r/space')
      await source.fetch({ limit: 25, timeoutMs: 9_000 })
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe('https://www.reddit.com/r/space/hot.json?limit=25&raw_json=1')
      const init = calls[0].init!
      expect((init.headers as Record<string, string>)['User-Agent']).toBe(REDDIT_USER_AGENT)
      expect(init.signal).toBeInstanceOf(AbortSignal)
      expect(timeoutSpy).toHaveBeenCalledWith(9_000)
    })

    it('maps posts to TrendCandidates and skips stickied posts', async () => {
      const { impl } = fakeFetch(200, HOT_FIXTURE)
      const source = redditSource('space', impl)
      const candidates = await source.fetch({ limit: 25, timeoutMs: 10_000 })
      expect(candidates).toEqual([
        {
          title: 'JWST finds water ice in a protoplanetary disk',
          url: 'https://www.reddit.com/r/space/comments/abc/jwst_finds_water_ice/',
          sourceId: 'reddit:r/space',
          externalId: 't3_abc',
        },
        {
          title: 'Starship booster catch, third attempt',
          url: 'https://www.reddit.com/r/space/comments/def/starship_booster_catch/',
          sourceId: 'reddit:r/space',
          externalId: 't3_def',
        },
      ])
    })
  })
  ```

  Run: `pnpm vitest run src/scout/sources/reddit.test.ts`

  Expected failure: the whole file errors at import time — `Error: Failed to resolve import "./reddit.js" from "src/scout/sources/reddit.test.ts". Does the file exist?` (the three passing tests from Step 2 cannot run either while the file fails to load).

- [ ] **Step 4: Implement redditSource minimally, run green, commit**

  Create `src/scout/sources/reddit.ts` (well-formed listing shape only; the non-2xx guard and malformed-child hardening arrive in the next two cycles):

  ```ts
  import type { FetchLike, TrendCandidate, TrendSource, TrendSourceFetchOpts } from './types.js'

  // Reddit blocks default library user agents; a descriptive UA is the
  // documented convention for unauthenticated JSON listing access.
  export const REDDIT_USER_AGENT =
    'brainrot-machine/0.1 (personal short-form pipeline; single operator)'

  // Wire shape of GET /r/<sub>/hot.json (public listing endpoint, no auth).
  interface RedditChild {
    data: { name: string; title: string; permalink: string; stickied: boolean }
  }
  interface RedditListing {
    data: { children: RedditChild[] }
  }

  export function redditSource(subreddit: string, fetchImpl: FetchLike = fetch): TrendSource {
    const id = `reddit:r/${subreddit}`
    return {
      id,
      async fetch({ limit, timeoutMs }: TrendSourceFetchOpts): Promise<TrendCandidate[]> {
        // raw_json=1 stops reddit HTML-entity-escaping &, <, > inside titles.
        const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}&raw_json=1`
        const res = await fetchImpl(url, {
          headers: { 'User-Agent': REDDIT_USER_AGENT },
          signal: AbortSignal.timeout(timeoutMs),
        })
        const body = (await res.json()) as RedditListing
        const candidates: TrendCandidate[] = []
        for (const child of body.data.children) {
          const post = child.data
          // Stickied posts are mod announcements, not trends.
          if (post.stickied === true) continue
          candidates.push({
            title: post.title,
            url: `https://www.reddit.com${post.permalink}`,
            sourceId: id,
            externalId: post.name,
          })
        }
        return candidates
      },
    }
  }
  ```

  Run: `pnpm vitest run src/scout/sources/reddit.test.ts`

  Expected: `Test Files  1 passed (1)`, `Tests  5 passed (5)`.

  Commit:

  ```bash
  git add src/scout/sources/reddit.ts src/scout/sources/reddit.test.ts
  git commit -m "$(cat <<'EOF'
  feat: redditSource hot.json adapter with sticky skip

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 5: Write the failing non-2xx test**

  Append inside the `describe('redditSource', ...)` block in `src/scout/sources/reddit.test.ts`:

  ```ts
    it('throws with the HTTP status on a non-2xx response', async () => {
      const { impl } = fakeFetch(429, { message: 'Too Many Requests' })
      const source = redditSource('space', impl)
      await expect(source.fetch({ limit: 25, timeoutMs: 10_000 })).rejects.toThrow(
        /r\/space responded 429/,
      )
    })
  ```

  Run: `pnpm vitest run src/scout/sources/reddit.test.ts`

  Expected failure: 1 test fails. The Step 4 implementation parses the 429 body as a listing; `body.data` is undefined, so `body.data.children` rejects with `TypeError: Cannot read properties of undefined (reading 'children')` — the wrong error, so vitest reports `AssertionError: expected error to match /r\/space responded 429/`. The 5 existing tests pass.

- [ ] **Step 6: Add the non-2xx guard, run green, commit**

  In `src/scout/sources/reddit.ts`, insert between the `fetchImpl(...)` call and the `res.json()` line:

  ```ts
        if (!res.ok) {
          throw new Error(`redditSource: r/${subreddit} responded ${res.status}`)
        }
  ```

  Run: `pnpm vitest run src/scout/sources/reddit.test.ts`

  Expected: `Test Files  1 passed (1)`, `Tests  6 passed (6)`.

  Commit:

  ```bash
  git add src/scout/sources/reddit.ts src/scout/sources/reddit.test.ts
  git commit -m "$(cat <<'EOF'
  feat: redditSource surfaces non-2xx listing responses

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 7: Write the failing malformed-children test**

  Append inside the `describe('redditSource', ...)` block:

  ```ts
    it('skips children missing data, name, title, or permalink; empty listing yields []', async () => {
      const { impl } = fakeFetch(200, {
        data: {
          children: [
            { kind: 't3' }, // no data object at all
            {
              kind: 't3',
              data: { name: 't3_x1', permalink: '/r/space/comments/x1/a/', stickied: false },
            }, // no title
            {
              kind: 't3',
              data: { title: 'No fullname', permalink: '/r/space/comments/x2/b/', stickied: false },
            }, // no name
            { kind: 't3', data: { name: 't3_x3', title: 'No permalink', stickied: false } },
            {
              kind: 't3',
              data: {
                name: 't3_ok',
                title: 'Intact post',
                permalink: '/r/space/comments/ok/c/',
                stickied: false,
              },
            },
          ],
        },
      })
      const source = redditSource('space', impl)
      expect(await source.fetch({ limit: 25, timeoutMs: 10_000 })).toEqual([
        {
          title: 'Intact post',
          url: 'https://www.reddit.com/r/space/comments/ok/c/',
          sourceId: 'reddit:r/space',
          externalId: 't3_ok',
        },
      ])

      const empty = fakeFetch(200, {})
      expect(await redditSource('space', empty.impl).fetch({ limit: 25, timeoutMs: 10_000 })).toEqual(
        [],
      )
    })
  ```

  Run: `pnpm vitest run src/scout/sources/reddit.test.ts`

  Expected failure: 1 test fails with `TypeError: Cannot read properties of undefined (reading 'stickied')` — the `{ kind: 't3' }` child has no `data`, and the Step 4 implementation dereferences it unguarded. The 6 existing tests pass.

- [ ] **Step 8: Harden the listing parse**

  In `src/scout/sources/reddit.ts`, replace the two wire-shape interfaces with the optional-field versions:

  ```ts
  // Wire shape of GET /r/<sub>/hot.json (public listing endpoint, no auth).
  // Every field is optional on the wire: a child that cannot yield a complete
  // TrendCandidate is skipped, never crashed on.
  interface RedditChild {
    data?: { name?: string; title?: string; permalink?: string; stickied?: boolean }
  }
  interface RedditListing {
    data?: { children?: RedditChild[] }
  }
  ```

  and replace the `for` loop with:

  ```ts
        for (const child of body.data?.children ?? []) {
          const post = child.data
          // Stickied posts are mod announcements, not trends.
          if (!post || post.stickied === true) continue
          if (!post.name || !post.title || !post.permalink) continue
          candidates.push({
            title: post.title,
            url: `https://www.reddit.com${post.permalink}`,
            sourceId: id,
            externalId: post.name,
          })
        }
  ```

  Run: `pnpm vitest run src/scout/sources/reddit.test.ts`

  Expected: `Test Files  1 passed (1)`, `Tests  7 passed (7)`.

- [ ] **Step 8a: Write the limit-cap and timeout-path tests (red)**

  Append inside `describe('redditSource', ...)`:

  ```ts
    it('caps candidates at the requested limit even when the listing over-returns', async () => {
      const { impl } = fakeFetch(200, HOT_FIXTURE)
      const source = redditSource('space', impl)
      const candidates = await source.fetch({ limit: 1, timeoutMs: 10_000 })
      expect(candidates).toHaveLength(1)
      expect(candidates[0].externalId).toBe('t3_abc')
    })

    it('rejects when the fetch times out, so the orchestrator can isolate it', async () => {
      const impl: FetchLike = () =>
        Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
      const source = redditSource('space', impl)
      await expect(source.fetch({ limit: 25, timeoutMs: 10 })).rejects.toThrow(/timeout/i)
    })
  ```

  (Extend the type-only import in the test file with `FetchLike` if it is not
  already imported.)

  Run: `pnpm vitest run src/scout/sources/reddit.test.ts`

  Expected: the cap test fails with `expected [ …(2) ] to have a length of 1` —
  the query string asks Reddit for `limit` posts but nothing enforces it
  locally, so the spec §8 bounded-prompt cap currently rests on the remote API
  honoring its parameter. The timeout test passes on arrival: it pins that a
  timeout rejection propagates out of `fetch` (the source must NOT swallow it —
  isolation is the orchestrator's job).

- [ ] **Step 8b: Enforce the limit client-side (green)**

  In `src/scout/sources/reddit.ts`, replace the `return candidates` line with:

  ```ts
        // Hard cap regardless of what the listing returned: the Σ per_source_limit
        // prompt bound (spec §8) must not rest on reddit honoring its query param.
        return candidates.slice(0, limit)
  ```

  Run: `pnpm vitest run src/scout/sources/reddit.test.ts`

  Expected: `Test Files  1 passed (1)`, `Tests  9 passed (9)`.

- [ ] **Step 8c: Commit the cap and timeout pin**

  ```bash
  git add src/scout/sources/reddit.ts src/scout/sources/reddit.test.ts
  git commit -m "$(cat <<'EOF'
  feat: cap redditSource candidates client-side and pin timeout propagation

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 9: Whole-suite gate, typecheck, final commit**

  Run: `pnpm vitest run`

  Expected: every test file passes, 0 failures (this task adds files only; nothing existing is touched).

  Run: `pnpm tsc --noEmit`

  Expected: exits 0 with no output.

  Commit:

  ```bash
  git add src/scout/sources/reddit.ts src/scout/sources/reddit.test.ts
  git commit -m "$(cat <<'EOF'
  feat: redditSource skips malformed listing children

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```


### Task 4: RssSource (fast-xml-parser)

**Files:**
- Create: `src/scout/sources/rss.ts`
- Create: `src/scout/sources/rss.test.ts` (test)
- Modify: `package.json` (plus `pnpm-lock.yaml`, via `pnpm add`)

**Interfaces:**

Consumes (produced by Task 3 in `src/scout/sources/types.ts` — exact signatures):

```ts
export interface TrendCandidate { title: string; url: string; sourceId: string; externalId: string }
export interface TrendSourceFetchOpts { limit: number; timeoutMs: number }
export interface TrendSource { readonly id: string; fetch(opts: TrendSourceFetchOpts): Promise<TrendCandidate[]> }
export type FetchLike = typeof globalThis.fetch
```

(`dedupeHash` from types.ts is NOT used here — hashing happens in the Task 7 scout orchestrator.)

Produces (binding — the Task 7 orchestrator calls this exactly as specified):

```ts
// src/scout/sources/rss.ts
export function rssSource(feedUrl: string, fetchImpl?: FetchLike): TrendSource
// id/sourceId = `rss:${new URL(feedUrl).hostname}`
// Parses RSS 2.0 (rss.channel.item[]) AND Atom (feed.entry[]) via fast-xml-parser;
// single-item feeds (parser yields object, not array) MUST be normalized.
// externalId: RSS guid (string or {'#text'}) → Atom id → item link. Missing title or resolvable id → skip item.
// AbortSignal.timeout(timeoutMs); non-2xx → throw.
```

House style notes (match the surrounding code): no semicolons in new `src/scout/` files, single quotes, 2-space indent, trailing commas, explicit return types on exported functions. Error messages follow the provider shape `rssSource: <detail>` (compare `synthWithTimestamps: elevenlabs responded ${status}` in `src/providers/elevenlabs.ts`). Tests use the injectable-fetch pattern from `src/providers/elevenlabs.test.ts` — stub `fetchImpl`, never live network. XML fixtures live inline in the test file as template strings (house fixtures for HTTP payloads are inline; `tests-fixtures/` is reserved for golden-path assets).

- [ ] **Step 1: Add the fast-xml-parser dependency (the ONE new dependency of this plan)**

  From the repo root:

  ```bash
  pnpm add fast-xml-parser
  ```

  If pnpm refuses with `ERR_PNPM_ADDING_TO_ROOT` (the repo has a `pnpm-workspace.yaml`, which some pnpm versions treat as a workspace root), run instead:

  ```bash
  pnpm add -w fast-xml-parser
  ```

  Expected result: `package.json` `dependencies` gains a caret entry for `fast-xml-parser` (v5 line at time of writing; exact minor per registry) and `pnpm-lock.yaml` updates. Verify the import surface used below exists:

  ```bash
  node -e "import('fast-xml-parser').then((m) => console.log(typeof m.XMLParser))"
  ```

  Expected output: `function`.

  Commit:

  ```bash
  git add package.json pnpm-lock.yaml
  git commit -m "chore: add fast-xml-parser for the rss scout source" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 2: Failing test — id derivation and RSS 2.0 happy path**

  Create `src/scout/sources/rss.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest'
  import { rssSource } from './rss.js'

  // Injectable fetch: captures every call, answers with one canned XML response.
  function fakeFetch(status: number, body: string) {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const impl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init })
      return new Response(body, { status, headers: { 'content-type': 'application/xml' } })
    }
    return { impl, calls }
  }

  const OPTS = { limit: 25, timeoutMs: 10_000 }

  const RSS_FEED = `<?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0">
    <channel>
      <title>Example Space News</title>
      <link>https://feeds.example.com/space</link>
      <item>
        <title>Astronomers spot a rogue planet</title>
        <link>https://feeds.example.com/releases/a.htm</link>
        <guid>ex-a-2026</guid>
      </item>
      <item>
        <title>New telescope sees first light</title>
        <link>https://feeds.example.com/releases/b.htm</link>
        <guid>https://feeds.example.com/releases/b.htm</guid>
      </item>
      <item>
        <title>Rover finds layered ice</title>
        <link>https://feeds.example.com/releases/c.htm</link>
        <guid>ex-c-2026</guid>
      </item>
    </channel>
  </rss>`

  describe('rssSource', () => {
    it('derives its id from the feed hostname', () => {
      expect(rssSource('https://feeds.example.com/space.xml').id).toBe('rss:feeds.example.com')
    })

    it('fetches the feed with a timeout signal and maps RSS 2.0 items', async () => {
      const { impl, calls } = fakeFetch(200, RSS_FEED)
      const source = rssSource('https://feeds.example.com/space.xml', impl)
      const candidates = await source.fetch(OPTS)

      // Request shape: the feed URL itself, with an abort signal attached.
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe('https://feeds.example.com/space.xml')
      expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal)

      expect(candidates).toEqual([
        {
          title: 'Astronomers spot a rogue planet',
          url: 'https://feeds.example.com/releases/a.htm',
          sourceId: 'rss:feeds.example.com',
          externalId: 'ex-a-2026',
        },
        {
          title: 'New telescope sees first light',
          url: 'https://feeds.example.com/releases/b.htm',
          sourceId: 'rss:feeds.example.com',
          externalId: 'https://feeds.example.com/releases/b.htm',
        },
        {
          title: 'Rover finds layered ice',
          url: 'https://feeds.example.com/releases/c.htm',
          sourceId: 'rss:feeds.example.com',
          externalId: 'ex-c-2026',
        },
      ])
    })

    it('caps results at opts.limit client-side', async () => {
      const { impl } = fakeFetch(200, RSS_FEED)
      const source = rssSource('https://feeds.example.com/space.xml', impl)
      const candidates = await source.fetch({ ...OPTS, limit: 2 })
      expect(candidates.map((c) => c.externalId)).toEqual([
        'ex-a-2026',
        'https://feeds.example.com/releases/b.htm',
      ])
    })
  })
  ```

  Run: `pnpm vitest run src/scout/sources/rss.test.ts`

  Expected failure: the test file fails to load — `./rss.js` does not exist yet, so vitest reports `Failed to resolve import "./rss.js" from "src/scout/sources/rss.test.ts". Does the file exist?` (a module-load error, not an assertion failure).

- [ ] **Step 3: Implement — rssSource with RSS 2.0 parsing, run green, commit**

  Create `src/scout/sources/rss.ts`:

  ```ts
  import { XMLParser } from 'fast-xml-parser'
  import type { FetchLike, TrendCandidate, TrendSource, TrendSourceFetchOpts } from './types.js'

  // Attributes stay on: an Atom <link> carries its URL as @_href, and an RSS
  // <guid isPermaLink="..."> parses to { '#text': ..., '@_isPermaLink': ... }.
  const parser = new XMLParser({ ignoreAttributes: false })

  // Element shapes of interest in fast-xml-parser output. Leaves stay loose:
  // real-world feeds omit and duplicate elements freely, so every field is
  // probed, never trusted.
  interface ParsedFeed {
    rss?: { channel?: { item?: Record<string, unknown> | Record<string, unknown>[] } }
    feed?: { entry?: Record<string, unknown> | Record<string, unknown>[] }
  }

  // Text of a parsed node: plain scalar, or the '#text' of an attributed node.
  // Numeric-looking values arrive as numbers (parseTagValue is on by default).
  function text(value: unknown): string | undefined {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      return trimmed === '' ? undefined : trimmed
    }
    if (typeof value === 'number') return String(value)
    if (typeof value === 'object' && value !== null && '#text' in value) {
      return text((value as Record<string, unknown>)['#text'])
    }
    return undefined
  }

  function rssItems(items: Record<string, unknown>[], sourceId: string): TrendCandidate[] {
    const out: TrendCandidate[] = []
    for (const item of items) {
      const title = text(item.title)
      const link = text(item.link)
      const externalId = text(item.guid)
      // No title or no stable identity → the item can be neither scored nor deduped.
      if (title === undefined || externalId === undefined) continue
      out.push({ title, url: link ?? '', sourceId, externalId })
    }
    return out
  }

  export function rssSource(feedUrl: string, fetchImpl: FetchLike = fetch): TrendSource {
    const id = `rss:${new URL(feedUrl).hostname}`
    return {
      id,
      async fetch(opts: TrendSourceFetchOpts): Promise<TrendCandidate[]> {
        const res = await fetchImpl(feedUrl, { signal: AbortSignal.timeout(opts.timeoutMs) })
        const doc = parser.parse(await res.text()) as ParsedFeed
        let candidates: TrendCandidate[]
        if (doc.rss?.channel !== undefined) {
          candidates = rssItems(doc.rss.channel.item as Record<string, unknown>[], id)
        } else {
          throw new Error(`rssSource: ${feedUrl} is not a recognized RSS 2.0 or Atom feed`)
        }
        // Feeds have no server-side limit parameter — cap client-side to honor
        // the channel's per_source_limit.
        return candidates.slice(0, opts.limit)
      },
    }
  }
  ```

  Run: `pnpm vitest run src/scout/sources/rss.test.ts` — expected: 3 tests pass (Test Files 1 passed).

  Commit:

  ```bash
  git add src/scout/sources/rss.ts src/scout/sources/rss.test.ts
  git commit -m "feat: add rss trend source with RSS 2.0 parsing" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 4: Failing test — guid/link identity resolution and skip rules**

  Append to `src/scout/sources/rss.test.ts`:

  ```ts
  const RSS_EDGE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0">
    <channel>
      <item>
        <title>Attributed guid</title>
        <link>https://feeds.example.com/1</link>
        <guid isPermaLink="false">g-1</guid>
      </item>
      <item>
        <title>Guid-less falls back to link</title>
        <link>https://feeds.example.com/2</link>
      </item>
      <item>
        <link>https://feeds.example.com/3</link>
        <guid>g-3</guid>
      </item>
      <item>
        <title>No identity at all</title>
      </item>
    </channel>
  </rss>`

  describe('rssSource identity resolution', () => {
    it('reads attributed guids, falls back to the link, and skips unusable items', async () => {
      const { impl } = fakeFetch(200, RSS_EDGE_FEED)
      const candidates = await rssSource('https://feeds.example.com/edge.xml', impl).fetch(OPTS)
      // Item 3 has no title, item 4 has neither guid nor link: both skipped.
      expect(candidates).toEqual([
        {
          title: 'Attributed guid',
          url: 'https://feeds.example.com/1',
          sourceId: 'rss:feeds.example.com',
          externalId: 'g-1',
        },
        {
          title: 'Guid-less falls back to link',
          url: 'https://feeds.example.com/2',
          sourceId: 'rss:feeds.example.com',
          externalId: 'https://feeds.example.com/2',
        },
      ])
    })
  })
  ```

  Run: `pnpm vitest run src/scout/sources/rss.test.ts`

  Expected failure: 1 test fails on the `toEqual` — the received array has only the `'Attributed guid'` candidate (the attributed `{'#text'}` guid already resolves via `text()`), because the guid-less item is dropped instead of falling back to its link: `expected [ …1 element… ] to deeply equal [ …2 elements… ]`.

- [ ] **Step 5: Implement — link fallback for externalId, run green, commit**

  In `src/scout/sources/rss.ts`, in `rssItems`, change the `externalId` line:

  ```ts
      const externalId = text(item.guid) ?? link
  ```

  Run: `pnpm vitest run src/scout/sources/rss.test.ts` — expected: 4 tests pass.

  Commit:

  ```bash
  git add src/scout/sources/rss.ts src/scout/sources/rss.test.ts
  git commit -m "feat: resolve rss item identity via guid text or link fallback" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 6: Failing test — Atom feed support**

  Append to `src/scout/sources/rss.test.ts`:

  ```ts
  const ATOM_FEED = `<?xml version="1.0" encoding="utf-8"?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <title>Example Blog</title>
    <entry>
      <title type="html">Entry one</title>
      <id>tag:example.org,2026:entry-1</id>
      <link rel="edit" href="https://example.org/e1/edit"/>
      <link rel="alternate" href="https://example.org/e1"/>
    </entry>
    <entry>
      <title>Entry two</title>
      <id>tag:example.org,2026:entry-2</id>
      <link href="https://example.org/e2"/>
    </entry>
  </feed>`

  describe('rssSource atom support', () => {
    it('parses feed.entry with attribute links, preferring rel="alternate"', async () => {
      const { impl } = fakeFetch(200, ATOM_FEED)
      const candidates = await rssSource('https://example.org/feed.atom', impl).fetch(OPTS)
      expect(candidates).toEqual([
        {
          title: 'Entry one',
          url: 'https://example.org/e1',
          sourceId: 'rss:example.org',
          externalId: 'tag:example.org,2026:entry-1',
        },
        {
          title: 'Entry two',
          url: 'https://example.org/e2',
          sourceId: 'rss:example.org',
          externalId: 'tag:example.org,2026:entry-2',
        },
      ])
    })
  })
  ```

  Run: `pnpm vitest run src/scout/sources/rss.test.ts`

  Expected failure: 1 test fails with a rejected promise — the implementation only recognizes `rss.channel`, so it throws `rssSource: https://example.org/feed.atom is not a recognized RSS 2.0 or Atom feed`.

- [ ] **Step 7: Implement — Atom entries and attribute links, run green, commit**

  In `src/scout/sources/rss.ts`, add three functions above `rssSource` (after `rssItems`):

  ```ts
  // fast-xml-parser yields an object (not a one-element array) for elements
  // that appear exactly once.
  function asArray<T>(value: T | T[] | undefined): T[] {
    if (value === undefined) return []
    return Array.isArray(value) ? value : [value]
  }

  // Atom <link> is href-in-attribute and may repeat per rel; the alternate (or
  // rel-less) link is the canonical page URL (RFC 4287 §4.2.7.2).
  function atomLinkHref(value: unknown): string | undefined {
    const links = asArray(value as Record<string, unknown> | Record<string, unknown>[] | undefined)
    const preferred =
      links.find((l) => l['@_rel'] === undefined || l['@_rel'] === 'alternate') ?? links[0]
    if (preferred === undefined) return undefined
    return text(preferred['@_href'])
  }

  function atomEntries(entries: Record<string, unknown>[], sourceId: string): TrendCandidate[] {
    const out: TrendCandidate[] = []
    for (const entry of entries) {
      const title = text(entry.title)
      const link = atomLinkHref(entry.link)
      const externalId = text(entry.id) ?? link
      if (title === undefined || externalId === undefined) continue
      out.push({ title, url: link ?? '', sourceId, externalId })
    }
    return out
  }
  ```

  Then, in `rssSource`'s `fetch`, insert an `else if` branch between the `rss` branch and the `else` throw:

  ```ts
        } else if (doc.feed !== undefined) {
          candidates = atomEntries(doc.feed.entry as Record<string, unknown>[], id)
        } else {
  ```

  Run: `pnpm vitest run src/scout/sources/rss.test.ts` — expected: 5 tests pass.

  Commit:

  ```bash
  git add src/scout/sources/rss.ts src/scout/sources/rss.test.ts
  git commit -m "feat: parse Atom feeds in the rss trend source" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 8: Failing test — single-item and empty feeds normalize**

  Append to `src/scout/sources/rss.test.ts`:

  ```ts
  const RSS_SINGLE = `<rss version="2.0"><channel>
    <item><title>Lone item</title><link>https://feeds.example.com/solo</link><guid>solo-1</guid></item>
  </channel></rss>`

  const ATOM_SINGLE = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>Lone entry</title><id>tag:example.org,2026:solo</id><link href="https://example.org/solo"/></entry>
  </feed>`

  const RSS_EMPTY = `<rss version="2.0"><channel><title>Nothing yet</title></channel></rss>`

  describe('rssSource single-item normalization', () => {
    it('yields one candidate when the parser returns an object, and none from an empty channel', async () => {
      const rss = await rssSource(
        'https://feeds.example.com/solo.xml',
        fakeFetch(200, RSS_SINGLE).impl,
      ).fetch(OPTS)
      expect(rss.map((c) => c.externalId)).toEqual(['solo-1'])

      const atom = await rssSource(
        'https://example.org/solo.atom',
        fakeFetch(200, ATOM_SINGLE).impl,
      ).fetch(OPTS)
      expect(atom.map((c) => c.externalId)).toEqual(['tag:example.org,2026:solo'])

      const empty = await rssSource(
        'https://feeds.example.com/empty.xml',
        fakeFetch(200, RSS_EMPTY).impl,
      ).fetch(OPTS)
      expect(empty).toEqual([])
    })
  })
  ```

  Run: `pnpm vitest run src/scout/sources/rss.test.ts`

  Expected failure: 1 test fails with a rejected promise `TypeError: items is not iterable` — a single `<item>` parses to a plain object, and `for (const item of items)` cannot iterate it. (The Atom and empty-channel asserts would fail the same way but the run stops at the first rejection.)

- [ ] **Step 9: Implement — normalize items/entries through asArray, run green, commit**

  In `src/scout/sources/rss.ts`, in `rssSource`'s `fetch`, replace the two casts with `asArray` calls:

  ```ts
        if (doc.rss?.channel !== undefined) {
          candidates = rssItems(asArray(doc.rss.channel.item), id)
        } else if (doc.feed !== undefined) {
          candidates = atomEntries(asArray(doc.feed.entry), id)
        } else {
  ```

  (`asArray(undefined)` is `[]`, which also makes an item-less channel yield zero candidates instead of crashing.)

  Run: `pnpm vitest run src/scout/sources/rss.test.ts` — expected: 6 tests pass.

  Commit:

  ```bash
  git add src/scout/sources/rss.ts src/scout/sources/rss.test.ts
  git commit -m "feat: normalize single-item and empty feeds in rss source" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 10: Failing test — non-2xx and unrecognizable documents throw**

  Append to `src/scout/sources/rss.test.ts`:

  ```ts
  describe('rssSource error paths', () => {
    it('throws with the HTTP status on a non-2xx response', async () => {
      const { impl } = fakeFetch(404, 'Not Found')
      await expect(
        rssSource('https://feeds.example.com/gone.xml', impl).fetch(OPTS),
      ).rejects.toThrow(/responded 404/)
    })

    it('throws on a document that is neither RSS nor Atom', async () => {
      const { impl } = fakeFetch(200, '<html><body>maintenance page</body></html>')
      await expect(
        rssSource('https://feeds.example.com/space.xml', impl).fetch(OPTS),
      ).rejects.toThrow(/not a recognized RSS 2.0 or Atom feed/)
    })
  })
  ```

  Run: `pnpm vitest run src/scout/sources/rss.test.ts`

  Expected failure: the non-2xx test fails — without a status check the 404 body is parsed as XML and the rejection message is `rssSource: https://feeds.example.com/gone.xml is not a recognized RSS 2.0 or Atom feed`, which does not match `/responded 404/`. (The second test already passes — it pins the unrecognized-document behavior in place before the status check lands in front of it.)

- [ ] **Step 11: Implement — non-2xx check before parsing, run green**

  In `src/scout/sources/rss.ts`, in `rssSource`'s `fetch`, insert directly after the `fetchImpl` call and before `parser.parse`:

  ```ts
        if (!res.ok) {
          throw new Error(`rssSource: ${feedUrl} responded ${res.status}`)
        }
  ```

  Run: `pnpm vitest run src/scout/sources/rss.test.ts` — expected: 8 tests pass (Test Files 1 passed).

- [ ] **Step 11a: Pin the timeout propagation path**

  Spec §9 names timeout paths explicitly, and a source must never swallow its
  own failure — isolation lives in the orchestrator. Append inside
  `describe('rssSource', ...)`:

  ```ts
    it('rejects when the fetch times out, so the orchestrator can isolate it', async () => {
      const impl: FetchLike = () =>
        Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
      const source = rssSource('https://feeds.example.com/space.xml', impl)
      await expect(source.fetch({ limit: 25, timeoutMs: 10 })).rejects.toThrow(/timeout/i)
    })
  ```

  (Extend the test file's type-only import with `FetchLike` if not already
  imported.)

  Run: `pnpm vitest run src/scout/sources/rss.test.ts` — expected: 9 tests
  pass. This test is green on arrival — it pins that a timeout rejection
  propagates out of `fetch` unchanged, so a later refactor that adds a
  swallow-and-return-empty catch fails loudly here.

- [ ] **Step 12: Whole-suite and type gates**

  Run: `pnpm vitest run` — expected: all test files pass, no regressions (nothing else imports `rss.ts` yet).

  Run: `pnpm tsc --noEmit` — expected: no output, exit 0.

- [ ] **Step 13: Final commit**

  ```bash
  git add src/scout/sources/rss.ts src/scout/sources/rss.test.ts
  git commit -m "feat: reject non-2xx and unrecognized feed responses in rss source" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```


### Task 5: costs.ts day-spend helpers extraction

**Files:**
- Create: (none)
- Modify: `src/jobs/costs.ts`, `src/jobs/costs.test.ts`
- Test: `src/jobs/costs.test.ts`

All paths are relative to the repo root `/Users/alex/code/project-brainrot`. Run every command from the repo root. This is a behavior-preserving refactor plus new exports: the two day-spend SQL queries currently inlined in `assertBudget` are extracted verbatim into exported helpers, the private `globalDailyCapMicros` is exported unchanged, and the global-day check is extracted into `assertGlobalDayBudget` so the scout (Task 7) can gate spend without a job, and the planner/digest (Tasks 10/13) can read day spend directly. `assertBudget` ends up delegating to the extracted pieces; every existing test in `src/jobs/costs.test.ts` must keep passing untouched.

**Interfaces:**

Consumes (existing code, verbatim — all already present in `src/jobs/costs.ts` and its test file):

```ts
// src/jobs/costs.ts (existing)
export class BudgetExceededError extends Error { constructor(public reason: string) }
export function recordCost(db: Database, jobId: string, provider: string, operation: string, usdMicros: number): void
export function assertBudget(db: Database, channel: ChannelConfig, jobId: string, upcomingUsdMicros: number, tier: Tier): void

// src/jobs/runner.ts — used by the test file's existing seedJob helper
export function createJob(db, channel: ChannelConfig, opts: { topic: string; tier: Tier }, _options?): string

// src/stages/_testkit.ts — used by the test file's existing channel helper
export function testChannel(overrides: Partial<ChannelConfig>): ChannelConfig

// src/db/index.ts
export function openDb(dbPath: string): Database
```

Produces (binding — Task 7 imports `assertGlobalDayBudget`; Tasks 10 and 13 import `channelDaySpentMicros`, `globalDaySpentMicros`, `globalDailyCapMicros`, all from `src/jobs/costs.js`):

```ts
export function channelDaySpentMicros(db: Database, channel: string): number  // today UTC, JOIN through jobs (existing query verbatim)
export function globalDaySpentMicros(db: Database): number                    // today UTC, all costs rows, no JOIN (existing query verbatim)
export function globalDailyCapMicros(): number                                // existing private fn exported unchanged
export function assertGlobalDayBudget(db: Database, upcomingUsdMicros: number): void  // throws BudgetExceededError('global-day ...')
```

All pre-existing exports (`BudgetExceededError`, `recordCost`, `assertBudget`) keep their exact signatures and behavior, including the error-message shapes existing tests match with `/^per-video/`, `/^premium per-video/`, `/^channel-day/`, `/^global-day/`.

House notes: UTC "today" is `substr(created_at, 1, 10) = strftime('%Y-%m-%d','now')` — do not rewrite these queries, extract them character-for-character. Money is integer micro-USD. With vitest/esbuild a missing named export resolves to `undefined` and fails at runtime with `TypeError: x is not a function` — `globalDailyCapMicros` EXISTS as a private function, but until the `export` keyword lands the test's named import is still `undefined`, so the same TypeError applies.

- [ ] **Step 1: Failing tests — channelDaySpentMicros + globalDaySpentMicros**

  In `src/jobs/costs.test.ts`, replace the import line

  ```ts
  import { assertBudget, BudgetExceededError, recordCost } from './costs.js'
  ```

  with

  ```ts
  import {
    assertBudget,
    BudgetExceededError,
    channelDaySpentMicros,
    globalDaySpentMicros,
    recordCost,
  } from './costs.js'
  ```

  Append at the end of the file (after the closing `})` of the existing `describe('recordCost + assertBudget'`):

  ```ts
  // Same seeded-now caveat as above: a sub-second UTC-midnight rollover between
  // recordCost and the assertion is the only race — accepted.
  describe('day-spend helpers', () => {
    it('channelDaySpentMicros sums today through the jobs JOIN, per channel', () => {
      const db = tempDb()
      const chA = channel('chan-a', {
        perVideoUsdMicros: GENEROUS,
        premiumPerVideoUsdMicros: GENEROUS,
        perDayUsdMicros: GENEROUS,
      })
      const chB = channel('chan-b', {
        perVideoUsdMicros: GENEROUS,
        premiumPerVideoUsdMicros: GENEROUS,
        perDayUsdMicros: GENEROUS,
      })
      const jobA = seedJob(db, chA)
      const jobB = seedJob(db, chB)
      recordCost(db, jobA, 'anthropic', 'script', 2_000_000)
      recordCost(db, jobA, 'fal', 'image', 500_000)
      recordCost(db, jobB, 'anthropic', 'script', 1_000_000)
      expect(channelDaySpentMicros(db, 'chan-a')).toBe(2_500_000)
      expect(channelDaySpentMicros(db, 'chan-b')).toBe(1_000_000)
      expect(channelDaySpentMicros(db, 'chan-c')).toBe(0)
      db.close()
    })

    it('channelDaySpentMicros ignores previous UTC days and non-job sentinel rows', () => {
      const db = tempDb()
      const ch = channel('chan-a', {
        perVideoUsdMicros: GENEROUS,
        premiumPerVideoUsdMicros: GENEROUS,
        perDayUsdMicros: GENEROUS,
      })
      const jobId = seedJob(db, ch)
      db.prepare(
        "INSERT INTO costs (job_id, provider, operation, usd_micros, created_at) VALUES (?, 'fal', 'video', ?, '2020-01-01T00:00:00.000Z')",
      ).run(jobId, 4_000_000)
      // FKs are off by design: sentinel rows attach to no jobs row, so the
      // channel attribution JOIN drops them.
      recordCost(db, 'scout:chan-a', 'anthropic', 'scout-score', 15_000)
      expect(channelDaySpentMicros(db, 'chan-a')).toBe(0)
      db.close()
    })

    it('globalDaySpentMicros sums ALL of today, sentinel rows included', () => {
      const db = tempDb()
      const ch = channel('chan-a', {
        perVideoUsdMicros: GENEROUS,
        premiumPerVideoUsdMicros: GENEROUS,
        perDayUsdMicros: GENEROUS,
      })
      const jobId = seedJob(db, ch)
      recordCost(db, jobId, 'anthropic', 'script', 2_000_000)
      recordCost(db, 'scout:chan-a', 'anthropic', 'scout-score', 15_000)
      db.prepare(
        "INSERT INTO costs (job_id, provider, operation, usd_micros, created_at) VALUES (?, 'fal', 'video', ?, '2020-01-01T00:00:00.000Z')",
      ).run(jobId, 4_000_000)
      expect(globalDaySpentMicros(db)).toBe(2_015_000)
      db.close()
    })
  })
  ```

- [ ] **Step 2: Run and observe the failure**

  ```bash
  pnpm vitest run src/jobs/costs.test.ts
  ```

  Expected: the 11 pre-existing tests pass; the 3 new tests fail with `TypeError: channelDaySpentMicros is not a function` (first two) and `TypeError: globalDaySpentMicros is not a function` (third) — missing named exports resolve to undefined at runtime.

- [ ] **Step 3: Implement the two day-spend helpers**

  In `src/jobs/costs.ts`, insert the following directly ABOVE the `assertBudget` doc comment (`/**` block starting "Pre-call budget checkpoint"). The two SQL strings are the exact queries currently inlined in `assertBudget` — extract, do not rewrite:

  ```ts
  // Today's UTC spend attributed to one channel. costs has no channel column:
  // attribution JOINs through the jobs table, so non-job sentinel rows
  // ('scout:<channel>') are invisible here — accepted at ~$0.01/day scale.
  export function channelDaySpentMicros(db: Database, channel: string): number {
    const row = db
      .prepare(
        'SELECT COALESCE(SUM(c.usd_micros), 0) AS total FROM costs c JOIN jobs j ON c.job_id = j.id ' +
          "WHERE j.channel = ? AND substr(c.created_at, 1, 10) = strftime('%Y-%m-%d','now')",
      )
      .get(channel) as { total: number }
    return row.total
  }

  // Today's UTC spend across ALL costs rows — deliberately no jobs JOIN, so
  // sentinel scout rows count toward the global cap.
  export function globalDaySpentMicros(db: Database): number {
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(usd_micros), 0) AS total FROM costs WHERE substr(created_at, 1, 10) = strftime('%Y-%m-%d','now')",
      )
      .get() as { total: number }
    return row.total
  }
  ```

  Do NOT touch `assertBudget` yet — delegation is Step 9, guarded by the whole green file.

- [ ] **Step 4: Run to green and commit**

  ```bash
  pnpm vitest run src/jobs/costs.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  14 passed (14)`.

  ```bash
  git add src/jobs/costs.ts src/jobs/costs.test.ts
  git commit -m "$(cat <<'EOF'
  feat(costs): extract channel/global day-spend helpers

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 5: Failing tests — globalDailyCapMicros export + assertGlobalDayBudget**

  In `src/jobs/costs.test.ts`, extend the import block to:

  ```ts
  import {
    assertBudget,
    assertGlobalDayBudget,
    BudgetExceededError,
    channelDaySpentMicros,
    globalDailyCapMicros,
    globalDaySpentMicros,
    recordCost,
  } from './costs.js'
  ```

  Append at the end of the file:

  ```ts
  describe('globalDailyCapMicros + assertGlobalDayBudget', () => {
    it('globalDailyCapMicros reads BRAINROT_GLOBAL_DAILY_USD, defaulting to $25', () => {
      vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', undefined) // deterministic even if the shell exports it
      expect(globalDailyCapMicros()).toBe(25_000_000)
      vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', '5')
      expect(globalDailyCapMicros()).toBe(5_000_000)
    })

    it('assertGlobalDayBudget throws only when projected spend exceeds the cap', () => {
      vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', '5')
      const db = tempDb()
      // Jobless sentinel spend is exactly what the scout gate must see.
      recordCost(db, 'scout:chan-a', 'anthropic', 'scout-score', 4_500_000)
      // 4.5M + 0.5M == 5M cap exactly: boundary passes (strict >)
      expect(() => assertGlobalDayBudget(db, 500_000)).not.toThrow()
      // 4.5M + 0.500001M > 5M cap
      expect(() => assertGlobalDayBudget(db, 500_001)).toThrow(BudgetExceededError)
      expect(() => assertGlobalDayBudget(db, 500_001)).toThrow(/^global-day budget exceeded/)
      db.close()
    })

    it('assertGlobalDayBudget propagates the malformed-env crash unchanged', () => {
      vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', 'twenty')
      const db = tempDb()
      let caught: unknown
      try {
        assertGlobalDayBudget(db, 1_000)
      } catch (err) {
        caught = err
      }
      // Misconfiguration stays a crash, not a budget outcome — same contract
      // as assertBudget: plain Error, NOT BudgetExceededError.
      expect(caught).toBeInstanceOf(Error)
      expect(caught).not.toBeInstanceOf(BudgetExceededError)
      expect((caught as Error).message).toMatch(/BRAINROT_GLOBAL_DAILY_USD/)
      db.close()
    })
  })
  ```

- [ ] **Step 6: Run and observe the failure**

  ```bash
  pnpm vitest run src/jobs/costs.test.ts
  ```

  Expected: 14 pass, 3 fail. The first with `TypeError: globalDailyCapMicros is not a function` (the function exists module-privately, but the named import is undefined until it is exported — the house esbuild gotcha); the second with `TypeError: assertGlobalDayBudget is not a function`; the third (the try/catch-shaped invalid-env test) catches that same TypeError, passes its `instanceof Error` check, and fails at the message assertion with a mismatch naming the TypeError text instead of `BRAINROT_GLOBAL_DAILY_USD`. All three are the same red.

- [ ] **Step 7: Export globalDailyCapMicros and implement assertGlobalDayBudget**

  In `src/jobs/costs.ts`, change the private function's declaration line (body and comment above it stay byte-identical):

  ```ts
  function globalDailyCapMicros(): number {
  ```

  becomes

  ```ts
  export function globalDailyCapMicros(): number {
  ```

  Then insert directly below `globalDaySpentMicros` (still above the `assertBudget` doc comment):

  ```ts
  // The global-day check extracted from assertBudget so the scout — which has
  // no job and therefore cannot use assertBudget — gates its Haiku spend
  // against the same ceiling. Cap is resolved BEFORE the db read so a
  // malformed env crashes without touching the ledger, exactly as before.
  export function assertGlobalDayBudget(db: Database, upcomingUsdMicros: number): void {
    const globalCapMicros = globalDailyCapMicros()
    const globalDayProjected = globalDaySpentMicros(db) + upcomingUsdMicros
    if (globalDayProjected > globalCapMicros) {
      throw new BudgetExceededError(
        `global-day budget exceeded: ${globalDayProjected} > ${globalCapMicros} usdMicros (BRAINROT_GLOBAL_DAILY_USD, default ${DEFAULT_GLOBAL_DAILY_USD})`,
      )
    }
  }
  ```

  The message template is character-for-character the one `assertBudget` throws today — the existing `/^global-day budget exceeded/` test and the runner's blocked-reason surface both depend on it.

- [ ] **Step 8: Run to green and commit**

  ```bash
  pnpm vitest run src/jobs/costs.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  17 passed (17)`.

  ```bash
  git add src/jobs/costs.ts src/jobs/costs.test.ts
  git commit -m "$(cat <<'EOF'
  feat(costs): export globalDailyCapMicros and add assertGlobalDayBudget gate

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 9: Refactor — assertBudget delegates to the extracted pieces**

  Pure refactor: no new test — the 17 green tests (11 of them predating this task) are the safety net; they pin every error message and boundary. In `src/jobs/costs.ts`, inside `assertBudget`, replace the channel-day block

  ```ts
    // costs has no channel column: attribute today's spend through the jobs table.
    const channelDayRow = db
      .prepare(
        'SELECT COALESCE(SUM(c.usd_micros), 0) AS total FROM costs c JOIN jobs j ON c.job_id = j.id ' +
          "WHERE j.channel = ? AND substr(c.created_at, 1, 10) = strftime('%Y-%m-%d','now')",
      )
      .get(channel.name) as { total: number }
    const channelDayProjected = channelDayRow.total + upcomingUsdMicros
  ```

  with

  ```ts
    const channelDayProjected = channelDaySpentMicros(db, channel.name) + upcomingUsdMicros
  ```

  and replace the entire global-day block at the end of the function

  ```ts
    const globalCapMicros = globalDailyCapMicros()
    const globalDayRow = db
      .prepare(
        "SELECT COALESCE(SUM(usd_micros), 0) AS total FROM costs WHERE substr(created_at, 1, 10) = strftime('%Y-%m-%d','now')",
      )
      .get() as { total: number }
    const globalDayProjected = globalDayRow.total + upcomingUsdMicros
    if (globalDayProjected > globalCapMicros) {
      throw new BudgetExceededError(
        `global-day budget exceeded: ${globalDayProjected} > ${globalCapMicros} usdMicros (BRAINROT_GLOBAL_DAILY_USD, default ${DEFAULT_GLOBAL_DAILY_USD})`,
      )
    }
  ```

  with

  ```ts
    assertGlobalDayBudget(db, upcomingUsdMicros)
  ```

  The check order (per-video → channel-day → global-day), strict-`>` comparisons, and all four message shapes are unchanged.

- [ ] **Step 10: Whole-suite and typecheck gates, then final commit**

  ```bash
  pnpm vitest run src/jobs/costs.test.ts
  ```

  Expected: `Tests  17 passed (17)`.

  ```bash
  pnpm vitest run
  ```

  Expected: all test files pass — `assertBudget` consumers (runner, stages, golden paths) observe identical behavior.

  ```bash
  pnpm tsc --noEmit
  ```

  Expected: no output, exit 0.

  ```bash
  git add src/jobs/costs.ts
  git commit -m "$(cat <<'EOF'
  refactor(costs): assertBudget delegates day checks to extracted helpers

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

### Task 6: Scorer

**Files:**
- Create: `src/scout/score.ts`, `src/scout/score.test.ts`
- Test: `src/scout/score.test.ts`
- No new dependencies. No db access in this module (gating and ledgering live in Task 7's `scoutChannel`).

**Interfaces:**

Consumes (existing code and Task 3, exact signatures):

```ts
// src/providers/anthropic.ts (existing)
export interface LlmUsageCost { usdMicros: number }
export async function structuredCompletion<T>(opts: {
  model: string; system: string; prompt: string; schema: z.ZodType<T>;
  maxTokens?: number; client?: Anthropic;   // client is the test injection seam
}): Promise<{ data: T; cost: LlmUsageCost }>
export const PRICE_TABLE: Record<string, { inputUsdMicrosPerMTok: number; outputUsdMicrosPerMTok: number }>
// keys include 'claude-haiku-4-5' → { inputUsdMicrosPerMTok: 1_000_000, outputUsdMicrosPerMTok: 5_000_000 }
// i.e. haiku bills 1 usd-micro per input token and 5 per output token

// src/scout/sources/types.ts (Task 3)
export interface TrendCandidate { title: string; url: string; sourceId: string; externalId: string }
```

Produces (binding; Task 7's `scoutChannel` imports these from `src/scout/score.js`):

```ts
export const SCOUT_MODEL = 'claude-haiku-4-5'      // the alias — it is the PRICE_TABLE key; NOT the dated id
export const SCOUT_MAX_TOKENS = 4096
export const ESTIMATED_SCOUT_COST_MICROS = 20_000  // pre-call reservation Task 7 gates against the global day cap
export interface ScoredCandidate { candidateIndex: number; score: number; topic: string; reason: string }
export async function scoreCandidates(opts: {
  candidates: TrendCandidate[]; niche: string[]; recentTitles: string[]; client?: Anthropic;
}): Promise<{ scored: ScoredCandidate[]; costUsdMicros: number }>
```

Semantics (binding, from the contract): ONE `structuredCompletion` call with `SCOUT_MODEL` and the zod schema `z.object({ scores: z.array(z.object({ candidateIndex: int min 0, score: int 0..100, topic: string min 1, reason: string min 1 })) })`. The prompt carries the numbered candidate list (index, raw title, sourceId), the niche keywords, and `recentTitles` labeled "recently covered — score near-duplicates 0". Result normalization: entries matched to candidates by `candidateIndex`; out-of-range indexes dropped; duplicate indexes → first wins; candidates absent from the model output come back as `{ score: 0, topic: rawTitle, reason: 'not scored' }`. Task 7 never calls this with an empty candidate list (empty remainder → no Haiku call), so no empty-input special case.

House style for `src/scout/`: no semicolons, single quotes, 2-space indent (match `src/jobs/costs.ts` and Task 1's `src/scout/topics.ts` — NOT the semicolon style of `src/providers/`). The Anthropic client is mocked via the `client` injection seam with a plain object + `vi.fn()` (the `fakeClient` pattern from `src/stages/script.test.ts`) — no constructor mocks needed.

- [ ] **Step 1: write the failing constants test**

  Create `src/scout/score.test.ts` with exactly:

  ```ts
  import { describe, expect, it } from 'vitest'
  import { PRICE_TABLE } from '../providers/anthropic.js'
  import { ESTIMATED_SCOUT_COST_MICROS, SCOUT_MAX_TOKENS, SCOUT_MODEL } from './score.js'

  describe('scout scoring constants', () => {
    it('pins the haiku alias (a PRICE_TABLE key), token ceiling, and cost estimate', () => {
      expect(SCOUT_MODEL).toBe('claude-haiku-4-5')
      // The alias must be a PRICE_TABLE key or structuredCompletion refuses the
      // call at zero spend — this is why the dated model id would be wrong here.
      expect(PRICE_TABLE[SCOUT_MODEL]).toBeDefined()
      expect(SCOUT_MAX_TOKENS).toBe(4096)
      expect(ESTIMATED_SCOUT_COST_MICROS).toBe(20_000)
    })
  })
  ```

  Run: `pnpm vitest run src/scout/score.test.ts`

  Expected failure: the test FILE fails to load — `Failed to resolve import "./score.js" from "src/scout/score.test.ts"` (the module file does not exist yet; this is an import-resolution error, no tests execute).

- [ ] **Step 2: create score.ts with the constants**

  Create `src/scout/score.ts` with exactly:

  ```ts
  // The alias, NOT the dated model id: it is the PRICE_TABLE key in
  // src/providers/anthropic.ts, so cost computation resolves before the call.
  export const SCOUT_MODEL = 'claude-haiku-4-5'
  export const SCOUT_MAX_TOKENS = 4096
  // Typical-cost reservation for the batched call (mirrors
  // ESTIMATED_SCRIPT_COST_MICROS): the scout orchestrator gates it against the
  // global day cap before calling, then trues up from response.usage after.
  export const ESTIMATED_SCOUT_COST_MICROS = 20_000
  ```

  Run: `pnpm vitest run src/scout/score.test.ts`

  Expected: `Test Files  1 passed (1)`, `Tests  1 passed (1)`.

- [ ] **Step 3: write the failing call-shape and result tests**

  In `src/scout/score.test.ts`, replace the import block with:

  ```ts
  import { describe, expect, it, vi } from 'vitest'
  import type Anthropic from '@anthropic-ai/sdk'
  import { PRICE_TABLE } from '../providers/anthropic.js'
  import type { TrendCandidate } from './sources/types.js'
  import {
    ESTIMATED_SCOUT_COST_MICROS,
    SCOUT_MAX_TOKENS,
    SCOUT_MODEL,
    scoreCandidates,
  } from './score.js'
  ```

  Add below the imports (module scope):

  ```ts
  // Client injection seam (script.test.ts pattern): a plain object with a
  // vi.fn() create — vitest constructor mocks are never needed here.
  function fakeClient(response: unknown): { client: Anthropic; create: ReturnType<typeof vi.fn> } {
    const create = vi.fn().mockResolvedValue(response)
    return { client: { messages: { create } } as unknown as Anthropic, create }
  }

  function candidate(i: number, overrides: Partial<TrendCandidate> = {}): TrendCandidate {
    return {
      title: `Headline ${i}`,
      url: `https://example.com/${i}`,
      sourceId: 'reddit:r/space',
      externalId: `t3_${i}`,
      ...overrides,
    }
  }

  function emit(scores: unknown, usage = { input_tokens: 1000, output_tokens: 500 }) {
    return {
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { scores } }],
      usage,
    }
  }
  ```

  Append at the end of the file:

  ```ts
  describe('scoreCandidates', () => {
    it('makes one forced-tool haiku call carrying candidates, niche, and recent titles', async () => {
      const { client, create } = fakeClient(
        emit([
          { candidateIndex: 0, score: 91, topic: 'Watch the moon leave', reason: 'strong hook' },
          { candidateIndex: 1, score: 55, topic: 'Chase the solar wind', reason: 'niche fit' },
        ]),
      )
      await scoreCandidates({
        candidates: [candidate(0), candidate(1, { sourceId: 'rss:example.com', title: 'Solar wind news' })],
        niche: ['space facts', 'astronomy'],
        recentTitles: ['Old moon topic'],
        client,
      })
      expect(create).toHaveBeenCalledTimes(1)
      const sent = create.mock.calls[0][0]
      expect(sent.model).toBe(SCOUT_MODEL)
      expect(sent.max_tokens).toBe(SCOUT_MAX_TOKENS)
      expect(sent.tool_choice).toEqual({ type: 'tool', name: 'emit' })
      expect(sent.tools[0].input_schema.required).toContain('scores')
      expect(sent.system).toContain('space facts, astronomy')
      const prompt = sent.messages[0].content as string
      // numbered list: index, sourceId, raw title — one line per candidate
      expect(prompt).toContain('0. [reddit:r/space] Headline 0')
      expect(prompt).toContain('1. [rss:example.com] Solar wind news')
      // the semantic-dedupe instruction and the recent titles it governs
      expect(prompt).toContain('covered — score near-duplicates 0')
      expect(prompt).toContain('- Old moon topic')
    })

    it('returns entries matched to candidates plus the billed haiku cost', async () => {
      const scores = [
        { candidateIndex: 0, score: 91, topic: 'Watch the moon leave', reason: 'strong hook' },
        { candidateIndex: 1, score: 55, topic: 'Chase the solar wind', reason: 'niche fit' },
      ]
      const { client } = fakeClient(emit(scores, { input_tokens: 1000, output_tokens: 500 }))
      const result = await scoreCandidates({
        candidates: [candidate(0), candidate(1)],
        niche: ['space facts'],
        recentTitles: [],
        client,
      })
      expect(result.scored).toEqual(scores)
      // haiku list price: 1 usd-micro per input token, 5 per output token
      expect(result.costUsdMicros).toBe(1000 * 1 + 500 * 5)
    })
  })
  ```

  Run: `pnpm vitest run src/scout/score.test.ts`

  Expected failure: 2 failed, 1 passed — both new tests hit `TypeError: scoreCandidates is not a function` at runtime (esbuild resolves the missing named export to `undefined`, not an import-time error).

- [ ] **Step 4: implement the batched scoring call**

  In `src/scout/score.ts`, add above the constants:

  ```ts
  import type Anthropic from '@anthropic-ai/sdk'
  import { z } from 'zod'
  import { structuredCompletion } from '../providers/anthropic.js'
  import type { TrendCandidate } from './sources/types.js'
  ```

  Append at the end of the file:

  ```ts
  export interface ScoredCandidate {
    candidateIndex: number
    score: number
    topic: string
    reason: string
  }

  // Constraint-light on purpose (int + range only): quality rules live in the
  // prompt, keeping the forced-tool input_schema simple.
  const ScoresSchema = z.object({
    scores: z.array(
      z.object({
        candidateIndex: z.number().int().min(0),
        score: z.number().int().min(0).max(100),
        topic: z.string().min(1),
        reason: z.string().min(1),
      }),
    ),
  })

  function buildSystem(niche: string[]): string {
    return [
      `You are a trend scout for a short-form video channel in the "${niche.join(', ')}" niche.`,
      'You rate scraped headlines 0-100 on their potential as retention-optimized vertical video topics for that niche.',
      'For each candidate you also reframe the headline into a hooky, imperative video topic and give a one-line reason for the score.',
      'Return your answer ONLY by calling the `emit` tool. Never write prose or markdown.',
    ].join(' ')
  }

  function buildPrompt(
    candidates: TrendCandidate[],
    niche: string[],
    recentTitles: string[],
  ): string {
    const list = candidates.map((c, i) => `${i}. [${c.sourceId}] ${c.title}`).join('\n')
    const recent =
      recentTitles.length > 0 ? recentTitles.map((t) => `- ${t}`).join('\n') : '(none)'
    return `Score each candidate headline as a video topic for the "${niche.join(', ')}" niche.

Candidates (score every one by its index):
${list}

Recently covered — score near-duplicates 0:
${recent}

For each candidate return:
- candidateIndex: the number from the list above
- score: 0 to 100 — how strong a short-form vertical video this makes for the niche (0 = off-niche, stale, or already covered)
- topic: the headline reframed as a hooky video topic, imperative and concrete
- reason: one line explaining the score`
  }

  // Pure scoring: no db access here — budget gating and cost ledgering live in
  // scoutChannel, which owns the 'scout:<channel>' sentinel rows.
  export async function scoreCandidates(opts: {
    candidates: TrendCandidate[]
    niche: string[]
    recentTitles: string[]
    client?: Anthropic
  }): Promise<{ scored: ScoredCandidate[]; costUsdMicros: number }> {
    const { data, cost } = await structuredCompletion({
      model: SCOUT_MODEL,
      system: buildSystem(opts.niche),
      prompt: buildPrompt(opts.candidates, opts.niche, opts.recentTitles),
      schema: ScoresSchema,
      maxTokens: SCOUT_MAX_TOKENS,
      client: opts.client,
    })
    return { scored: data.scores, costUsdMicros: cost.usdMicros }
  }
  ```

  (The flush-left lines inside `buildPrompt`'s template literal are deliberate — template literals preserve leading whitespace, so the prompt lines sit at column 0 exactly as `buildPrompt` in `src/stages/script.ts` does.)

  Run: `pnpm vitest run src/scout/score.test.ts`

  Expected: `Tests  3 passed (3)`.

- [ ] **Step 5: commit the scoring call**

  ```bash
  git add src/scout/score.ts src/scout/score.test.ts
  git commit -m "feat: batched haiku scout scorer" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 6: write the failing normalization tests**

  Append at the end of `src/scout/score.test.ts`:

  ```ts
  describe('scoreCandidates normalization', () => {
    it('drops out-of-range indexes, keeps the first duplicate, fills absentees with score 0', async () => {
      const { client } = fakeClient(
        emit([
          { candidateIndex: 7, score: 99, topic: 'Ghost entry', reason: 'out of range' },
          { candidateIndex: 1, score: 80, topic: 'Kept entry', reason: 'first wins' },
          { candidateIndex: 1, score: 10, topic: 'Dropped dupe', reason: 'second loses' },
        ]),
      )
      const result = await scoreCandidates({
        candidates: [candidate(0), candidate(1), candidate(2)],
        niche: ['space facts'],
        recentTitles: [],
        client,
      })
      expect(result.scored).toEqual([
        { candidateIndex: 0, score: 0, topic: 'Headline 0', reason: 'not scored' },
        { candidateIndex: 1, score: 80, topic: 'Kept entry', reason: 'first wins' },
        { candidateIndex: 2, score: 0, topic: 'Headline 2', reason: 'not scored' },
      ])
    })

    it('an empty scores list falls back to all zero-score entries', async () => {
      const { client } = fakeClient(emit([]))
      const result = await scoreCandidates({
        candidates: [candidate(0), candidate(1)],
        niche: ['space facts'],
        recentTitles: [],
        client,
      })
      expect(result.scored).toEqual([
        { candidateIndex: 0, score: 0, topic: 'Headline 0', reason: 'not scored' },
        { candidateIndex: 1, score: 0, topic: 'Headline 1', reason: 'not scored' },
      ])
    })
  })
  ```

  Run: `pnpm vitest run src/scout/score.test.ts`

  Expected failure: 2 failed, 3 passed — AssertionErrors: the first receives the raw model list (ghost + duplicate entries, wrong order/length), the second receives `[]` instead of the two zero-score fillers.

- [ ] **Step 7: implement the normalization**

  In `src/scout/score.ts`, replace the line

  ```ts
    return { scored: data.scores, costUsdMicros: cost.usdMicros }
  ```

  with:

  ```ts
    // The model's list is untrusted: out-of-range indexes are dropped, a
    // duplicated index keeps its first entry, and any candidate the model
    // skipped scores 0 — it lands 'rejected' in the queue instead of vanishing.
    const byIndex = new Map<number, ScoredCandidate>()
    for (const entry of data.scores) {
      if (entry.candidateIndex >= opts.candidates.length) continue
      if (byIndex.has(entry.candidateIndex)) continue
      byIndex.set(entry.candidateIndex, entry)
    }
    const scored = opts.candidates.map(
      (c, i) => byIndex.get(i) ?? { candidateIndex: i, score: 0, topic: c.title, reason: 'not scored' },
    )
    return { scored, costUsdMicros: cost.usdMicros }
  ```

  Run: `pnpm vitest run src/scout/score.test.ts`

  Expected: `Test Files  1 passed (1)`, `Tests  5 passed (5)`.

- [ ] **Step 8: run the whole suite**

  ```bash
  pnpm vitest run
  ```

  Expected: every test file passes (0 failed — contract tests are excluded unless `CONTRACT=1`).

- [ ] **Step 9: run the typecheck**

  ```bash
  pnpm tsc --noEmit
  ```

  Expected: exit 0, no output.

- [ ] **Step 10: commit the normalization**

  ```bash
  git add src/scout/score.ts src/scout/score.test.ts
  git commit -m "feat: normalize scout scores by candidate index" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```


### Task 7: Scout orchestrator + `scout` CLI

**Files:**
- Create: `src/scout/scout.ts`
- Create: `src/scout/scout.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`
- Test: `src/scout/scout.test.ts`, `src/cli.test.ts`

**Interfaces:**

Consumes (exact signatures from lower-numbered tasks and existing code):

```ts
// Task 1 — src/scout/topics.ts
export interface NewTopic {
  channel: string; title: string; rawTitle: string; source: string; url: string;
  dedupeHash: string; score: number; reason: string; status: 'candidate' | 'rejected'
}
export function insertTopics(db: Database, rows: NewTopic[]): number
export function knownHashes(db: Database, channel: string, hashes: string[]): Set<string>
export function recentTopicTitles(db: Database, channel: string, limit?: number): string[]
export function listTopics(db: Database, filter?: { channel?: string; status?: TopicStatus }): TopicRow[]  // tests only

// Task 2 — src/config/channel.ts
export interface ScoutConfig { subreddits: string[]; rss: string[]; minScore: number; perSourceLimit: number; autoPremium: boolean }
export const DEFAULT_SCOUT: ScoutConfig
// ChannelConfig has: scout: ScoutConfig
export function loadChannelsDir(dir: string): ChannelConfig[]

// Task 3 — src/scout/sources/types.ts, reddit.ts
export interface TrendCandidate { title: string; url: string; sourceId: string; externalId: string }
export interface TrendSource { readonly id: string; fetch(opts: { limit: number; timeoutMs: number }): Promise<TrendCandidate[]> }
export type FetchLike = typeof globalThis.fetch
export function dedupeHash(sourceId: string, externalId: string): string
export const SOURCE_FETCH_TIMEOUT_MS = 10_000
export function redditSource(subreddit: string, fetchImpl?: FetchLike): TrendSource

// Task 4 — src/scout/sources/rss.ts
export function rssSource(feedUrl: string, fetchImpl?: FetchLike): TrendSource

// Task 5 — src/jobs/costs.ts
export function assertGlobalDayBudget(db: Database, upcomingUsdMicros: number): void  // throws BudgetExceededError('global-day ...')
export function recordCost(db: Database, jobId: string, provider: string, operation: string, usdMicros: number): void
export class BudgetExceededError extends Error { constructor(public reason: string) }

// Task 6 — src/scout/score.ts
export const ESTIMATED_SCOUT_COST_MICROS = 20_000
export interface ScoredCandidate { candidateIndex: number; score: number; topic: string; reason: string }
export async function scoreCandidates(opts: {
  candidates: TrendCandidate[]; niche: string[]; recentTitles: string[]; client?: Anthropic;
}): Promise<{ scored: ScoredCandidate[]; costUsdMicros: number }>
// normalization guarantee: exactly one entry per input candidate, candidateIndex in range

// Existing — src/providers/errors.ts
export function errorCostUsdMicros(err: unknown): number | undefined

// Existing — src/db/index.ts
export function openDb(dbPath: string): Database
```

Produces (Task 14's golden-path loop test and the operator rely on these):

```ts
// src/scout/scout.ts
export interface ScoutChannelResult {
  channel: string; fetched: number; alreadyKnown: number; scored: number;
  queued: number; rejected: number; sourceErrors: string[]; costUsdMicros: number;
  scoringError?: string   // set when the Haiku call threw (message); queued/rejected are 0 then
}
export class AllSourcesFailedError extends Error {
  // Carries the per-channel results so the CLI can still print its one JSON
  // line (Global Constraints: JSON even on failure outcomes) before exit 1.
  constructor(message: string, public results: ScoutChannelResult[]) {
    super(message)
    this.name = 'AllSourcesFailedError'
  }
}
export async function scoutChannel(db: Database, channel: ChannelConfig, opts?: {
  client?: Anthropic; fetchImpl?: FetchLike;
}): Promise<ScoutChannelResult>
export async function scoutAll(db: Database, channels: ChannelConfig[], opts?: {
  client?: Anthropic; fetchImpl?: FetchLike;
}): Promise<ScoutChannelResult[]>

// CLI: brainrot scout [--db <path>] [--channels-dir <dir>]   (default channels/)
// stdout: one JSON line { channels: ScoutChannelResult[] } — printed even on
// AllSourcesFailedError (the error carries results); diagnostics on stderr;
// exit 1 on AllSourcesFailedError (after the JSON line) or config/db errors (no JSON line)
```

Binding semantics (from the contract): sources = subreddits mapped through `redditSource` then rss through `rssSource`; per-source isolation (a failing source contributes one `sourceErrors` entry and zero candidates); hash-filter via `knownHashes` BEFORE scoring; empty remainder → NO Haiku call, zero cost; `assertGlobalDayBudget(db, ESTIMATED_SCOUT_COST_MICROS)` BEFORE the call; `recordCost` under sentinel `scout:<name>` (`provider 'anthropic'`, `operation 'scout-score'`) on success AND on thrown-with-cost errors, then rethrow; `score >= minScore` → `'candidate'` with `title = scored.topic`, else `'rejected'`; one batched `insertTopics`. `scoutAll` skips sourceless channels entirely, isolates per-channel scoring failures (stderr log + `scoringError` + continue), throws `AllSourcesFailedError` only when every source of every scouted channel errored — and that error carries the collected `results` so the CLI prints its one JSON line before exiting 1.

Run every command from the repo root `/Users/alex/code/project-brainrot`.

- [ ] **Step 1: Write the failing scoutChannel happy-path test (red)**

  Create `src/scout/scout.test.ts`:

  ```ts
  import { afterEach, describe, expect, it, vi } from 'vitest'
  import type Anthropic from '@anthropic-ai/sdk'
  import { openDb } from '../db/index.js'
  import { BudgetExceededError } from '../jobs/costs.js'
  import { DEFAULT_SCOUT } from '../config/channel.js'
  import type { ChannelConfig, ScoutConfig } from '../config/channel.js'
  import { testChannel } from '../stages/_testkit.js'
  import type { FetchLike } from './sources/types.js'
  import { listTopics } from './topics.js'
  import { AllSourcesFailedError, scoutAll, scoutChannel } from './scout.js'

  // Channel with scout sources; testChannel supplies every non-scout field.
  function scoutedChannel(overrides: Partial<ScoutConfig> = {}, name = 'chan-a'): ChannelConfig {
    return testChannel({ name, scout: { ...DEFAULT_SCOUT, subreddits: ['space'], ...overrides } })
  }

  // Reddit hot.json fixture: exactly the fields redditSource reads.
  function redditJson(posts: { name: string; title: string; stickied?: boolean }[]): string {
    return JSON.stringify({
      data: {
        children: posts.map((p) => ({
          kind: 't3',
          data: {
            name: p.name,
            title: p.title,
            permalink: `/r/space/comments/${p.name}/`,
            stickied: p.stickied ?? false,
          },
        })),
      },
    })
  }

  // URL-substring-keyed fetch stub: string body → 200 response, Error → throw.
  // Unmatched URLs throw, so a test never silently hits an unexpected source.
  function fetchStub(bodyBySubstring: Record<string, string | Error>): FetchLike {
    return (async (input: RequestInfo | URL) => {
      const url = String(input)
      for (const [needle, body] of Object.entries(bodyBySubstring)) {
        if (url.includes(needle)) {
          if (body instanceof Error) throw body
          return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as FetchLike
  }

  function fakeClient(response: unknown): { client: Anthropic; create: ReturnType<typeof vi.fn> } {
    const create = vi.fn().mockResolvedValue(response)
    return { client: { messages: { create } } as unknown as Anthropic, create }
  }

  // A schema-valid emit tool_use carrying the given scores. Default usage costs
  // 1000×1 + 200×5 = 2000 usd-micros at the claude-haiku-4-5 list price.
  function emitScores(
    scores: { candidateIndex: number; score: number; topic: string; reason: string }[],
    usage = { input_tokens: 1000, output_tokens: 200 },
  ) {
    return { content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { scores } }], usage }
  }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('scoutChannel', () => {
    it('fetches, scores, inserts, and ledgers under the scout sentinel', async () => {
      const db = openDb(':memory:')
      const channel = scoutedChannel() // minScore 60
      const fetchImpl = fetchStub({
        '/r/space/hot.json': redditJson([
          { name: 't3_aaa', title: 'Moon drifting measured' },
          { name: 't3_bbb', title: 'Buy my telescope (ad)' },
        ]),
      })
      const { client, create } = fakeClient(
        emitScores([
          { candidateIndex: 0, score: 85, topic: 'The Moon is escaping Earth', reason: 'novel physics hook' },
          { candidateIndex: 1, score: 10, topic: 'Telescope ad', reason: 'commercial spam' },
        ]),
      )
      const result = await scoutChannel(db, channel, { client, fetchImpl })
      expect(result).toEqual({
        channel: 'chan-a',
        fetched: 2,
        alreadyKnown: 0,
        scored: 2,
        queued: 1,
        rejected: 1,
        sourceErrors: [],
        costUsdMicros: 2_000,
      })
      const topics = listTopics(db, { channel: 'chan-a' })
      expect(topics).toHaveLength(2)
      const queued = topics.find((t) => t.status === 'candidate')
      // the reframed topic becomes the title; the raw headline is provenance
      expect(queued?.title).toBe('The Moon is escaping Earth')
      expect(queued?.rawTitle).toBe('Moon drifting measured')
      expect(queued?.source).toBe('reddit:r/space')
      const costs = db.prepare('SELECT job_id, provider, operation, usd_micros FROM costs').all()
      expect(costs).toEqual([
        { job_id: 'scout:chan-a', provider: 'anthropic', operation: 'scout-score', usd_micros: 2_000 },
      ])
      // ONE batched call for the whole channel
      expect(create).toHaveBeenCalledTimes(1)
      db.close()
    })
  })
  ```

  Run `pnpm vitest run src/scout/scout.test.ts` and observe the failure: the module file does not exist, so vitest fails at load with `Error: Failed to resolve import "./scout.js" from "src/scout/scout.test.ts"`. (From the next cycle on, with the file present, missing named exports resolve to `undefined` and fail at runtime as TypeErrors instead.)

- [ ] **Step 2: Implement the scoutChannel happy path (green)**

  Create `src/scout/scout.ts`. This cycle deliberately omits the hash filter, per-source isolation, and the budget/ledger error path — each arrives with its own failing test below:

  ```ts
  import type { Database } from 'better-sqlite3'
  import type Anthropic from '@anthropic-ai/sdk'
  import type { ChannelConfig } from '../config/channel.js'
  import { recordCost } from '../jobs/costs.js'
  import { dedupeHash, SOURCE_FETCH_TIMEOUT_MS } from './sources/types.js'
  import type { FetchLike, TrendCandidate, TrendSource } from './sources/types.js'
  import { redditSource } from './sources/reddit.js'
  import { rssSource } from './sources/rss.js'
  import { scoreCandidates } from './score.js'
  import { insertTopics, recentTopicTitles } from './topics.js'
  import type { NewTopic } from './topics.js'

  export interface ScoutChannelResult {
    channel: string
    fetched: number
    alreadyKnown: number
    scored: number
    queued: number
    rejected: number
    sourceErrors: string[]
    costUsdMicros: number
    scoringError?: string
  }

  export async function scoutChannel(
    db: Database,
    channel: ChannelConfig,
    opts: { client?: Anthropic; fetchImpl?: FetchLike } = {},
  ): Promise<ScoutChannelResult> {
    const sources: TrendSource[] = [
      ...channel.scout.subreddits.map((sub) => redditSource(sub, opts.fetchImpl)),
      ...channel.scout.rss.map((feed) => rssSource(feed, opts.fetchImpl)),
    ]

    const sourceErrors: string[] = []
    const candidates: TrendCandidate[] = []
    for (const source of sources) {
      candidates.push(
        ...(await source.fetch({
          limit: channel.scout.perSourceLimit,
          timeoutMs: SOURCE_FETCH_TIMEOUT_MS,
        })),
      )
    }

    const result: ScoutChannelResult = {
      channel: channel.name,
      fetched: candidates.length,
      alreadyKnown: 0,
      scored: 0,
      queued: 0,
      rejected: 0,
      sourceErrors,
      costUsdMicros: 0,
    }

    const fresh = candidates.map((candidate) => ({
      candidate,
      hash: dedupeHash(candidate.sourceId, candidate.externalId),
    }))
    if (fresh.length === 0) return result

    result.scored = fresh.length
    const scored = await scoreCandidates({
      candidates: fresh.map((f) => f.candidate),
      niche: channel.niche,
      recentTitles: recentTopicTitles(db, channel.name),
      client: opts.client,
    })
    result.costUsdMicros = scored.costUsdMicros
    // Sentinel job id: FKs are off by design, and the global-day query sums ALL
    // costs rows, so scout spend counts toward the operator ceiling.
    recordCost(db, `scout:${channel.name}`, 'anthropic', 'scout-score', scored.costUsdMicros)

    const rows: NewTopic[] = scored.scored.map((s) => {
      const { candidate, hash } = fresh[s.candidateIndex]
      return {
        channel: channel.name,
        title: s.topic,
        rawTitle: candidate.title,
        source: candidate.sourceId,
        url: candidate.url,
        dedupeHash: hash,
        score: s.score,
        reason: s.reason,
        // At/above the channel threshold → production queue; below → remembered
        // rejection (the hash filter keeps it away from Haiku forever).
        status: s.score >= channel.scout.minScore ? 'candidate' : 'rejected',
      }
    })
    result.queued = rows.filter((r) => r.status === 'candidate').length
    result.rejected = rows.length - result.queued
    insertTopics(db, rows)
    return result
  }
  ```

  (The test file also imports `scoutAll`/`AllSourcesFailedError`; those stay `undefined` until their own cycle — only the tests that call them would fail, and none do yet.)

  Run `pnpm vitest run src/scout/scout.test.ts` — expect `Test Files  1 passed (1)`, `Tests  1 passed (1)`.

- [ ] **Step 3: Commit the happy path**

  ```bash
  git add src/scout/scout.ts src/scout/scout.test.ts
  git commit -m "$(cat <<'EOF'
  feat: add scoutChannel orchestrator happy path

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 4: Write the failing re-run dedupe test (red)**

  Append inside the `describe('scoutChannel', ...)` block of `src/scout/scout.test.ts`:

  ```ts
    it('re-runs are free: known hashes are filtered before the Haiku call', async () => {
      const db = openDb(':memory:')
      const channel = scoutedChannel()
      const fetchImpl = fetchStub({
        '/r/space/hot.json': redditJson([{ name: 't3_aaa', title: 'Moon drifting' }]),
      })
      const { client, create } = fakeClient(
        emitScores([{ candidateIndex: 0, score: 20, topic: 'Moon', reason: 'dull' }]),
      )
      await scoutChannel(db, channel, { client, fetchImpl })
      const second = await scoutChannel(db, channel, { client, fetchImpl })
      expect(second).toEqual({
        channel: 'chan-a',
        fetched: 1,
        alreadyKnown: 1,
        scored: 0,
        queued: 0,
        rejected: 0,
        sourceErrors: [],
        costUsdMicros: 0,
      })
      // the second run never reached Haiku
      expect(create).toHaveBeenCalledTimes(1)
      // the below-threshold row stayed a remembered rejection — never re-scored
      expect(listTopics(db, { channel: 'chan-a', status: 'rejected' })).toHaveLength(1)
      db.close()
    })
  ```

  Run `pnpm vitest run src/scout/scout.test.ts` and observe the failure: `AssertionError` on the `toEqual` — the actual second result shows `alreadyKnown: 0, scored: 1, rejected: 1, costUsdMicros: 2000` because the known item was re-scored (and `create` was called twice).

- [ ] **Step 5: Filter known hashes before scoring (green)**

  In `src/scout/scout.ts`, add `knownHashes` to the topics import:

  ```ts
  import { insertTopics, knownHashes, recentTopicTitles } from './topics.js'
  ```

  and replace the `const fresh = candidates.map(...)` block with:

  ```ts
    // Hash-filter BEFORE scoring: known items never reach Haiku again, so scout
    // re-runs are free and rejected topics stay rejected without re-spend.
    const hashes = candidates.map((c) => dedupeHash(c.sourceId, c.externalId))
    const known = knownHashes(db, channel.name, hashes)
    const fresh = candidates
      .map((candidate, i) => ({ candidate, hash: hashes[i] }))
      .filter((f) => !known.has(f.hash))
    result.alreadyKnown = candidates.length - fresh.length
    if (fresh.length === 0) return result
  ```

  Run `pnpm vitest run src/scout/scout.test.ts` — expect `Tests  2 passed (2)`.

- [ ] **Step 6: Commit the pre-score filter**

  ```bash
  git add src/scout/scout.ts src/scout/scout.test.ts
  git commit -m "$(cat <<'EOF'
  feat: filter known hashes before scout scoring

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 7: Write the failing per-source isolation test (red)**

  Append inside `describe('scoutChannel', ...)`:

  ```ts
    it('isolates a failing source: one sourceErrors entry, other sources still scout', async () => {
      const db = openDb(':memory:')
      const channel = scoutedChannel({ subreddits: ['space', 'askscience'] })
      const fetchImpl = fetchStub({
        '/r/space/hot.json': new Error('connect timeout'),
        '/r/askscience/hot.json': redditJson([{ name: 't3_ccc', title: 'Why is the sky blue' }]),
      })
      const { client } = fakeClient(
        emitScores([{ candidateIndex: 0, score: 70, topic: 'Sky color explained', reason: 'classic' }]),
      )
      const result = await scoutChannel(db, channel, { client, fetchImpl })
      expect(result.fetched).toBe(1)
      expect(result.queued).toBe(1)
      expect(result.sourceErrors).toHaveLength(1)
      // entries are prefixed with the failing source's id
      expect(result.sourceErrors[0]).toMatch(/^reddit:r\/space: /)
      db.close()
    })
  ```

  Run `pnpm vitest run src/scout/scout.test.ts` and observe the failure: the test errors with `Error: connect timeout` — the source's rejection propagates out of `scoutChannel` because nothing isolates it yet.

- [ ] **Step 8: Isolate per-source failures (green)**

  In `src/scout/scout.ts`, replace the fetch loop with:

  ```ts
    // Per-source isolation: a failed or timed-out source contributes zero
    // candidates and one sourceErrors entry; the run continues (design spec §4).
    for (const source of sources) {
      try {
        candidates.push(
          ...(await source.fetch({
            limit: channel.scout.perSourceLimit,
            timeoutMs: SOURCE_FETCH_TIMEOUT_MS,
          })),
        )
      } catch (err) {
        const entry = `${source.id}: ${err instanceof Error ? err.message : String(err)}`
        // Spec §4: a failing source "logs a warning" — stderr, since stdout is
        // reserved for the CLI's single JSON line.
        console.error(`scout: source ${entry}`)
        sourceErrors.push(entry)
      }
    }
  ```

  Run `pnpm vitest run src/scout/scout.test.ts` — expect `Tests  3 passed (3)`.

- [ ] **Step 9: Commit source isolation**

  ```bash
  git add src/scout/scout.ts src/scout/scout.test.ts
  git commit -m "$(cat <<'EOF'
  feat: isolate per-source fetch failures in scoutChannel

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 10: Write the failing budget-gate and ledger-complete tests (red)**

  Append inside `describe('scoutChannel', ...)`:

  ```ts
    it('gates on the global day budget BEFORE spending', async () => {
      vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', '0')
      const db = openDb(':memory:')
      const channel = scoutedChannel()
      const fetchImpl = fetchStub({
        '/r/space/hot.json': redditJson([{ name: 't3_aaa', title: 'Moon drifting' }]),
      })
      const { client, create } = fakeClient(emitScores([]))
      await expect(scoutChannel(db, channel, { client, fetchImpl })).rejects.toThrow(
        BudgetExceededError,
      )
      // gate fired pre-call: no API hit, no cost row, no topics
      expect(create).not.toHaveBeenCalled()
      expect(db.prepare('SELECT COUNT(*) AS n FROM costs').get()).toEqual({ n: 0 })
      expect(listTopics(db)).toHaveLength(0)
      db.close()
    })

    it('ledgers spend from a paid-but-invalid scoring response, then rethrows', async () => {
      const db = openDb(':memory:')
      const channel = scoutedChannel()
      const fetchImpl = fetchStub({
        '/r/space/hot.json': redditJson([{ name: 't3_aaa', title: 'Moon drifting' }]),
      })
      // schema-invalid emit input: structuredCompletion throws a ZodError with
      // costUsdMicros attached (the call was billed regardless)
      const { client } = fakeClient({
        content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { scores: 'not-an-array' } }],
        usage: { input_tokens: 100, output_tokens: 50 },
      })
      await expect(scoutChannel(db, channel, { client, fetchImpl })).rejects.toThrow()
      const costs = db.prepare('SELECT job_id, operation, usd_micros FROM costs').all()
      // 100×1 + 50×5 = 350 usd-micros at the haiku list price
      expect(costs).toEqual([{ job_id: 'scout:chan-a', operation: 'scout-score', usd_micros: 350 }])
      expect(listTopics(db)).toHaveLength(0)
      db.close()
    })
  ```

  Run `pnpm vitest run src/scout/scout.test.ts` and observe the failures: the gate test fails with `AssertionError: promise resolved ... instead of rejecting` (no gate exists, the mocked call succeeds); the ledger test passes its `rejects.toThrow()` (the ZodError propagates) but fails on the costs assertion — `expected [] to deeply equal [ { job_id: 'scout:chan-a', … } ]`.

- [ ] **Step 11: Add the gate and the ledger-complete error path (green)**

  In `src/scout/scout.ts`, extend the imports:

  ```ts
  import { assertGlobalDayBudget, recordCost } from '../jobs/costs.js'
  import { errorCostUsdMicros } from '../providers/errors.js'
  import { ESTIMATED_SCOUT_COST_MICROS, scoreCandidates } from './score.js'
  import type { ScoredCandidate } from './score.js'
  ```

  (replacing the previous `costs.js` and `score.js` import lines). Below the `ScoutChannelResult` interface, add the partial-result carrier:

  ```ts
  // Carries the partial ScoutChannelResult across scoutChannel's rethrow so
  // scoutAll can report real fetch/dedupe counts for a channel whose scoring
  // failed. Module-private symbol: the original error identity must survive
  // (callers match on BudgetExceededError / ZodError).
  const PARTIAL_RESULT = Symbol('scout-partial-result')

  function attachPartial(err: unknown, partial: ScoutChannelResult): void {
    if (err !== null && typeof err === 'object') {
      ;(err as Record<PropertyKey, unknown>)[PARTIAL_RESULT] = partial
    }
  }
  ```

  Add the gated, ledger-complete scoring helper (module-private, above `scoutChannel`):

  ```ts
  // Scoring with the ledger-complete error path: gate first; if the call spent
  // before failing (paid-but-invalid response), record that spend before the
  // error propagates.
  async function scoreWithLedger(
    db: Database,
    channel: ChannelConfig,
    fresh: { candidate: TrendCandidate; hash: string }[],
    result: ScoutChannelResult,
    client?: Anthropic,
  ): Promise<{ scored: ScoredCandidate[]; costUsdMicros: number }> {
    try {
      // The scout has no job row to hang assertBudget on; gate the estimated
      // spend against the global daily cap directly (design spec §8).
      assertGlobalDayBudget(db, ESTIMATED_SCOUT_COST_MICROS)
      return await scoreCandidates({
        candidates: fresh.map((f) => f.candidate),
        niche: channel.niche,
        recentTitles: recentTopicTitles(db, channel.name),
        client,
      })
    } catch (err) {
      const spent = errorCostUsdMicros(err)
      if (spent !== undefined) {
        recordCost(db, `scout:${channel.name}`, 'anthropic', 'scout-score', spent)
        result.costUsdMicros = spent
      }
      attachPartial(err, result)
      throw err
    }
  }
  ```

  In `scoutChannel`, replace the direct scoring call

  ```ts
    const scored = await scoreCandidates({
      candidates: fresh.map((f) => f.candidate),
      niche: channel.niche,
      recentTitles: recentTopicTitles(db, channel.name),
      client: opts.client,
    })
  ```

  with:

  ```ts
    const scored = await scoreWithLedger(db, channel, fresh, result, opts.client)
  ```

  Run `pnpm vitest run src/scout/scout.test.ts` — expect `Tests  5 passed (5)`.

- [ ] **Step 12: Commit the gate and error ledgering**

  ```bash
  git add src/scout/scout.ts src/scout/scout.test.ts
  git commit -m "$(cat <<'EOF'
  feat: gate scout scoring on the global day budget and ledger error spend

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 13: Write the failing scoutAll tests (red)**

  Append a new describe block at the end of `src/scout/scout.test.ts`:

  ```ts
  describe('scoutAll', () => {
    it('skips sourceless channels and isolates a scoring failure per channel', async () => {
      const db = openDb(':memory:')
      const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const manualOnly = testChannel({ name: 'manual-only' }) // DEFAULT_SCOUT: no sources
      const bad = scoutedChannel({ subreddits: ['failing'] }, 'bad')
      const good = scoutedChannel({}, 'good')
      const fetchImpl = fetchStub({
        '/r/failing/hot.json': JSON.stringify({
          data: { children: [{ kind: 't3', data: { name: 't3_f', title: 'F', permalink: '/r/failing/comments/t3_f/', stickied: false } }] },
        }),
        '/r/space/hot.json': redditJson([{ name: 't3_g', title: 'G' }]),
      })
      // first scoring call (bad) is paid-but-invalid; second (good) is valid
      const create = vi
        .fn()
        .mockResolvedValueOnce({
          content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { scores: 'nope' } }],
          usage: { input_tokens: 10, output_tokens: 5 },
        })
        .mockResolvedValueOnce(
          emitScores([{ candidateIndex: 0, score: 90, topic: 'Good topic', reason: 'strong' }]),
        )
      const client = { messages: { create } } as unknown as Anthropic

      const results = await scoutAll(db, [manualOnly, bad, good], { client, fetchImpl })
      expect(results.map((r) => r.channel)).toEqual(['bad', 'good']) // manual-only skipped
      expect(results[0].scoringError).toBeDefined()
      expect(results[0].queued).toBe(0)
      expect(results[0].fetched).toBe(1) // fetch counts survive the scoring failure
      expect(results[1].scoringError).toBeUndefined()
      expect(results[1].queued).toBe(1)
      // the failing channel logged to stderr and its paid spend was ledgered
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('bad'))
      const costs = db.prepare('SELECT job_id FROM costs ORDER BY id').all()
      expect(costs).toEqual([{ job_id: 'scout:bad' }, { job_id: 'scout:good' }])
      stderrSpy.mockRestore()
      db.close()
    })

    it('throws AllSourcesFailedError only when every source everywhere failed', async () => {
      const db = openDb(':memory:')
      const a = scoutedChannel({ subreddits: ['one'] }, 'a')
      const b = scoutedChannel({ subreddits: ['two'] }, 'b')
      // fetchStub({}) rejects every URL — total source failure
      const { client, create } = fakeClient(emitScores([]))
      const err = await scoutAll(db, [a, b], { client, fetchImpl: fetchStub({}) }).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(AllSourcesFailedError)
      // the error carries every channel's result so the CLI still prints its JSON line
      expect((err as AllSourcesFailedError).results.map((r) => r.channel)).toEqual(['a', 'b'])
      expect(create).not.toHaveBeenCalled()

      // one healthy source flips it back to a normal (partial) run
      const mixed = fetchStub({ '/r/two/hot.json': redditJson([{ name: 't3_x', title: 'X' }]) })
      const { client: client2 } = fakeClient(
        emitScores([{ candidateIndex: 0, score: 70, topic: 'X topic', reason: 'ok' }]),
      )
      const results = await scoutAll(db, [a, b], { client: client2, fetchImpl: mixed })
      expect(results).toHaveLength(2)
      expect(results[0].sourceErrors).toHaveLength(1)
      expect(results[1].queued).toBe(1)
      db.close()
    })
  })
  ```

  (The `redditJson` helper hardcodes `/r/space/` permalinks; the `bad` channel's fixture is inlined because its subreddit differs — permalink content is irrelevant to these assertions.)

  Run `pnpm vitest run src/scout/scout.test.ts` and observe the failure: both new tests fail at runtime with `TypeError: scoutAll is not a function` — the named export does not exist yet, so esbuild resolved it to `undefined`.

- [ ] **Step 14: Implement scoutAll (green)**

  In `src/scout/scout.ts`, add below `attachPartial`:

  ```ts
  function readPartial(err: unknown): ScoutChannelResult | undefined {
    if (err !== null && typeof err === 'object' && PARTIAL_RESULT in err) {
      return (err as Record<PropertyKey, unknown>)[PARTIAL_RESULT] as ScoutChannelResult
    }
    return undefined
  }
  ```

  and append at the end of the file:

  ```ts
  export class AllSourcesFailedError extends Error {
  // Carries the per-channel results so the CLI can still print its one JSON
  // line (Global Constraints: JSON even on failure outcomes) before exit 1.
  constructor(message: string, public results: ScoutChannelResult[]) {
    super(message)
    this.name = 'AllSourcesFailedError'
  }
}

  export async function scoutAll(
    db: Database,
    channels: ChannelConfig[],
    opts: { client?: Anthropic; fetchImpl?: FetchLike } = {},
  ): Promise<ScoutChannelResult[]> {
    const results: ScoutChannelResult[] = []
    let totalSources = 0
    let failedSources = 0
    for (const channel of channels) {
      const sourceCount = channel.scout.subreddits.length + channel.scout.rss.length
      // No [scout] sources → not a scouted channel; manual produce only.
      if (sourceCount === 0) continue
      totalSources += sourceCount
      try {
        const result = await scoutChannel(db, channel, opts)
        failedSources += result.sourceErrors.length
        results.push(result)
      } catch (err) {
        // Per-channel isolation: one channel's scoring failure (including the
        // global-day budget gate) must not starve the others.
        const message = err instanceof Error ? err.message : String(err)
        console.error(`scout: channel "${channel.name}" scoring failed: ${message}`)
        const partial = readPartial(err) ?? {
          channel: channel.name,
          fetched: 0,
          alreadyKnown: 0,
          scored: 0,
          queued: 0,
          rejected: 0,
          sourceErrors: [],
          costUsdMicros: 0,
        }
        failedSources += partial.sourceErrors.length
        // queued/rejected are 0 on the error path by contract — nothing was inserted.
        results.push({ ...partial, queued: 0, rejected: 0, scoringError: message })
      }
    }
    if (totalSources > 0 && failedSources === totalSources) {
      throw new AllSourcesFailedError(
        `all ${totalSources} trend source(s) across ${results.length} channel(s) failed`,
        results,
      )
    }
    return results
  }
  ```

  Run `pnpm vitest run src/scout/scout.test.ts` — expect `Test Files  1 passed (1)`, `Tests  7 passed (7)`.

- [ ] **Step 15: Commit scoutAll**

  ```bash
  git add src/scout/scout.ts src/scout/scout.test.ts
  git commit -m "$(cat <<'EOF'
  feat: add scoutAll with per-channel isolation and AllSourcesFailedError

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 16: Write the failing CLI tests (red)**

  In `src/cli.test.ts`, extend the `node:fs` import:

  ```ts
  import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
  ```

  Append inside the `describe('brainrot CLI', ...)` block (after the last `produce` test), reusing the existing `tmpDbPath`/`cleanup` helpers:

  ```ts
    // Plan-1-shape channel TOML with no [scout] table: loadChannelsDir parses it,
    // scoutAll skips it (DEFAULT_SCOUT has no sources) — the cheapest full E2E.
    const SCOUTLESS_TOML = [
      'name = "cli-scout-test"',
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
    ].join('\n')

    it('`scout --help` prints usage with --db/--channels-dir', async () => {
      const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'scout', '--help'], {
        reject: false,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--db')
      expect(result.stdout).toContain('--channels-dir')
    }, 60000)

    it('`scout` over a sourceless channels dir prints one JSON line and exits 0', async () => {
      const dbPath = tmpDbPath()
      const channelsDir = mkdtempSync(path.join(tmpdir(), 'brainrot-channels-'))
      cleanup.push(channelsDir)
      writeFileSync(path.join(channelsDir, 'test.toml'), SCOUTLESS_TOML)
      const result = await execa(
        'pnpm',
        ['exec', 'tsx', 'src/cli.ts', 'scout', '--db', dbPath, '--channels-dir', channelsDir],
        { reject: false },
      )
      expect(result.exitCode).toBe(0)
      // exactly one cron-greppable JSON line on stdout
      expect(JSON.parse(result.stdout)).toEqual({ channels: [] })
    }, 60000)
  ```

  Run `pnpm vitest run src/cli.test.ts` and observe the failures: both new tests get exit code 1 from the subprocess — commander prints `error: unknown command 'scout'` on stderr — so the `exitCode).toBe(0)` assertions fail.

- [ ] **Step 17: Wire the `scout` CLI command (green)**

  In `src/cli.ts`, extend the config import and add the scout import:

  ```ts
  import { loadChannelConfig, loadChannelsDir } from './config/channel.js'
  import { AllSourcesFailedError, scoutAll } from './scout/scout.js'
  ```

  Add the command after the `produce` command block:

  ```ts
  program
    .command('scout')
    .option('--db <path>', 'sqlite db path')
    .option('--channels-dir <dir>', 'channel TOML directory', 'channels')
    .action(async (opts: { db?: string; channelsDir: string }) => {
      // Config load precedes the db handle so a bad channels dir fails clean.
      const channels = loadChannelsDir(opts.channelsDir)
      const db = openDb(resolveDbPath(opts.db))
      try {
        const results = await scoutAll(db, channels)
        // One cron-greppable JSON line; diagnostics went to stderr.
        process.stdout.write(JSON.stringify({ channels: results }) + '\n')
      } catch (err) {
        if (!(err instanceof AllSourcesFailedError)) throw err
        // Total source failure is systemic (network down, Reddit blocking):
        // still one JSON line — the contract holds on failure outcomes — then
        // exit 1 so cron flags the run.
        process.stdout.write(JSON.stringify({ channels: err.results }) + '\n')
        console.error(err.message)
        process.exitCode = 1
      } finally {
        db.close()
      }
    })
  ```

  Run `pnpm vitest run src/cli.test.ts` — expect `Test Files  1 passed (1)`, `Tests  12 passed (12)` (10 existing + 2 new; the subprocess tests take a few seconds each).

- [ ] **Step 18: Whole-suite and type gates**

  Run `pnpm vitest run` — expect every test file to pass (contract tests are excluded by `vitest.config.ts` unless `CONTRACT=1`; no pre-existing failures are expected).

  Run `pnpm tsc --noEmit` — expect exit code 0 with no output.

- [ ] **Step 19: Final commit**

  ```bash
  git add src/cli.ts src/cli.test.ts
  git commit -m "$(cat <<'EOF'
  feat: add brainrot scout CLI command

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```


### Task 8: Lease

**Files:**
- Create: `src/loop/lease.ts` (new directory `src/loop/`)
- Create: `src/loop/lease.test.ts`
- Modify: `src/db/schema.sql`
- Test: `src/loop/lease.test.ts`

**Interfaces:**

Consumes (existing code, verbatim):

```ts
// src/db/index.ts — applies schema.sql on open; WAL; FKs deliberately OFF
export function openDb(dbPath: string): Database   // ':memory:' works in tests
```

Produces (binding — Task 11 `produce-next` acquires `'produce'` with holder `` `pid:${process.pid}` `` and releases in a `try/finally`):

```ts
// src/loop/lease.ts
export const PRODUCE_LEASE_TTL_MS = 5_400_000   // 90 min
export function acquireLease(db: Database, name: string, holder: string, ttlMs: number): boolean
// one synchronous transaction: free row OR expires_at <= now → upsert(name, holder, now+ttl), true; else false
export function releaseLease(db: Database, name: string, holder: string): void
// deletes only when holder matches (a takeover must not be released by the evicted holder)
```

Plus the `leases` table in `src/db/schema.sql` (DDL below, verbatim from the contract). `CREATE TABLE IF NOT EXISTS` means existing DBs pick it up on next open — no migration machinery.

Semantics pinned by the design (spec §6): a tick that finds the lease held exits as a benign no-op — that is the NORMAL case while a premium render from the previous cron firing is still running. A crashed holder self-heals by TTL expiry. Timestamps are ISO-8601 UTC millisecond strings (`new Date().toISOString()`), the exact format of the schema's `strftime('%Y-%m-%dT%H:%M:%fZ','now')` default elsewhere, so lexicographic string comparison is correct time comparison.

---

- [ ] **Step 1: Write the failing schema test**

  Create `src/loop/lease.test.ts` with exactly:

  ```ts
  import { describe, expect, it } from 'vitest'
  import { openDb } from '../db/index.js'

  describe('leases schema', () => {
    it('openDb creates the leases table with name as primary key', () => {
      const db = openDb(':memory:')
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='leases'")
        .all()
      expect(rows).toHaveLength(1)
      db.prepare(
        "INSERT INTO leases (name, holder, expires_at) VALUES ('produce', 'pid:1', '2026-01-01T00:00:00.000Z')",
      ).run()
      // name is the primary key: a second row for the same lease is a conflict
      expect(() =>
        db
          .prepare(
            "INSERT INTO leases (name, holder, expires_at) VALUES ('produce', 'pid:2', '2026-01-01T00:00:00.000Z')",
          )
          .run(),
      ).toThrow(/UNIQUE constraint failed/)
      db.close()
    })
  })
  ```

  Run it:

  ```bash
  pnpm vitest run src/loop/lease.test.ts
  ```

  Expected failure: 1 test fails at the first assertion with `expected [] to have a length of 1` — schema.sql has no `leases` table yet.

- [ ] **Step 2: Add the leases table to schema.sql, run green, commit**

  Task 1 left `src/db/schema.sql` ending with the `topics` table followed by the comment line `-- publishes table arrives in Plan 4.`. Replace that final comment line with (DDL verbatim from the contract, comment retained last):

  ```sql
  CREATE TABLE IF NOT EXISTS leases (
    name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  -- publishes table arrives in Plan 4.
  ```

  (If the trailing comment wording differs from Task 1's fragment, append the `CREATE TABLE` block at the end of the file and keep whatever future-tables comment exists as the last line.)

  Run to green:

  ```bash
  pnpm vitest run src/loop/lease.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  1 passed (1)`.

  Commit:

  ```bash
  git add src/db/schema.sql src/loop/lease.test.ts
  git commit -m "feat(db): add leases table for cross-process tick serialization" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 3: Write the failing acquireLease tests**

  In `src/loop/lease.test.ts`, add below the `openDb` import:

  ```ts
  import { acquireLease, PRODUCE_LEASE_TTL_MS } from './lease.js'
  ```

  Append at the end of the file:

  ```ts
  describe('acquireLease', () => {
    it('acquires a free lease and stamps holder + expiry exactly ttl ahead', () => {
      const db = openDb(':memory:')
      expect(PRODUCE_LEASE_TTL_MS).toBe(5_400_000)
      const before = Date.now()
      expect(acquireLease(db, 'produce', 'pid:100', PRODUCE_LEASE_TTL_MS)).toBe(true)
      const row = db
        .prepare("SELECT holder, expires_at FROM leases WHERE name = 'produce'")
        .get() as { holder: string; expires_at: string }
      expect(row.holder).toBe('pid:100')
      // expires_at = acquire-time + ttl, bounded by the wall clocks around the call
      const expires = Date.parse(row.expires_at)
      expect(expires).toBeGreaterThanOrEqual(before + PRODUCE_LEASE_TTL_MS)
      expect(expires).toBeLessThanOrEqual(Date.now() + PRODUCE_LEASE_TTL_MS)
      db.close()
    })

    it('refuses while the lease is held — even for the same holder', () => {
      const db = openDb(':memory:')
      expect(acquireLease(db, 'produce', 'pid:100', PRODUCE_LEASE_TTL_MS)).toBe(true)
      // a tick landing during a long render: the NORMAL no-op case
      expect(acquireLease(db, 'produce', 'pid:200', PRODUCE_LEASE_TTL_MS)).toBe(false)
      // acquire-if-free-or-expired has no same-holder re-entry
      expect(acquireLease(db, 'produce', 'pid:100', PRODUCE_LEASE_TTL_MS)).toBe(false)
      const row = db.prepare("SELECT holder FROM leases WHERE name = 'produce'").get() as {
        holder: string
      }
      expect(row.holder).toBe('pid:100')
      // a different lease name is independent
      expect(acquireLease(db, 'scout', 'pid:200', PRODUCE_LEASE_TTL_MS)).toBe(true)
      db.close()
    })
  })
  ```

  Run it:

  ```bash
  pnpm vitest run src/loop/lease.test.ts
  ```

  Expected failure: the entire file fails to collect with a module-resolution error (`Failed to load url ./lease.js` / `Cannot find module`), because `src/loop/lease.ts` does not exist yet. (A file-load failure, not the missing-named-export TypeError — the whole module is absent.)

- [ ] **Step 4: Implement acquireLease for the free-row case, run green, commit**

  Create `src/loop/lease.ts` with exactly:

  ```ts
  import type { Database } from 'better-sqlite3'

  // Generously above any single job's runtime: a crashed holder self-heals by
  // expiry instead of wedging the loop forever.
  export const PRODUCE_LEASE_TTL_MS = 5_400_000 // 90 min

  // Acquire-if-free in one synchronous transaction. BEGIN IMMEDIATE takes the
  // write lock up front so a concurrent process cannot interleave between the
  // read and the upsert.
  export function acquireLease(db: Database, name: string, holder: string, ttlMs: number): boolean {
    const attempt = db.transaction((): boolean => {
      const row = db.prepare('SELECT expires_at FROM leases WHERE name = ?').get(name) as
        | { expires_at: string }
        | undefined
      if (row !== undefined) return false
      const expiresAt = new Date(Date.now() + ttlMs).toISOString()
      db.prepare(
        'INSERT INTO leases (name, holder, expires_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at',
      ).run(name, holder, expiresAt)
      return true
    })
    return attempt.immediate()
  }
  ```

  Run to green:

  ```bash
  pnpm vitest run src/loop/lease.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  3 passed (3)`.

  Commit:

  ```bash
  git add src/loop/lease.ts src/loop/lease.test.ts
  git commit -m "feat(loop): acquireLease — single-transaction acquire-if-free" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 5: Write the failing expiry-takeover test**

  Append to `src/loop/lease.test.ts` inside the `acquireLease` describe block (after the refuses-while-held test):

  ```ts
    it('takes over an expired lease, replacing the holder', () => {
      const db = openDb(':memory:')
      db.prepare(
        "INSERT INTO leases (name, holder, expires_at) VALUES ('produce', 'pid:dead', '2020-01-01T00:00:00.000Z')",
      ).run()
      expect(acquireLease(db, 'produce', 'pid:new', PRODUCE_LEASE_TTL_MS)).toBe(true)
      const row = db
        .prepare("SELECT holder, expires_at FROM leases WHERE name = 'produce'")
        .get() as { holder: string; expires_at: string }
      expect(row.holder).toBe('pid:new')
      expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.now())
      db.close()
    })
  ```

  Run it:

  ```bash
  pnpm vitest run src/loop/lease.test.ts
  ```

  Expected failure: the new test fails with `expected false to be true` — the Step 4 guard refuses any existing row, expired or not. The other 3 tests stay green.

- [ ] **Step 6: Make acquireLease expiry-aware, run green, commit**

  In `src/loop/lease.ts`, replace

  ```ts
  // Acquire-if-free in one synchronous transaction. BEGIN IMMEDIATE takes the
  // write lock up front so a concurrent process cannot interleave between the
  // read and the upsert.
  export function acquireLease(db: Database, name: string, holder: string, ttlMs: number): boolean {
    const attempt = db.transaction((): boolean => {
      const row = db.prepare('SELECT expires_at FROM leases WHERE name = ?').get(name) as
        | { expires_at: string }
        | undefined
      if (row !== undefined) return false
  ```

  with

  ```ts
  // Acquire-if-free-or-expired in one synchronous transaction. BEGIN IMMEDIATE
  // takes the write lock up front so a concurrent process cannot interleave
  // between the read and the upsert. ISO-8601 UTC strings compare correctly
  // as strings, so no date parsing is needed in the guard.
  export function acquireLease(db: Database, name: string, holder: string, ttlMs: number): boolean {
    const attempt = db.transaction((): boolean => {
      const now = new Date().toISOString()
      const row = db.prepare('SELECT expires_at FROM leases WHERE name = ?').get(name) as
        | { expires_at: string }
        | undefined
      if (row !== undefined && row.expires_at > now) return false
  ```

  Run to green:

  ```bash
  pnpm vitest run src/loop/lease.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  4 passed (4)`.

  Commit:

  ```bash
  git add src/loop/lease.ts src/loop/lease.test.ts
  git commit -m "feat(loop): lease expiry takeover self-heals crashed holders" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 7: Write the failing releaseLease tests**

  In `src/loop/lease.test.ts`, extend the `./lease.js` import to:

  ```ts
  import { acquireLease, PRODUCE_LEASE_TTL_MS, releaseLease } from './lease.js'
  ```

  Append at the end of the file:

  ```ts
  describe('releaseLease', () => {
    it('deletes only when the holder matches', () => {
      const db = openDb(':memory:')
      acquireLease(db, 'produce', 'pid:100', PRODUCE_LEASE_TTL_MS)
      // wrong holder: no-op — the lease stays held
      releaseLease(db, 'produce', 'pid:999')
      expect(acquireLease(db, 'produce', 'pid:200', PRODUCE_LEASE_TTL_MS)).toBe(false)
      // right holder: freed for the next tick
      releaseLease(db, 'produce', 'pid:100')
      expect(acquireLease(db, 'produce', 'pid:200', PRODUCE_LEASE_TTL_MS)).toBe(true)
      db.close()
    })

    it('an evicted holder cannot release the takeover lease', () => {
      const db = openDb(':memory:')
      db.prepare(
        "INSERT INTO leases (name, holder, expires_at) VALUES ('produce', 'pid:dead', '2020-01-01T00:00:00.000Z')",
      ).run()
      acquireLease(db, 'produce', 'pid:new', PRODUCE_LEASE_TTL_MS)
      // the crashed process's finally-release fires late: must not free pid:new
      releaseLease(db, 'produce', 'pid:dead')
      const row = db.prepare("SELECT holder FROM leases WHERE name = 'produce'").get() as {
        holder: string
      }
      expect(row.holder).toBe('pid:new')
      db.close()
    })
  })
  ```

  Run it:

  ```bash
  pnpm vitest run src/loop/lease.test.ts
  ```

  Expected failure (house gotcha — a missing named export resolves to `undefined` under vitest/esbuild and fails at runtime, not import time): both new tests fail with `TypeError: releaseLease is not a function`. The 4 existing tests stay green.

- [ ] **Step 8: Implement releaseLease, run green**

  Append to `src/loop/lease.ts`:

  ```ts
  // Deletes only the caller's own lease: after an expiry takeover the evicted
  // holder's finally-release must not free the new holder's lease.
  export function releaseLease(db: Database, name: string, holder: string): void {
    db.prepare('DELETE FROM leases WHERE name = ? AND holder = ?').run(name, holder)
  }
  ```

  Run to green:

  ```bash
  pnpm vitest run src/loop/lease.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  6 passed (6)`.

- [ ] **Step 9: Run the whole suite and the type gate**

  ```bash
  pnpm vitest run
  ```

  Expected: every test file passes (the pre-existing suite plus `src/loop/lease.test.ts`), zero failures.

  ```bash
  pnpm tsc --noEmit
  ```

  Expected: no output, exit code 0.

- [ ] **Step 10: Commit**

  ```bash
  git add src/loop/lease.ts src/loop/lease.test.ts
  git commit -m "feat(loop): releaseLease deletes only the caller's own lease" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```


### Task 9: pipeline.ts move + resumeJob + resume CLI

**Files:**
- Create: `src/jobs/pipeline.ts`, `src/jobs/resume.ts`, `src/jobs/resume.test.ts`
- Modify: `src/cli.ts`
- Test: `src/jobs/resume.test.ts` (new); `src/cli.test.ts` is run UNTOUCHED to prove the move is behavior-preserving — do not edit it

**Interfaces:**

Consumes (exact signatures from lower-numbered tasks and existing code):

```ts
// Existing — src/cli.ts (the two functions being MOVED; their bodies are quoted
// verbatim in Step 2 below; parseTier stays in cli.ts unchanged)
export function stagesForTier(tier: Tier): StageDef[]
export function assertPremiumPreflight(tier: Tier): void

// Existing — src/jobs/runner.ts
export interface JobResult { jobId: string; status: 'ready' | 'needs-review' | 'failed' | 'blocked'; videoPath?: string }
export async function runJob(db: Database, channel: ChannelConfig, jobId: string, stages: StageDef[], options?: { runsRoot?: string }): Promise<JobResult>

// Existing — src/jobs/types.ts
export type Tier = 'volume' | 'premium'
export type StageName = 'script' | 'voice' | 'captions' | 'visuals' | 'assemble' | 'qc'
export const STAGE_ORDER: StageName[]
export interface StageDef { name: StageName; run(ctx: JobContext): Promise<void> }
export interface JobContext { jobId: string; db: Database; channel: ChannelConfig; tier: Tier; topic: string; runDir: string; artifactPath(stage: StageName, file: string): string; log: Logger }

// Existing — src/config/channel.ts (Task 2 extended it; [scout] is optional in TOML)
export function loadChannelConfig(path: string): ChannelConfig

// Task 1 — src/scout/topics.ts
export function markTopicUsedByJob(db: Database, jobId: string): void  // claimed row with matching job_id → 'used'; silent no-op when none

// Existing — src/db/index.ts
export function openDb(dbPath: string): Database
```

Produces (Tasks 10, 11, and 14 rely on these exact signatures):

```ts
// src/jobs/pipeline.ts — bodies moved VERBATIM from src/cli.ts
export function assertPremiumPreflight(tier: Tier): void
export function stagesForTier(tier: Tier): StageDef[]
// src/cli.ts keeps re-exporting both: export { stagesForTier, assertPremiumPreflight } from './jobs/pipeline.js'

// src/jobs/resume.ts
export class ResumeError extends Error {}  // message carries the refusal reason
export async function resumeJob(db: Database, jobId: string, opts: {
  runsRoot: string; channelsDir: string; force?: boolean;
  stagesFor?: (tier: Tier) => StageDef[];   // test seam; default stagesForTier
}): Promise<JobResult>
// job missing → ResumeError; status 'done'/'queued' → ResumeError;
// 'running' without force → ResumeError telling the operator to pass --force ('running' + force proceeds);
// channel TOML resolved as `${channelsDir}/${job.channel}.toml`, missing → ResumeError;
// premium → assertPremiumPreflight; runJob(...); library-landed ('ready' | 'needs-review') → markTopicUsedByJob.

// CLI: brainrot resume <jobId> [--db <path>] [--runs-root <path>] [--channels-dir <dir>] [--force]
// stdout: the JobResult JSON line; exit codes mirror produce
// (0 for ready/needs-review; 1 for failed/blocked and for every ResumeError/thrown error).
```

Run every command from the repo root `/Users/alex/code/project-brainrot`. House gotcha: with vitest/esbuild, importing a file that does not exist fails at collection with `Failed to resolve import`; a missing NAMED export from an existing file resolves to `undefined` and fails later at runtime with a TypeError.

- [ ] **Step 1: Write the failing pipeline-move test (red)**

  Create `src/jobs/resume.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest'
  import { assertPremiumPreflight as cliPreflight, stagesForTier as cliStages } from '../cli.js'
  import { assertPremiumPreflight, stagesForTier } from './pipeline.js'

  describe('jobs/pipeline', () => {
    it('cli.ts re-exports the moved helpers with identical identity', () => {
      // Re-export, not copy: the loop code and the CLI must share ONE wiring.
      expect(cliStages).toBe(stagesForTier)
      expect(cliPreflight).toBe(assertPremiumPreflight)
      // The move is verbatim: the six-stage produce order is unchanged.
      expect(stagesForTier('volume').map((s) => s.name)).toEqual([
        'script',
        'voice',
        'captions',
        'visuals',
        'assemble',
        'qc',
      ])
    })
  })
  ```

  Run `pnpm vitest run src/jobs/resume.test.ts` and observe the failure: the whole file errors at collection with `Error: Failed to resolve import "./pipeline.js" from "src/jobs/resume.test.ts". Does the file exist?` (0 tests run).

- [ ] **Step 2: Move the two functions to src/jobs/pipeline.ts (green)**

  Create `src/jobs/pipeline.ts`. The two function bodies AND their doc comments are verbatim from `src/cli.ts` (current main, untouched by Tasks 1–8); only the import specifiers change for the new location:

  ```ts
  import { scriptStage } from '../stages/script.js'
  import { voiceStage } from '../stages/voice.js'
  import { captionsStage } from '../stages/captions.js'
  import { visualsVolumeStage } from '../stages/visuals-volume.js'
  import { visualsPremiumStage } from '../stages/visuals-premium.js'
  import { assembleStage } from '../stages/assemble.js'
  import { qcStage } from '../stages/qc.js'
  import type { StageDef, Tier } from './types.js'

  /**
   * Premium pre-flight: premium visuals require a fal key, so refuse the run
   * before any config load, db handle, or job row exists when FAL_KEY is absent —
   * a job that could only ever fail for a missing key should never be created.
   * ELEVENLABS_API_KEY is deliberately NOT required: premium voice falls back to
   * kokoro when it is unset. Exported so cli.test.ts can assert it in-process.
   */
  export function assertPremiumPreflight(tier: Tier): void {
    if (tier === 'premium' && !process.env.FAL_KEY) {
      throw new Error(
        'premium tier requires FAL_KEY in the environment (see .env.example); aborting before any spend',
      )
    }
  }

  /**
   * The stage list for one produce run. Only the visuals slot branches by tier;
   * script/voice/captions/qc branch internally on ctx.tier. Exported so tests
   * can assert the premium wiring without spawning a subprocess.
   */
  export function stagesForTier(tier: Tier): StageDef[] {
    return [
      scriptStage,
      voiceStage,
      captionsStage,
      tier === 'premium' ? visualsPremiumStage : visualsVolumeStage,
      assembleStage,
      qcStage(),
    ]
  }
  ```

  Then make three targeted edits in `src/cli.ts` (Task 7 added scout imports/commands to this file; these edit anchors are untouched by Tasks 1–8, so match them exactly wherever they sit):

  (a) Delete the seven stage import lines (only `stagesForTier` used them) and put the pipeline import in their place:

  ```ts
  import { scriptStage } from './stages/script.js'
  import { voiceStage } from './stages/voice.js'
  import { captionsStage } from './stages/captions.js'
  import { visualsVolumeStage } from './stages/visuals-volume.js'
  import { visualsPremiumStage } from './stages/visuals-premium.js'
  import { assembleStage } from './stages/assemble.js'
  import { qcStage } from './stages/qc.js'
  ```

  becomes

  ```ts
  import { assertPremiumPreflight, stagesForTier } from './jobs/pipeline.js'
  ```

  (b) `StageDef` is no longer referenced in cli.ts; shrink the type import:

  ```ts
  import type { StageDef, Tier } from './jobs/types.js'
  ```

  becomes

  ```ts
  import type { Tier } from './jobs/types.js'
  ```

  (c) Replace the entire contiguous block containing the `assertPremiumPreflight` doc comment + function AND the `stagesForTier` doc comment + function (they are adjacent, between `parseTier` and `resolveDbPath`) with the re-export (verbatim per contract):

  ```ts
  // Moved to src/jobs/pipeline.ts so the loop code (resume, produce-next) shares
  // the exact produce wiring; re-exported so in-process importers (cli.test.ts)
  // keep their import path.
  export { stagesForTier, assertPremiumPreflight } from './jobs/pipeline.js'
  ```

  (The `import` in (a) gives the `produce` action its local bindings; the `export ... from` in (c) preserves the public surface. Both referring to the same module is valid ESM and keeps function identity.)

  Run to green:

  ```bash
  pnpm vitest run src/jobs/resume.test.ts
  ```

  Expect `Test Files  1 passed (1)`, `Tests  1 passed (1)`.

  ```bash
  pnpm vitest run src/cli.test.ts
  ```

  Expect every test to pass with zero failures (12 tests as of Task 7's close) — the file is deliberately untouched; it passing proves `parseTier`/`stagesForTier`/`assertPremiumPreflight` still resolve through `./cli.js` and behave identically.

  ```bash
  pnpm tsc --noEmit
  ```

  Expect no output, exit 0 (catches any leftover import from the move).

- [ ] **Step 3: Commit the move**

  ```bash
  git add src/jobs/pipeline.ts src/jobs/resume.test.ts src/cli.ts
  git commit -m "$(cat <<'EOF'
  refactor: move stagesForTier and assertPremiumPreflight to jobs/pipeline

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 4: Write the failing resumeJob refusal tests (red)**

  In `src/jobs/resume.test.ts`, replace the import block with:

  ```ts
  import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
  import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import type { Database } from 'better-sqlite3'
  import { openDb } from '../db/index.js'
  import { assertPremiumPreflight as cliPreflight, stagesForTier as cliStages } from '../cli.js'
  import { STAGE_ORDER } from './types.js'
  import type { Tier } from './types.js'
  import { assertPremiumPreflight, stagesForTier } from './pipeline.js'
  import { ResumeError, resumeJob } from './resume.js'
  ```

  Below the imports (above the `describe('jobs/pipeline', ...)` block), add the shared channel fixture:

  ```ts
  // Real minimal channel TOML (plan-1 shape; [scout] is optional): resumeJob
  // loads the channel from disk, so the fixture must round-trip loadChannelConfig.
  const CHANNEL_TOML = [
    'name = "resume-test"',
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
  ].join('\n')
  ```

  Append a new describe block at the end of the file:

  ```ts
  describe('resumeJob', () => {
    let db: Database
    let channelsDir: string
    let runsRoot: string

    beforeEach(() => {
      db = openDb(':memory:')
      channelsDir = mkdtempSync(join(tmpdir(), 'brainrot-channels-'))
      runsRoot = mkdtempSync(join(tmpdir(), 'brainrot-runs-'))
      writeFileSync(join(channelsDir, 'resume-test.toml'), CHANNEL_TOML)
    })

    afterEach(() => {
      db.close()
      rmSync(channelsDir, { recursive: true, force: true })
      rmSync(runsRoot, { recursive: true, force: true })
      vi.unstubAllEnvs()
    })

    // Mirrors createJob's row shape: one jobs row plus six pending stage rows.
    function seedJob(
      status: string,
      opts: { tier?: Tier; channel?: string; id?: string } = {},
    ): string {
      const id = opts.id ?? `job-${status}`
      db.prepare('INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, ?, ?, ?, ?)').run(
        id,
        opts.channel ?? 'resume-test',
        opts.tier ?? 'volume',
        'why the moon drifts',
        status,
      )
      for (const stage of STAGE_ORDER) {
        db.prepare('INSERT INTO job_stages (job_id, stage, status) VALUES (?, ?, ?)').run(
          id,
          stage,
          'pending',
        )
      }
      return id
    }

    it('refuses a missing job', async () => {
      await expect(resumeJob(db, 'no-such-job', { runsRoot, channelsDir })).rejects.toThrow(
        ResumeError,
      )
      await expect(resumeJob(db, 'no-such-job', { runsRoot, channelsDir })).rejects.toThrow(
        /no-such-job/,
      )
    })

    it('refuses done and queued jobs', async () => {
      seedJob('done')
      seedJob('queued')
      await expect(resumeJob(db, 'job-done', { runsRoot, channelsDir })).rejects.toThrow(
        ResumeError,
      )
      await expect(resumeJob(db, 'job-queued', { runsRoot, channelsDir })).rejects.toThrow(
        ResumeError,
      )
    })

    it('refuses a running job without force, naming --force in the message', async () => {
      seedJob('running')
      await expect(resumeJob(db, 'job-running', { runsRoot, channelsDir })).rejects.toThrow(
        ResumeError,
      )
      await expect(resumeJob(db, 'job-running', { runsRoot, channelsDir })).rejects.toThrow(
        /--force/,
      )
    })

    it('refuses when the channel TOML is missing from channelsDir', async () => {
      seedJob('failed', { channel: 'ghost-channel' })
      await expect(resumeJob(db, 'job-failed', { runsRoot, channelsDir })).rejects.toThrow(
        ResumeError,
      )
      await expect(resumeJob(db, 'job-failed', { runsRoot, channelsDir })).rejects.toThrow(
        /ghost-channel\.toml/,
      )
    })
  })
  ```

  Run `pnpm vitest run src/jobs/resume.test.ts` and observe the failure: the whole file errors at collection with `Error: Failed to resolve import "./resume.js" from "src/jobs/resume.test.ts". Does the file exist?` (the module does not exist yet; 0 tests run).

- [ ] **Step 5: Implement resumeJob's refusal guards and run path (green)**

  Create `src/jobs/resume.ts`. This cycle deliberately omits the premium pre-flight and the topic flip — each arrives with its own failing test below:

  ```ts
  import { existsSync } from 'node:fs'
  import { join } from 'node:path'
  import type { Database } from 'better-sqlite3'
  import { loadChannelConfig } from '../config/channel.js'
  import { stagesForTier } from './pipeline.js'
  import { runJob } from './runner.js'
  import type { JobResult } from './runner.js'
  import type { StageDef, Tier } from './types.js'

  // A refusal to resume (missing job, non-resumable status, missing channel
  // TOML) — distinct from a crash so the CLI prints just the reason and exits 1.
  export class ResumeError extends Error {}

  export async function resumeJob(
    db: Database,
    jobId: string,
    opts: {
      runsRoot: string
      channelsDir: string
      force?: boolean
      stagesFor?: (tier: Tier) => StageDef[]
    },
  ): Promise<JobResult> {
    const job = db
      .prepare('SELECT channel, tier, status FROM jobs WHERE id = ?')
      .get(jobId) as { channel: string; tier: Tier; status: string } | undefined
    if (!job) {
      throw new ResumeError(`job not found: ${jobId}`)
    }
    if (job.status === 'done') {
      throw new ResumeError(`job ${jobId} is already done; nothing to resume`)
    }
    if (job.status === 'queued') {
      throw new ResumeError(`job ${jobId} never started; queued jobs are not resumable`)
    }
    // 'running' usually means a live process holds the job; --force is the
    // operator asserting that process crashed (the digest flags such zombies).
    if (job.status === 'running' && !opts.force) {
      throw new ResumeError(`job ${jobId} is running; pass --force if no live process holds it`)
    }
    const channelPath = join(opts.channelsDir, `${job.channel}.toml`)
    if (!existsSync(channelPath)) {
      throw new ResumeError(`channel config not found: ${channelPath}`)
    }
    const channel = loadChannelConfig(channelPath)
    // The runner's skip-done-stages resume recovers the sunk cost; the stage
    // list is the exact produce wiring unless a test injects its own.
    const stages = opts.stagesFor?.(job.tier) ?? stagesForTier(job.tier)
    return runJob(db, channel, jobId, stages, { runsRoot: opts.runsRoot })
  }
  ```

  Run `pnpm vitest run src/jobs/resume.test.ts` — expect `Test Files  1 passed (1)`, `Tests  5 passed (5)`.

- [ ] **Step 6: Commit the refusal guards**

  ```bash
  git add src/jobs/resume.ts src/jobs/resume.test.ts
  git commit -m "$(cat <<'EOF'
  feat: add resumeJob with status refusal guards

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 7: Write the failing happy-path and topic-flip tests (red)**

  In `src/jobs/resume.test.ts`, extend two import lines. The `node:fs` import gains `mkdirSync` (used in a later step — harmless now) and the types import gains `JobContext`/`StageDef`:

  ```ts
  import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
  ```

  ```ts
  import type { JobContext, StageDef, Tier } from './types.js'
  ```

  Inside the `describe('resumeJob', ...)` block, add below `seedJob`:

  ```ts
    // Fake happy-path stages, mirroring runner.test.ts: assemble writes
    // final.mp4, qc writes a passing qc.json, everything else drops a marker.
    function fakeStages(calls: string[] = []): StageDef[] {
      return STAGE_ORDER.map((name) => ({
        name,
        async run(ctx: JobContext) {
          calls.push(name)
          if (name === 'assemble') {
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
  ```

  Append inside the same describe block, after the refusal tests:

  ```ts
    it('resumes a failed job via the stagesFor seam and flips its claimed topic to used', async () => {
      const jobId = seedJob('failed')
      // A claimed topic bound to this job — the row claimTopic leaves behind.
      db.prepare(
        'INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status, job_id) ' +
          "VALUES ('resume-test', 'T', 'R', 's', 'u', 'h1', 80, 'r', 'claimed', ?)",
      ).run(jobId)
      const calls: string[] = []
      const stagesFor = vi.fn((_tier: Tier) => fakeStages(calls))
      const result = await resumeJob(db, jobId, { runsRoot, channelsDir, stagesFor })
      expect(result.status).toBe('ready')
      expect(result.videoPath).toBe(join(runsRoot, jobId, 'assemble', 'final.mp4'))
      expect(calls).toEqual(['script', 'voice', 'captions', 'visuals', 'assemble', 'qc'])
      // the seam receives the job row's tier, not a caller guess
      expect(stagesFor).toHaveBeenCalledWith('volume')
      const topic = db.prepare('SELECT status FROM topics WHERE job_id = ?').get(jobId) as {
        status: string
      }
      expect(topic.status).toBe('used')
    })

    it('resumes a blocked job, skipping stages already done', async () => {
      const jobId = seedJob('blocked')
      db.prepare(
        "UPDATE job_stages SET status = 'done' WHERE job_id = ? AND stage IN ('script','voice')",
      ).run(jobId)
      const calls: string[] = []
      const result = await resumeJob(db, jobId, {
        runsRoot,
        channelsDir,
        stagesFor: () => fakeStages(calls),
      })
      expect(result.status).toBe('ready')
      // the runner's skip-done resume: sunk stages are not re-run
      expect(calls).toEqual(['captions', 'visuals', 'assemble', 'qc'])
    })

    it('running + force proceeds (no claimed topic → silent no-op on the flip)', async () => {
      const jobId = seedJob('running')
      const result = await resumeJob(db, jobId, {
        runsRoot,
        channelsDir,
        force: true,
        stagesFor: () => fakeStages(),
      })
      expect(result.status).toBe('ready')
    })

    it('leaves the claimed topic bound when the resume fails again', async () => {
      const jobId = seedJob('failed')
      db.prepare(
        'INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status, job_id) ' +
          "VALUES ('resume-test', 'T', 'R', 's', 'u', 'h2', 80, 'r', 'claimed', ?)",
      ).run(jobId)
      const failing: StageDef[] = STAGE_ORDER.map((name) => ({
        name,
        async run() {
          throw new Error('still broken')
        },
      }))
      const result = await resumeJob(db, jobId, {
        runsRoot,
        channelsDir,
        stagesFor: () => failing,
      })
      expect(result.status).toBe('failed')
      const topic = db.prepare('SELECT status FROM topics WHERE job_id = ?').get(jobId) as {
        status: string
      }
      // still bound to its job: the resume path owns recovery, never re-claiming
      expect(topic.status).toBe('claimed')
    })
  ```

  Run `pnpm vitest run src/jobs/resume.test.ts` and observe the failure: 8 passed, 1 failed — the first new test fails at `expect(topic.status).toBe('used')` with `AssertionError: expected 'claimed' to be 'used'` (nothing flips the topic yet). The blocked/force/fails-again tests pass already: they cover behavior the runner and Step 5 provide, pinned here as regression guards.

- [ ] **Step 8: Wire markTopicUsedByJob on library-landed results (green)**

  In `src/jobs/resume.ts`, add the topics import after the `loadChannelConfig` import:

  ```ts
  import { markTopicUsedByJob } from '../scout/topics.js'
  ```

  and replace the final line

  ```ts
    return runJob(db, channel, jobId, stages, { runsRoot: opts.runsRoot })
  ```

  with:

  ```ts
    const result = await runJob(db, channel, jobId, stages, { runsRoot: opts.runsRoot })
    // Library-landed (ready | needs-review) consumes the claimed topic; a
    // manual produce job has no claimed topic and this is a silent no-op.
    if (result.status === 'ready' || result.status === 'needs-review') {
      markTopicUsedByJob(db, jobId)
    }
    return result
  ```

  Run `pnpm vitest run src/jobs/resume.test.ts` — expect `Tests  9 passed (9)`.

- [ ] **Step 9: Commit the topic flip**

  ```bash
  git add src/jobs/resume.ts src/jobs/resume.test.ts
  git commit -m "$(cat <<'EOF'
  feat: flip claimed topics to used when a resume lands in the library

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 10: Write the failing premium pre-flight tests (red)**

  Append inside the `describe('resumeJob', ...)` block (env stub/restore mirrors cli.test.ts: `vi.stubEnv` + the `vi.unstubAllEnvs()` already in `afterEach`):

  ```ts
    it('premium resume without FAL_KEY refuses before any stage or status change', async () => {
      vi.stubEnv('FAL_KEY', undefined)
      const jobId = seedJob('failed', { tier: 'premium' })
      const calls: string[] = []
      await expect(
        resumeJob(db, jobId, { runsRoot, channelsDir, stagesFor: () => fakeStages(calls) }),
      ).rejects.toThrow('premium tier requires FAL_KEY')
      expect(calls).toEqual([])
      // refused before runJob: the job row was never flipped to 'running'
      const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as {
        status: string
      }
      expect(row.status).toBe('failed')
    })

    it('premium resume proceeds when FAL_KEY is set', async () => {
      vi.stubEnv('FAL_KEY', 'fal-test-key')
      const jobId = seedJob('failed', { tier: 'premium' })
      const result = await resumeJob(db, jobId, {
        runsRoot,
        channelsDir,
        stagesFor: () => fakeStages(),
      })
      expect(result.status).toBe('ready')
    })
  ```

  Run `pnpm vitest run src/jobs/resume.test.ts` and observe the failure: 10 passed, 1 failed — the first new test fails with `AssertionError: promise resolved ... instead of rejecting` (no pre-flight exists, so the fake stages run to 'ready'). The second passes already.

- [ ] **Step 11: Call assertPremiumPreflight on resume (green)**

  In `src/jobs/resume.ts`, extend the pipeline import:

  ```ts
  import { assertPremiumPreflight, stagesForTier } from './pipeline.js'
  ```

  and insert between the `existsSync` channel-TOML guard and the `loadChannelConfig` call:

  ```ts
    // Same pre-flight as produce: resuming a premium job without FAL_KEY could
    // only convert a parked job into a failed one.
    assertPremiumPreflight(job.tier)
  ```

  Run `pnpm vitest run src/jobs/resume.test.ts` — expect `Tests  11 passed (11)`.

- [ ] **Step 12: Commit the pre-flight**

  ```bash
  git add src/jobs/resume.ts src/jobs/resume.test.ts
  git commit -m "$(cat <<'EOF'
  feat: run the premium FAL_KEY pre-flight on resume

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 13: Write the failing resume CLI tests (red)**

  The Task file list keeps `src/cli.test.ts` untouched, so the subprocess tests for the new command live here. In `src/jobs/resume.test.ts`, extend the vitest import and add execa:

  ```ts
  import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
  import { execa } from 'execa'
  ```

  Append a new describe block at the end of the file:

  ```ts
  describe('brainrot resume CLI', () => {
    const cleanup: string[] = []
    function tmpDir(prefix: string): string {
      const d = mkdtempSync(join(tmpdir(), prefix))
      cleanup.push(d)
      return d
    }
    afterAll(() => {
      for (const d of cleanup) rmSync(d, { recursive: true, force: true })
    })

    it('`resume --help` prints usage with --db/--runs-root/--channels-dir/--force', async () => {
      const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'resume', '--help'], {
        reject: false,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--db')
      expect(result.stdout).toContain('--runs-root')
      expect(result.stdout).toContain('--channels-dir')
      expect(result.stdout).toContain('--force')
    }, 60000)

    it('a refusal prints the reason to stderr and exits 1 with no JSON on stdout', async () => {
      const dbPath = join(tmpDir('brainrot-resume-db-'), 'brainrot.db')
      openDb(dbPath).close() // create the schema
      const result = await execa(
        'pnpm',
        ['exec', 'tsx', 'src/cli.ts', 'resume', 'no-such-job', '--db', dbPath],
        { reject: false },
      )
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('job not found: no-such-job')
      // just the message — no raw unhandled-rejection stack frames
      expect(result.stderr).not.toMatch(/\n\s+at /)
      expect(result.stdout).toBe('')
    }, 60000)

    it('resumes a final-gate-crashed job end to end, printing the JobResult JSON line and exiting 0', async () => {
      const root = tmpDir('brainrot-resume-e2e-')
      const dbPath = join(root, 'brainrot.db')
      const runsRootDir = join(root, 'runs')
      const channelsDirPath = join(root, 'channels')
      mkdirSync(channelsDirPath, { recursive: true })
      writeFileSync(join(channelsDirPath, 'resume-test.toml'), CHANNEL_TOML)

      // A job that crashed at the final gate: every stage 'done' but status
      // 'failed'. Resume skips all stages and re-runs only the final gate —
      // the one real-stage-free path a subprocess test can drive.
      const db = openDb(dbPath)
      db.prepare(
        "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('e2e-job', 'resume-test', 'volume', 't', 'failed')",
      ).run()
      for (const stage of STAGE_ORDER) {
        db.prepare("INSERT INTO job_stages (job_id, stage, status) VALUES ('e2e-job', ?, 'done')").run(
          stage,
        )
      }
      db.close()
      const qcDir = join(runsRootDir, 'e2e-job', 'qc')
      mkdirSync(qcDir, { recursive: true })
      writeFileSync(join(qcDir, 'qc.json'), JSON.stringify({ passed: true, checks: [] }))
      const assembleDir = join(runsRootDir, 'e2e-job', 'assemble')
      mkdirSync(assembleDir, { recursive: true })
      writeFileSync(join(assembleDir, 'final.mp4'), 'FAKEMP4')

      const result = await execa(
        'pnpm',
        ['exec', 'tsx', 'src/cli.ts', 'resume', 'e2e-job',
          '--db', dbPath, '--runs-root', runsRootDir, '--channels-dir', channelsDirPath],
        { reject: false },
      )
      expect(result.exitCode).toBe(0)
      const line = JSON.parse(result.stdout) as { jobId: string; status: string; videoPath?: string }
      expect(line.jobId).toBe('e2e-job')
      expect(line.status).toBe('ready')
      expect(line.videoPath).toBe(join(runsRootDir, 'e2e-job', 'assemble', 'final.mp4'))
    }, 60000)
  })
  ```

  Run `pnpm vitest run src/jobs/resume.test.ts` and observe the failure: 11 passed, 3 failed — commander prints `error: unknown command 'resume'` on stderr and exits 1 in the subprocess, so the `--help` test fails `expect(result.exitCode).toBe(0)`, the refusal test fails `expect(result.stderr).toContain('job not found: no-such-job')`, and the e2e test fails `expect(result.exitCode).toBe(0)`.

- [ ] **Step 14: Wire the `resume` CLI command (green)**

  In `src/cli.ts`, add the resume import next to the runner import:

  ```ts
  import { resumeJob } from './jobs/resume.js'
  ```

  Add the command after the `scout` command block (Task 7 placed `scout` after `produce`):

  ```ts
  program
    .command('resume')
    .argument('<jobId>', 'job id to resume (failed or blocked; running needs --force)')
    .option('--db <path>', 'sqlite db path')
    .option('--runs-root <path>', 'runs root directory', 'runs')
    .option('--channels-dir <dir>', 'channel TOML directory', 'channels')
    .option('--force', 'resume a job stuck in running (asserts no live process holds it)')
    .action(
      async (
        jobId: string,
        opts: { db?: string; runsRoot: string; channelsDir: string; force?: boolean },
      ) => {
        const db = openDb(resolveDbPath(opts.db))
        try {
          const result = await resumeJob(db, jobId, {
            runsRoot: opts.runsRoot,
            channelsDir: opts.channelsDir,
            force: opts.force,
          })
          process.stdout.write(JSON.stringify(result) + '\n')
          // Mirror produce: 0 for ready/needs-review, 1 for failed AND blocked.
          // A ResumeError skips the write and reaches the parseAsync catch (exit 1).
          process.exitCode = result.status === 'failed' || result.status === 'blocked' ? 1 : 0
        } finally {
          db.close()
        }
      },
    )
  ```

  Run to green:

  ```bash
  pnpm vitest run src/jobs/resume.test.ts
  ```

  Expect `Test Files  1 passed (1)`, `Tests  14 passed (14)` (the subprocess tests take a few seconds each).

  ```bash
  pnpm vitest run src/cli.test.ts
  ```

  Expect every test to pass, zero failures — still untouched.

- [ ] **Step 15: Whole-suite and type gates**

  ```bash
  pnpm vitest run
  ```

  Expect every test file to pass, zero failures (contract tests stay excluded — `CONTRACT` unset).

  ```bash
  pnpm tsc --noEmit
  ```

  Expect no output, exit 0.

- [ ] **Step 16: Final commit**

  ```bash
  git add src/cli.ts src/jobs/resume.test.ts
  git commit -m "$(cat <<'EOF'
  feat: add brainrot resume CLI command

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```


### Task 10: Tick planner

**Files:**
- Create: `src/loop/plan-tick.ts`, `src/loop/plan-tick.test.ts`
- Modify: (none)
- Test: `src/loop/plan-tick.test.ts`

All paths are relative to the repo root `/Users/alex/code/project-brainrot`; run every command from the repo root. The `src/loop/` directory already exists (Task 8 created it for `lease.ts`).

`planTick` is a PURE decision function: it performs only SELECTs (plus the exported day-spend readers from Task 5). It never writes — `produce-next` (Task 11) executes the returned plan and owns every write. Two passes: a RESUME pass over `blocked` jobs (oldest first, skipping ineligible ones), then a CLAIM pass that picks the fairest channel with an open tier slot and an eligible topic, premium-first. Nothing eligible → noop.

**Interfaces:**

Consumes (exact signatures from lower-numbered tasks and existing code):

```ts
// src/scout/topics.ts (Task 1)
export interface TopicRow {
  id: number; channel: string; title: string; rawTitle: string; source: string;
  url: string; dedupeHash: string; score: number; reason: string;
  status: TopicStatus; jobId: string | null; createdAt: string
}
export function eligibleTopic(db: Database, channel: string, tier: Tier, opts: { autoPremium: boolean }): TopicRow | null
// volume: status IN ('candidate','approved'); premium: 'approved' only, or
// IN ('candidate','approved') when opts.autoPremium.
// ORDER BY score DESC, created_at ASC, id ASC LIMIT 1

// src/config/channel.ts (Task 2)
export interface ScoutConfig { subreddits: string[]; rss: string[]; minScore: number; perSourceLimit: number; autoPremium: boolean }
export const DEFAULT_SCOUT: ScoutConfig  // { subreddits: [], rss: [], minScore: 60, perSourceLimit: 25, autoPremium: false }
// ChannelConfig (relevant members): name: string; tierMix: { volume: number; premium: number };
//   budget: { perVideoUsdMicros: number; premiumPerVideoUsdMicros: number; perDayUsdMicros: number };
//   scout: ScoutConfig

// src/jobs/costs.ts (Task 5 exports + existing)
export function channelDaySpentMicros(db: Database, channel: string): number  // today UTC, JOIN through jobs
export function globalDaySpentMicros(db: Database): number                    // today UTC, ALL costs rows, no JOIN
export function globalDailyCapMicros(): number                                // BRAINROT_GLOBAL_DAILY_USD, default $25
export function recordCost(db: Database, jobId: string, provider: string, operation: string, usdMicros: number): void

// src/jobs/types.ts (existing)
export type Tier = 'volume' | 'premium'

// src/db/index.ts (existing)
export function openDb(dbPath: string): Database

// src/stages/_testkit.ts (existing; Task 2 added scout: { ...DEFAULT_SCOUT })
export function testChannel(overrides?: Partial<ChannelConfig>): ChannelConfig
// defaults: name 'test', tierMix { volume: 2, premium: 1 },
// budget { perVideoUsdMicros: 8_000_000, premiumPerVideoUsdMicros: 7_000_000, perDayUsdMicros: 20_000_000 }
```

Produces (binding — Task 11 imports all three from `src/loop/plan-tick.js`):

```ts
export const RESUME_MIN_HEADROOM_USD_MICROS = 2_000_000
export type TickPlan =
  | { kind: 'resume'; jobId: string; channel: string; tier: Tier }
  | { kind: 'produce'; channel: string; topicId: number; topic: string; tier: Tier }
  | { kind: 'noop'; reason: 'no-eligible-work' | 'no-fal-key' }
export function planTick(db: Database, channels: ChannelConfig[], opts: { falKeyPresent: boolean }): TickPlan
// 'no-fal-key' is returned instead of 'no-eligible-work' when the tick found premium
// work but skipped it for falKeyPresent=false (a blocked premium job skipped at the
// key check, or an open premium slot with an eligible approved/auto_premium topic)
// and nothing else was runnable — so an operator with an unset FAL_KEY can tell a
// starved queue from a key problem (spec §8's distinct no-op reasons).
```

House rules in force: ESM `.js` suffixes on relative imports; no semicolons in `src/loop/` (matching `src/jobs/`); real SQLite via `openDb(':memory:')`; money is integer micro-USD; UTC "today" is `substr(created_at, 1, 10) = strftime('%Y-%m-%d','now')` — identical to the budget code; conventional commits with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer. House gotcha: with vitest/esbuild a missing named export resolves to `undefined` and fails at runtime with a TypeError; a missing FILE fails with a resolve error at import time.

---

- [ ] **Step 1: Write the failing skeleton test (file creation, seed helpers, noop)**

  Create `src/loop/plan-tick.test.ts`. The seed helpers do raw inserts so tests control every column: `seedJob` defaults `created_at` to now (UTC today) because the claim-pass quota only counts today's rows; ordering-sensitive tests pass explicit `createdAt` values (the schema default has millisecond resolution — same-tick inserts would collide).

  ```ts
  import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
  import type { Database } from 'better-sqlite3'
  import { openDb } from '../db/index.js'
  import { testChannel } from '../stages/_testkit.js'
  import { planTick, RESUME_MIN_HEADROOM_USD_MICROS } from './plan-tick.js'

  const NOOP = { kind: 'noop', reason: 'no-eligible-work' } as const

  // planTick only SELECTs, so raw-insert seeds control every column directly.
  // seedJob defaults created_at to now (UTC today) — the claim-pass quota only
  // counts today's rows; explicit createdAt pins ordering where it matters.
  let jobSeq = 0
  function seedJob(
    db: Database,
    overrides: Partial<{
      id: string
      channel: string
      tier: string
      status: string
      createdAt: string
    }> = {},
  ): string {
    jobSeq += 1
    const row = {
      id: `job-${jobSeq}`,
      channel: 'test',
      tier: 'volume',
      status: 'done',
      createdAt: new Date().toISOString(),
      ...overrides,
    }
    db.prepare(
      'INSERT INTO jobs (id, channel, tier, topic, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(row.id, row.channel, row.tier, `topic for ${row.id}`, row.status, row.createdAt)
    return row.id
  }

  let topicSeq = 0
  function seedTopic(
    db: Database,
    overrides: Partial<{
      channel: string
      title: string
      score: number
      status: string
      jobId: string | null
      createdAt: string
    }> = {},
  ): number {
    topicSeq += 1
    const row = {
      channel: 'test',
      title: `Topic ${topicSeq}`,
      score: 80,
      status: 'candidate',
      jobId: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      ...overrides,
    }
    const res = db
      .prepare(
        'INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status, job_id, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.channel,
        row.title,
        `raw ${topicSeq}`,
        'reddit:r/space',
        `https://example.com/${topicSeq}`,
        `hash-${topicSeq}`,
        row.score,
        'seeded',
        row.status,
        row.jobId,
        row.createdAt,
      )
    return Number(res.lastInsertRowid)
  }

  // The global cap reads BRAINROT_GLOBAL_DAILY_USD at call time: pin the $25
  // default even when the shell exports the var.
  beforeEach(() => {
    vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', undefined)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('planTick basics', () => {
    it('exports the resume headroom constant in micro-USD', () => {
      expect(RESUME_MIN_HEADROOM_USD_MICROS).toBe(2_000_000)
    })

    it('noops when there are no blocked jobs and no topics', () => {
      const db = openDb(':memory:')
      expect(planTick(db, [testChannel()], { falKeyPresent: true })).toEqual(NOOP)
      db.close()
    })
  })
  ```

- [ ] **Step 2: Run, observe the failure**

  ```bash
  pnpm vitest run src/loop/plan-tick.test.ts
  ```

  Expected failure: `Error: Failed to resolve import "./plan-tick.js" from "src/loop/plan-tick.test.ts". Does the file exist?` — the module does not exist yet. (From the next cycle onward the file exists, so incomplete behavior surfaces as AssertionErrors, not import errors.)

- [ ] **Step 3: Create src/loop/plan-tick.ts — constant, TickPlan, noop skeleton**

  ```ts
  import type { Database } from 'better-sqlite3'
  import type { ChannelConfig } from '../config/channel.js'
  import type { Tier } from '../jobs/types.js'

  // Resuming under this headroom would only re-park the job 'blocked' at the
  // next budget checkpoint — the tick is better spent on new work (spec §6).
  export const RESUME_MIN_HEADROOM_USD_MICROS = 2_000_000

  export type TickPlan =
    | { kind: 'resume'; jobId: string; channel: string; tier: Tier }
    | { kind: 'produce'; channel: string; topicId: number; topic: string; tier: Tier }
    | { kind: 'noop'; reason: 'no-eligible-work' }

  // Pure decision function: SELECTs only. produce-next executes the plan and
  // owns every write, so a crashed tick never leaves half a decision behind.
  export function planTick(
    db: Database,
    channels: ChannelConfig[],
    opts: { falKeyPresent: boolean },
  ): TickPlan {
    return { kind: 'noop', reason: 'no-eligible-work' }
  }
  ```

- [ ] **Step 4: Run to green, commit**

  ```bash
  pnpm vitest run src/loop/plan-tick.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  2 passed (2)`. Then:

  ```bash
  git add src/loop/plan-tick.ts src/loop/plan-tick.test.ts
  git commit -m "feat(loop): add planTick noop skeleton and resume headroom constant" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 5: Write the failing resume-pass tests**

  Append to `src/loop/plan-tick.test.ts`:

  ```ts
  describe('resume pass', () => {
    it('beats the claim pass when a blocked job is eligible', () => {
      const db = openDb(':memory:')
      seedJob(db, { id: 'job-parked', status: 'blocked' })
      seedTopic(db) // a claimable topic must not outrank the parked job
      expect(planTick(db, [testChannel()], { falKeyPresent: true })).toEqual({
        kind: 'resume',
        jobId: 'job-parked',
        channel: 'test',
        tier: 'volume',
      })
      db.close()
    })

    it('takes the oldest blocked job first', () => {
      const db = openDb(':memory:')
      seedJob(db, { id: 'job-newer', status: 'blocked', createdAt: '2026-07-02T00:00:00.000Z' })
      seedJob(db, { id: 'job-older', status: 'blocked', createdAt: '2026-07-01T00:00:00.000Z' })
      expect(planTick(db, [testChannel()], { falKeyPresent: true })).toMatchObject({
        kind: 'resume',
        jobId: 'job-older',
      })
      db.close()
    })

    it('skips a blocked job whose channel is missing and takes the next oldest', () => {
      const db = openDb(':memory:')
      // Oldest blocked job belongs to a channel whose TOML left the dir.
      seedJob(db, {
        id: 'job-ghost',
        channel: 'ghost',
        status: 'blocked',
        createdAt: '2026-07-01T00:00:00.000Z',
      })
      seedJob(db, { id: 'job-live', status: 'blocked', createdAt: '2026-07-02T00:00:00.000Z' })
      expect(planTick(db, [testChannel()], { falKeyPresent: true })).toMatchObject({
        kind: 'resume',
        jobId: 'job-live',
      })
      db.close()
    })

    it('carries the premium tier through the plan', () => {
      const db = openDb(':memory:')
      seedJob(db, { id: 'job-prem', tier: 'premium', status: 'blocked' })
      expect(planTick(db, [testChannel()], { falKeyPresent: true })).toEqual({
        kind: 'resume',
        jobId: 'job-prem',
        channel: 'test',
        tier: 'premium',
      })
      db.close()
    })
  })
  ```

- [ ] **Step 6: Run, observe the failure**

  ```bash
  pnpm vitest run src/loop/plan-tick.test.ts
  ```

  Expected: 2 pass, 4 fail — each with an AssertionError like `expected { kind: 'noop', reason: 'no-eligible-work' } to deeply equal { kind: 'resume', jobId: 'job-parked', ... }` (the skeleton always noops).

- [ ] **Step 7: Implement the resume pass (channel-presence check only)**

  Replace the whole `planTick` function in `src/loop/plan-tick.ts` with:

  ```ts
  // Pure decision function: SELECTs only. produce-next executes the plan and
  // owns every write, so a crashed tick never leaves half a decision behind.
  export function planTick(
    db: Database,
    channels: ChannelConfig[],
    opts: { falKeyPresent: boolean },
  ): TickPlan {
    const byName = new Map(channels.map((c) => [c.name, c]))

    // RESUME PASS: blocked jobs were healthy when parked — recovering their
    // sunk cost beats spending on new work. Oldest first; an ineligible job is
    // skipped, not terminal (a later one may belong to a channel with headroom).
    const blocked = db
      .prepare(
        "SELECT id, channel, tier FROM jobs WHERE status = 'blocked' ORDER BY created_at ASC, id ASC",
      )
      .all() as { id: string; channel: string; tier: Tier }[]
    for (const job of blocked) {
      const channel = byName.get(job.channel)
      if (channel === undefined) continue // channel TOML no longer in the dir
      return { kind: 'resume', jobId: job.id, channel: job.channel, tier: job.tier }
    }

    return { kind: 'noop', reason: 'no-eligible-work' }
  }
  ```

- [ ] **Step 8: Run to green, commit**

  ```bash
  pnpm vitest run src/loop/plan-tick.test.ts
  ```

  Expected: `Tests  6 passed (6)`. Then:

  ```bash
  git add src/loop/plan-tick.ts src/loop/plan-tick.test.ts
  git commit -m "feat(loop): resume pass picks the oldest blocked job from known channels" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 9: Write the failing resume skip-condition table**

  In `src/loop/plan-tick.test.ts`, add the `recordCost` import between the `openDb` and `testChannel` imports:

  ```ts
  import { recordCost } from '../jobs/costs.js'
  ```

  Append the table-driven describe (each row seeds costs/jobs to construct one skip condition; `testChannel` gives a $20 channel-day cap, the env stub pins the $25 global cap):

  ```ts
  describe('resume pass skip conditions', () => {
    const cases: { reason: string; falKeyPresent: boolean; seed: (db: Database) => void }[] = [
      {
        reason: 'the job is premium and the FAL key is absent',
        falKeyPresent: false,
        seed: (db) => {
          seedJob(db, { id: 'job-parked', tier: 'premium', status: 'blocked' })
        },
      },
      {
        reason: 'channel-day headroom is under the resume minimum',
        falKeyPresent: true,
        seed: (db) => {
          seedJob(db, { id: 'job-parked', status: 'blocked' })
          // $20 channel-day cap − $18.50 spent today = $1.50 < $2 headroom
          const spender = seedJob(db)
          recordCost(db, spender, 'fal', 'video', 18_500_000)
        },
      },
      {
        reason: 'global-day headroom is under the resume minimum',
        falKeyPresent: true,
        seed: (db) => {
          seedJob(db, { id: 'job-parked', status: 'blocked' })
          // Jobless sentinel spend: invisible to the channel-day JOIN, counted
          // by the global sum. $25 default cap − $23.50 = $1.50 < $2 headroom.
          recordCost(db, 'scout:test', 'anthropic', 'scout-score', 23_500_000)
        },
      },
    ]

    it.each(cases)('skips the blocked job when $reason', ({ falKeyPresent, seed }) => {
      const db = openDb(':memory:')
      seed(db)
      expect(planTick(db, [testChannel()], { falKeyPresent })).toEqual(NOOP)
      db.close()
    })
  })
  ```

  (The fourth skip condition from the plan — channel missing from the loaded list — is already covered by the fall-through test in Step 5.)

- [ ] **Step 10: Run, observe the failure**

  ```bash
  pnpm vitest run src/loop/plan-tick.test.ts
  ```

  Expected: 6 pass, all 3 table rows fail with `expected { kind: 'resume', jobId: 'job-parked', ... } to deeply equal { kind: 'noop', reason: 'no-eligible-work' }` — the resume pass has no FAL-key or headroom conditions yet.

- [ ] **Step 11: Implement the FAL-key and headroom skip conditions**

  In `src/loop/plan-tick.ts`, add the costs-helpers import after the `ChannelConfig` import:

  ```ts
  import {
    channelDaySpentMicros,
    globalDailyCapMicros,
    globalDaySpentMicros,
  } from '../jobs/costs.js'
  ```

  Then replace the resume loop (from `for (const job of blocked) {` through its closing `}`) with — the global remainder is loop-invariant, so it is computed once:

  ```ts
    const globalRemainingMicros = globalDailyCapMicros() - globalDaySpentMicros(db)
    for (const job of blocked) {
      const channel = byName.get(job.channel)
      if (channel === undefined) continue // channel TOML no longer in the dir
      // Resuming premium without the key would only convert a healthy parked
      // job into a failed one.
      if (job.tier === 'premium' && !opts.falKeyPresent) continue
      const channelRemainingMicros =
        channel.budget.perDayUsdMicros - channelDaySpentMicros(db, job.channel)
      if (channelRemainingMicros < RESUME_MIN_HEADROOM_USD_MICROS) continue
      if (globalRemainingMicros < RESUME_MIN_HEADROOM_USD_MICROS) continue
      return { kind: 'resume', jobId: job.id, channel: job.channel, tier: job.tier }
    }
  ```

- [ ] **Step 12: Run to green, commit**

  ```bash
  pnpm vitest run src/loop/plan-tick.test.ts
  ```

  Expected: `Tests  9 passed (9)`. Then:

  ```bash
  git add src/loop/plan-tick.ts src/loop/plan-tick.test.ts
  git commit -m "feat(loop): gate resume on FAL key and day-budget headroom" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 13: Write the failing basic claim test**

  Append to `src/loop/plan-tick.test.ts`:

  ```ts
  describe('claim pass', () => {
    it('claims the best eligible volume topic', () => {
      const db = openDb(':memory:')
      const best = seedTopic(db, { title: 'Why the Moon is drifting away', score: 90 })
      seedTopic(db, { title: 'runner-up', score: 70 })
      expect(planTick(db, [testChannel()], { falKeyPresent: true })).toEqual({
        kind: 'produce',
        channel: 'test',
        topicId: best,
        topic: 'Why the Moon is drifting away',
        tier: 'volume',
      })
      db.close()
    })
  })
  ```

- [ ] **Step 14: Run, observe the failure**

  ```bash
  pnpm vitest run src/loop/plan-tick.test.ts
  ```

  Expected: 9 pass, 1 fail — `expected { kind: 'noop', reason: 'no-eligible-work' } to deeply equal { kind: 'produce', channel: 'test', ... }` (no claim pass exists yet).

- [ ] **Step 15: Implement the minimal claim pass (volume, no quota yet)**

  In `src/loop/plan-tick.ts`, add the topics-DAO import after the `Tier` import:

  ```ts
  import { eligibleTopic } from '../scout/topics.js'
  ```

  Then insert the claim loop between the resume loop's closing `}` and the final `return { kind: 'noop', ... }`:

  ```ts
    // CLAIM PASS: new work from the topic queue.
    for (const channel of channels) {
      const topic = eligibleTopic(db, channel.name, 'volume', {
        autoPremium: channel.scout.autoPremium,
      })
      if (topic !== null) {
        return {
          kind: 'produce',
          channel: channel.name,
          topicId: topic.id,
          topic: topic.title,
          tier: 'volume',
        }
      }
    }
  ```

- [ ] **Step 16: Run to green, commit**

  ```bash
  pnpm vitest run src/loop/plan-tick.test.ts
  ```

  Expected: `Tests  10 passed (10)`. Then:

  ```bash
  git add src/loop/plan-tick.ts src/loop/plan-tick.test.ts
  git commit -m "feat(loop): claim pass produces the best eligible volume topic" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 17: Write the failing quota tests**

  Append to `src/loop/plan-tick.test.ts`. The `blocked` status gets its own test because a blocked job also triggers the resume pass — the sentinel spend empties GLOBAL headroom so resume skips it, isolating the quota question:

  ```ts
  describe('claim pass quota', () => {
    it.each(['queued', 'running', 'failed', 'done'])(
      'a %s job created today consumes its tier slot',
      (status) => {
        const db = openDb(':memory:')
        seedJob(db, { status })
        seedTopic(db)
        const ch = testChannel({ tierMix: { volume: 1, premium: 0 } })
        expect(planTick(db, [ch], { falKeyPresent: true })).toEqual(NOOP)
        db.close()
      },
    )

    it('counts blocked jobs toward the claim quota too', () => {
      const db = openDb(':memory:')
      // Sentinel spend empties GLOBAL headroom so the resume pass skips the
      // blocked job; the claim pass must then see its slot as taken.
      seedJob(db, { status: 'blocked' })
      recordCost(db, 'scout:test', 'anthropic', 'scout-score', 23_500_000)
      seedTopic(db)
      const ch = testChannel({ tierMix: { volume: 1, premium: 0 } })
      expect(planTick(db, [ch], { falKeyPresent: true })).toEqual(NOOP)
      db.close()
    })

    it('ignores jobs from previous UTC days', () => {
      const db = openDb(':memory:')
      seedJob(db, { status: 'failed', createdAt: '2020-01-01T00:00:00.000Z' })
      const topicId = seedTopic(db)
      const ch = testChannel({ tierMix: { volume: 1, premium: 0 } })
      expect(planTick(db, [ch], { falKeyPresent: true })).toMatchObject({
        kind: 'produce',
        topicId,
      })
      db.close()
    })
  })
  ```

- [ ] **Step 18: Run, observe the failure**

  ```bash
  pnpm vitest run src/loop/plan-tick.test.ts
  ```

  Expected: 5 of the 6 new tests fail — the four status rows and the blocked-counts test each with `expected { kind: 'produce', ... } to deeply equal { kind: 'noop', reason: 'no-eligible-work' }` (the claim pass has no quota check yet). The ignores-previous-UTC-days test passes already; once the quota lands it pins the day boundary.

- [ ] **Step 19: Implement quota counting (all statuses, today UTC)**

  In `src/loop/plan-tick.ts`, replace the claim loop (from `// CLAIM PASS: new work from the topic queue.` through the loop's closing `}`) with:

  ```ts
    // CLAIM PASS: a tier slot is consumed at job creation regardless of
    // outcome — a deterministic failure must not burn the whole day's budget
    // on retries.
    const quotaStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM jobs WHERE channel = ? AND tier = ? ' +
        "AND substr(created_at, 1, 10) = strftime('%Y-%m-%d','now')",
    )
    const jobsToday = (name: string, tier: Tier): number =>
      (quotaStmt.get(name, tier) as { n: number }).n
    for (const channel of channels) {
      if (jobsToday(channel.name, 'volume') >= channel.tierMix.volume) continue
      const topic = eligibleTopic(db, channel.name, 'volume', {
        autoPremium: channel.scout.autoPremium,
      })
      if (topic !== null) {
        return {
          kind: 'produce',
          channel: channel.name,
          topicId: topic.id,
          topic: topic.title,
          tier: 'volume',
        }
      }
    }
  ```

- [ ] **Step 20: Run to green, commit**

  ```bash
  pnpm vitest run src/loop/plan-tick.test.ts
  ```

  Expected: `Tests  16 passed (16)`. Then:

  ```bash
  git add src/loop/plan-tick.ts src/loop/plan-tick.test.ts
  git commit -m "feat(loop): count today's jobs across all statuses toward tier quotas" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 21: Write the failing tier-selection tests**

  In `src/loop/plan-tick.test.ts`, add the config import above the `openDb` import:

  ```ts
  import { DEFAULT_SCOUT } from '../config/channel.js'
  ```

  Append:

  ```ts
  describe('claim pass tier selection', () => {
    it('fills the premium slot first when an approved topic exists', () => {
      const db = openDb(':memory:')
      const approved = seedTopic(db, { title: 'approved pick', score: 60, status: 'approved' })
      seedTopic(db, { title: 'hot candidate', score: 95 })
      expect(planTick(db, [testChannel()], { falKeyPresent: true })).toEqual({
        kind: 'produce',
        channel: 'test',
        topicId: approved,
        topic: 'approved pick',
        tier: 'premium',
      })
      db.close()
    })

    it('falls back to volume when no topic is premium-eligible', () => {
      const db = openDb(':memory:')
      const candidate = seedTopic(db, { title: 'hot candidate', score: 95 })
      expect(planTick(db, [testChannel()], { falKeyPresent: true })).toEqual({
        kind: 'produce',
        channel: 'test',
        topicId: candidate,
        topic: 'hot candidate',
        tier: 'volume',
      })
      db.close()
    })

    it('auto_premium lifts the approval gate', () => {
      const db = openDb(':memory:')
      const candidate = seedTopic(db, { title: 'hot candidate', score: 95 })
      const ch = testChannel({ scout: { ...DEFAULT_SCOUT, autoPremium: true } })
      expect(planTick(db, [ch], { falKeyPresent: true })).toEqual({
        kind: 'produce',
        channel: 'test',
        topicId: candidate,
        topic: 'hot candidate',
        tier: 'premium',
      })
      db.close()
    })

    it('skips premium claims entirely without the FAL key', () => {
      const db = openDb(':memory:')
      const approved = seedTopic(db, { title: 'approved pick', score: 60, status: 'approved' })
      expect(planTick(db, [testChannel()], { falKeyPresent: false })).toEqual({
        kind: 'produce',
        channel: 'test',
        topicId: approved,
        topic: 'approved pick',
        tier: 'volume',
      })
      db.close()
    })

    it('does not claim premium once its slot is filled today', () => {
      const db = openDb(':memory:')
      seedJob(db, { tier: 'premium', status: 'failed' })
      const approved = seedTopic(db, { title: 'approved pick', score: 60, status: 'approved' })
      expect(planTick(db, [testChannel()], { falKeyPresent: true })).toEqual({
        kind: 'produce',
        channel: 'test',
        topicId: approved,
        topic: 'approved pick',
        tier: 'volume',
      })
      db.close()
    })
  })
  ```

- [ ] **Step 22: Run, observe the failure**

  ```bash
  pnpm vitest run src/loop/plan-tick.test.ts
  ```

  Expected: 2 of the 5 new tests fail against the volume-only claim pass — fills-premium-first gets `{ ..., topic: 'hot candidate', tier: 'volume' }` instead of the approved premium pick, and auto_premium gets `tier: 'volume'` instead of `'premium'`. The other three pass already (a volume-only pass trivially never claims premium); they pin the key/slot gate boundaries once the premium branch lands.

- [ ] **Step 23: Implement premium-first tier selection**

  In `src/loop/plan-tick.ts`, replace the claim `for` loop (from `for (const channel of channels) {` through its closing `}` — keep `quotaStmt` and `jobsToday` above it) with:

  ```ts
    for (const channel of channels) {
      const autoPremium = channel.scout.autoPremium
      // Premium first: scarce quality slots get the day's best material early.
      // Without the FAL key premium is skipped outright — volume still flows.
      if (jobsToday(channel.name, 'premium') < channel.tierMix.premium && opts.falKeyPresent) {
        const topic = eligibleTopic(db, channel.name, 'premium', { autoPremium })
        if (topic !== null) {
          return {
            kind: 'produce',
            channel: channel.name,
            topicId: topic.id,
            topic: topic.title,
            tier: 'premium',
          }
        }
      }
      if (jobsToday(channel.name, 'volume') < channel.tierMix.volume) {
        const topic = eligibleTopic(db, channel.name, 'volume', { autoPremium })
        if (topic !== null) {
          return {
            kind: 'produce',
            channel: channel.name,
            topicId: topic.id,
            topic: topic.title,
            tier: 'volume',
          }
        }
      }
    }
  ```

- [ ] **Step 24: Run to green, commit**

  ```bash
  pnpm vitest run src/loop/plan-tick.test.ts
  ```

  Expected: `Tests  21 passed (21)`. Then:

  ```bash
  git add src/loop/plan-tick.ts src/loop/plan-tick.test.ts
  git commit -m "feat(loop): premium-first tier selection behind approval and key gates" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 25: Write the failing channel-fairness tests**

  Append to `src/loop/plan-tick.test.ts`:

  ```ts
  describe('claim pass channel fairness', () => {
    it('prefers the channel with the lowest filled fraction of its mix', () => {
      const db = openDb(':memory:')
      seedJob(db, { channel: 'chan-a' }) // 1 of 2 slots → 0.5
      seedJob(db, { channel: 'chan-b' }) // 1 of 4 slots → 0.25
      seedTopic(db, { channel: 'chan-a', title: 'a topic' })
      const bTopic = seedTopic(db, { channel: 'chan-b', title: 'b topic' })
      const chA = testChannel({ name: 'chan-a', tierMix: { volume: 2, premium: 0 } })
      const chB = testChannel({ name: 'chan-b', tierMix: { volume: 4, premium: 0 } })
      expect(planTick(db, [chA, chB], { falKeyPresent: true })).toMatchObject({
        kind: 'produce',
        channel: 'chan-b',
        topicId: bTopic,
      })
      db.close()
    })

    it('breaks filled-fraction ties by channel name ascending', () => {
      const db = openDb(':memory:')
      seedTopic(db, { channel: 'chan-a', title: 'a topic' })
      seedTopic(db, { channel: 'chan-b', title: 'b topic' })
      const chA = testChannel({ name: 'chan-a', tierMix: { volume: 2, premium: 0 } })
      const chB = testChannel({ name: 'chan-b', tierMix: { volume: 2, premium: 0 } })
      // Reversed input order: the sort, not the argument order, must decide.
      expect(planTick(db, [chB, chA], { falKeyPresent: true })).toMatchObject({
        kind: 'produce',
        channel: 'chan-a',
      })
      db.close()
    })

    it('falls through to the next channel when the fairest one has no topics', () => {
      const db = openDb(':memory:')
      const bTopic = seedTopic(db, { channel: 'chan-b', title: 'b topic' })
      const chA = testChannel({ name: 'chan-a', tierMix: { volume: 2, premium: 0 } })
      const chB = testChannel({ name: 'chan-b', tierMix: { volume: 2, premium: 0 } })
      expect(planTick(db, [chA, chB], { falKeyPresent: true })).toMatchObject({
        kind: 'produce',
        channel: 'chan-b',
        topicId: bTopic,
      })
      db.close()
    })
  })
  ```

- [ ] **Step 26: Run, observe the failure**

  ```bash
  pnpm vitest run src/loop/plan-tick.test.ts
  ```

  Expected: 2 of the 3 new tests fail against the input-order loop — lowest-filled-fraction gets `channel: 'chan-a'` instead of `'chan-b'`, and the name tiebreak gets `channel: 'chan-b'` instead of `'chan-a'`. The fall-through test passes already and pins that behavior across the restructure.

- [ ] **Step 27: Implement the fairness sort — final planTick**

  Replace the whole `planTick` function in `src/loop/plan-tick.ts` with the final version (the comment above it stays):

  ```ts
  export function planTick(
    db: Database,
    channels: ChannelConfig[],
    opts: { falKeyPresent: boolean },
  ): TickPlan {
    const byName = new Map(channels.map((c) => [c.name, c]))

    // RESUME PASS: blocked jobs were healthy when parked — recovering their
    // sunk cost beats spending on new work. Oldest first; an ineligible job is
    // skipped, not terminal (a later one may belong to a channel with headroom).
    const blocked = db
      .prepare(
        "SELECT id, channel, tier FROM jobs WHERE status = 'blocked' ORDER BY created_at ASC, id ASC",
      )
      .all() as { id: string; channel: string; tier: Tier }[]
    const globalRemainingMicros = globalDailyCapMicros() - globalDaySpentMicros(db)
    for (const job of blocked) {
      const channel = byName.get(job.channel)
      if (channel === undefined) continue // channel TOML no longer in the dir
      // Resuming premium without the key would only convert a healthy parked
      // job into a failed one.
      if (job.tier === 'premium' && !opts.falKeyPresent) continue
      const channelRemainingMicros =
        channel.budget.perDayUsdMicros - channelDaySpentMicros(db, job.channel)
      if (channelRemainingMicros < RESUME_MIN_HEADROOM_USD_MICROS) continue
      if (globalRemainingMicros < RESUME_MIN_HEADROOM_USD_MICROS) continue
      return { kind: 'resume', jobId: job.id, channel: job.channel, tier: job.tier }
    }

    // CLAIM PASS: a tier slot is consumed at job creation regardless of
    // outcome — a deterministic failure must not burn the whole day's budget
    // on retries.
    const quotaStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM jobs WHERE channel = ? AND tier = ? ' +
        "AND substr(created_at, 1, 10) = strftime('%Y-%m-%d','now')",
    )
    const jobsToday = (name: string, tier: Tier): number =>
      (quotaStmt.get(name, tier) as { n: number }).n
    const candidates = channels
      .map((channel) => {
        const volumeToday = jobsToday(channel.name, 'volume')
        const premiumToday = jobsToday(channel.name, 'premium')
        return {
          channel,
          volumeOpen: volumeToday < channel.tierMix.volume,
          premiumOpen: premiumToday < channel.tierMix.premium,
          filledFraction:
            (volumeToday + premiumToday) / (channel.tierMix.volume + channel.tierMix.premium),
        }
      })
      // A zero tier mix closes both slots, so its NaN fraction never reaches
      // the sort.
      .filter((c) => c.volumeOpen || c.premiumOpen)
      .sort(
        (a, b) =>
          a.filledFraction - b.filledFraction || (a.channel.name < b.channel.name ? -1 : 1),
      )

    for (const { channel, volumeOpen, premiumOpen } of candidates) {
      const autoPremium = channel.scout.autoPremium
      // Premium first: scarce quality slots get the day's best material early.
      // Without the FAL key premium is skipped outright — volume still flows.
      if (premiumOpen && opts.falKeyPresent) {
        const topic = eligibleTopic(db, channel.name, 'premium', { autoPremium })
        if (topic !== null) {
          return {
            kind: 'produce',
            channel: channel.name,
            topicId: topic.id,
            topic: topic.title,
            tier: 'premium',
          }
        }
      }
      if (volumeOpen) {
        const topic = eligibleTopic(db, channel.name, 'volume', { autoPremium })
        if (topic !== null) {
          return {
            kind: 'produce',
            channel: channel.name,
            topicId: topic.id,
            topic: topic.title,
            tier: 'volume',
          }
        }
      }
    }

    return { kind: 'noop', reason: 'no-eligible-work' }
  }
  ```

- [ ] **Step 28: Run the task file to green**

  ```bash
  pnpm vitest run src/loop/plan-tick.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  24 passed (24)`.

- [ ] **Step 28a: Write the failing no-fal-key reason tests (red)**

  An operator whose only eligible work is premium and whose FAL_KEY is unset must
  not see `no-eligible-work` forever — that is indistinguishable from a starved
  queue (spec §8: distinct no-op reasons). First, replace the whole
  `describe('resume pass skip conditions', ...)` block from Step 9 with this
  version (only the premium row's expected reason and the shared assertion
  change):

  ```ts
  describe('resume pass skip conditions', () => {
    const cases: {
      reason: string
      falKeyPresent: boolean
      expected: 'no-eligible-work' | 'no-fal-key'
      seed: (db: Database) => void
    }[] = [
      {
        reason: 'the job is premium and the FAL key is absent',
        falKeyPresent: false,
        expected: 'no-fal-key',
        seed: (db) => {
          seedJob(db, { id: 'job-parked', tier: 'premium', status: 'blocked' })
        },
      },
      {
        reason: 'channel-day headroom is under the resume minimum',
        falKeyPresent: true,
        expected: 'no-eligible-work',
        seed: (db) => {
          seedJob(db, { id: 'job-parked', status: 'blocked' })
          // $20 channel-day cap − $18.50 spent today = $1.50 < $2 headroom
          const spender = seedJob(db)
          recordCost(db, spender, 'fal', 'video', 18_500_000)
        },
      },
      {
        reason: 'global-day headroom is under the resume minimum',
        falKeyPresent: true,
        expected: 'no-eligible-work',
        seed: (db) => {
          seedJob(db, { id: 'job-parked', status: 'blocked' })
          // Jobless sentinel spend: invisible to the channel-day JOIN, counted
          // by the global sum. $25 default cap − $23.50 = $1.50 < $2 headroom.
          recordCost(db, 'scout:test', 'anthropic', 'scout-score', 23_500_000)
        },
      },
    ]

    it.each(cases)('skips the blocked job when $reason', ({ falKeyPresent, expected, seed }) => {
      const db = openDb(':memory:')
      seed(db)
      expect(planTick(db, [testChannel()], { falKeyPresent })).toEqual({
        kind: 'noop',
        reason: expected,
      })
      db.close()
    })
  })
  ```

  Then append at the end of the file:

  ```ts
  describe('no-fal-key noop reason', () => {
    it('surfaces the missing key when an approved topic waits on a premium-only channel', () => {
      const db = openDb(':memory:')
      // approved → volume-eligible too, but this channel has no volume slots,
      // so the ONLY skipped work was premium work behind the missing key
      seedTopic(db, { title: 'approved pick', score: 60, status: 'approved' })
      const ch = testChannel({ tierMix: { volume: 0, premium: 1 } })
      expect(planTick(db, [ch], { falKeyPresent: false })).toEqual({
        kind: 'noop',
        reason: 'no-fal-key',
      })
      db.close()
    })

    it('stays no-eligible-work when nothing premium was skipped for the key', () => {
      const db = openDb(':memory:')
      expect(planTick(db, [testChannel()], { falKeyPresent: false })).toEqual(NOOP)
      db.close()
    })
  })
  ```

- [ ] **Step 28b: Run, observe the failure**

  ```bash
  pnpm vitest run src/loop/plan-tick.test.ts
  ```

  Expected: `26` tests total, 2 fail — the premium table row and the
  premium-only-channel test each get `reason: 'no-eligible-work'` where
  `'no-fal-key'` was expected. The other 24 pass.

- [ ] **Step 28c: Track key-skipped premium work (green)**

  In `src/loop/plan-tick.ts`, make four edits to the final `planTick` from
  Step 27. First, add the tracking flag directly under the `byName` line:

  ```ts
    let skippedForKey = false
  ```

  Second, replace the resume loop's key-skip line
  (`if (job.tier === 'premium' && !opts.falKeyPresent) continue`) with:

  ```ts
      if (job.tier === 'premium' && !opts.falKeyPresent) {
        skippedForKey = true
        continue
      }
  ```

  Third, replace the claim loop's premium branch (the whole
  `if (premiumOpen && opts.falKeyPresent) { ... }` block) with:

  ```ts
      // Premium first: scarce quality slots get the day's best material early.
      // Without the FAL key an eligible premium topic is skipped — volume still
      // flows — and the skip is remembered so an empty tick reports
      // 'no-fal-key' instead of masquerading as a starved queue.
      if (premiumOpen) {
        const topic = eligibleTopic(db, channel.name, 'premium', { autoPremium })
        if (topic !== null) {
          if (!opts.falKeyPresent) {
            skippedForKey = true
          } else {
            return {
              kind: 'produce',
              channel: channel.name,
              topicId: topic.id,
              topic: topic.title,
              tier: 'premium',
            }
          }
        }
      }
  ```

  Fourth, replace the final return with:

  ```ts
    return { kind: 'noop', reason: skippedForKey ? 'no-fal-key' : 'no-eligible-work' }
  ```

- [ ] **Step 28d: Run to green, commit**

  ```bash
  pnpm vitest run src/loop/plan-tick.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  26 passed (26)`. Then:

  ```bash
  git add src/loop/plan-tick.ts src/loop/plan-tick.test.ts
  git commit -m "feat(loop): report no-fal-key when only premium work was skipped" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 29: Run the whole suite**

  ```bash
  pnpm vitest run
  ```

  Expected: every existing test file still green (planTick touches no shared modules), plus the new `src/loop/plan-tick.test.ts` with 24 tests. 0 failures.

- [ ] **Step 30: Typecheck**

  ```bash
  pnpm tsc --noEmit
  ```

  Expected: no output, exit 0.

- [ ] **Step 31: Final commit**

  ```bash
  git add src/loop/plan-tick.ts src/loop/plan-tick.test.ts
  git commit -m "feat(loop): order claim candidates by filled fraction with name tiebreak" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```


### Task 11: produce-next executor + CLI

**Files:**
- Create: `src/loop/produce-next.ts`
- Create: `src/loop/produce-next.test.ts`
- Modify: `src/cli.ts`
- Test: `src/loop/produce-next.test.ts`

**Interfaces:**

Consumes (exact signatures — existing code and lower-numbered tasks):

```ts
// src/db/index.ts (existing) — applies schema.sql on open; WAL; FKs OFF
export function openDb(dbPath: string): Database   // ':memory:' works in tests

// src/jobs/types.ts (existing)
export type Tier = 'volume' | 'premium'
export interface StageDef { name: StageName; run(ctx: JobContext): Promise<void> }
export interface JobContext { jobId: string; db: Database; channel: ChannelConfig; tier: Tier; topic: string; runDir: string; artifactPath(stage: StageName, file: string): string; log: Logger }

// src/jobs/runner.ts (existing)
export interface JobResult { jobId: string; status: 'ready' | 'needs-review' | 'failed' | 'blocked'; videoPath?: string }
export function createJob(db: Database, channel: ChannelConfig, opts: { topic: string; tier: Tier }, _options?: { runsRoot?: string }): string
export async function runJob(db: Database, channel: ChannelConfig, jobId: string, stages: StageDef[], options?: { runsRoot?: string }): Promise<JobResult>
// runJob's final gate reads `<runsRoot>/<jobId>/qc/qc.json` ({ passed: boolean })
// to decide ready vs needs-review and upserts the library row — fake stages
// that write that one file are enough to land a job in the library.

// src/config/channel.ts (Task 2)
export function loadChannelConfig(path: string): ChannelConfig
export function loadChannelsDir(dir: string): ChannelConfig[]  // all <dir>/*.toml, sorted by channel name; throws on unparseable file

// src/scout/topics.ts (Task 1)
export function claimTopic(db: Database, topicId: number, jobId: string): boolean
// guarded: UPDATE ... SET status='claimed', job_id=? WHERE id=? AND status IN ('candidate','approved');
// returns true iff a row changed — a rejected/used/claimed topic is never revived
export function markTopicUsedByJob(db: Database, jobId: string): void  // claimed row with matching job_id → 'used'; silent no-op when none

// src/loop/lease.ts (Task 8)
export const PRODUCE_LEASE_TTL_MS = 5_400_000
export function acquireLease(db: Database, name: string, holder: string, ttlMs: number): boolean
export function releaseLease(db: Database, name: string, holder: string): void  // deletes only when holder matches

// src/jobs/pipeline.ts (Task 9)
export function stagesForTier(tier: Tier): StageDef[]

// src/jobs/resume.ts (Task 9)
export async function resumeJob(db: Database, jobId: string, opts: {
  runsRoot: string; channelsDir: string; force?: boolean;
  stagesFor?: (tier: Tier) => StageDef[];
}): Promise<JobResult>
// 'blocked' resumes without force; premium → assertPremiumPreflight;
// library-landed → markTopicUsedByJob (resumeJob does this itself).

// src/loop/plan-tick.ts (Task 10)
export type TickPlan =
  | { kind: 'resume'; jobId: string; channel: string; tier: Tier }
  | { kind: 'produce'; channel: string; topicId: number; topic: string; tier: Tier }
  | { kind: 'noop'; reason: 'no-eligible-work' | 'no-fal-key' }
export function planTick(db: Database, channels: ChannelConfig[], opts: { falKeyPresent: boolean }): TickPlan
// 'no-fal-key' is returned instead of 'no-eligible-work' when the tick found premium
// work but skipped it for falKeyPresent=false (a blocked premium job skipped at the
// key check, or an open premium slot with an eligible approved/auto_premium topic)
// and nothing else was runnable — so an operator with an unset FAL_KEY can tell a
// starved queue from a key problem (spec §8's distinct no-op reasons).
// Pure decision fn (no writes). Resume pass (oldest blocked job with headroom;
// premium only when falKeyPresent) before claim pass (lowest filled-fraction
// channel; premium slot first; eligibleTopic per tier/auto_premium).
```

Produces (binding — Task 14's golden-path loop test calls `produceNextTick` directly):

```ts
// src/loop/produce-next.ts
export interface TickResult {
  action: 'resumed' | 'produced' | 'noop'
  reason?: 'lease-held' | 'no-eligible-work' | 'no-fal-key'
  jobId?: string; topicId?: number; tier?: Tier; status?: JobResult['status']
}
export async function produceNextTick(db: Database, opts: {
  channelsDir: string; runsRoot: string;
  stagesFor?: (tier: Tier) => StageDef[];   // test seam; default stagesForTier
}): Promise<TickResult>
// CLI: brainrot produce-next [--db <path>] [--channels-dir <dir>] [--runs-root <path>]
// stdout: exactly one JSON line (TickResult). exit 1 iff status 'failed' | 'blocked'.
```

Semantics pinned by the contract and spec (§6): holder is `` `pid:${process.pid}` ``; a held lease is the NORMAL case while a previous firing's render is still running — benign no-op (`reason: 'lease-held'`), exit 0. The leased body runs in `try/finally releaseLease` so both success and any throw free the lease. Resume never sets `force` (planTick only surfaces `blocked` jobs). Produce is `createJob` + `claimTopic` committed in ONE `db.transaction` (better-sqlite3 nests createJob's internal transaction as a savepoint; a false claim throws and rolls the job row back, so no orphan and no revived topic) then `runJob(stagesFor(tier))`; only a library-landed result (`'ready' | 'needs-review'`) flips the claimed topic to `used` — a failed/blocked job keeps its topic `claimed` and job-bound for the resume path.

House rules in force: ESM `.js` suffixes on relative imports; no semicolons, single quotes, trailing commas in `src/loop/` (match `src/loop/lease.ts`); real SQLite via `openDb(':memory:')`; tests never construct `ChannelConfig` literals (Task 2 made `scout` a required member) — they load a TOML from a temp dir instead; conventional commits with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

---

- [ ] **Step 1: Write the failing produce + resume dispatch tests (red)**

  Create `src/loop/produce-next.test.ts` with exactly:

  ```ts
  import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
  import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import type { Database } from 'better-sqlite3'
  import { loadChannelConfig } from '../config/channel.js'
  import { openDb } from '../db/index.js'
  import { createJob } from '../jobs/runner.js'
  import type { JobContext, StageDef } from '../jobs/types.js'
  import { produceNextTick } from './produce-next.js'

  // Plan-1-shape channel TOML (no [scout] table needed — the loop reads topics,
  // not sources). The filename must match `name`: resumeJob resolves the channel
  // as `${channelsDir}/${job.channel}.toml`.
  const CHANNEL_TOML = [
    'name = "loop-chan"',
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
  ].join('\n')

  const cleanupDirs: string[] = []
  function tmpDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix))
    cleanupDirs.push(d)
    return d
  }
  afterAll(() => {
    for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true })
  })

  // One shared read-only channels dir; each test gets a fresh db and runs root.
  const channelsDir = tmpDir('brainrot-loop-channels-')
  writeFileSync(join(channelsDir, 'loop-chan.toml'), CHANNEL_TOML)

  function setup() {
    const db = openDb(':memory:')
    const runsRoot = join(tmpDir('brainrot-loop-run-'), 'runs')
    return { db, runsRoot }
  }

  let topicSeq = 0
  function seedTopic(db: Database): number {
    topicSeq += 1
    const info = db
      .prepare(
        'INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'loop-chan',
        'Venus rains molten metal',
        'TIL Venus rains metal',
        'reddit:r/space',
        'https://www.reddit.com/r/space/comments/abc',
        `hash-${topicSeq}`,
        80,
        'hooky and on-niche',
        'candidate',
      )
    return Number(info.lastInsertRowid)
  }

  // The runner's final gate reads qc/qc.json to pick ready vs needs-review, so
  // a one-stage fake pipeline that writes it is the cheapest library landing.
  function readyStages(): StageDef[] {
    return [
      {
        name: 'qc',
        async run(ctx: JobContext) {
          writeFileSync(
            ctx.artifactPath('qc', 'qc.json'),
            JSON.stringify({ passed: true, checks: [] }),
          )
        },
      },
    ]
  }

  beforeEach(() => {
    // Deterministic regardless of the developer's shell or .env: no fal key
    // (volume path only) and the default $25 global cap.
    vi.stubEnv('FAL_KEY', '')
    vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('produceNextTick — produce', () => {
    it('claims the eligible topic, produces it, and flips it used on library landing', async () => {
      const { db, runsRoot } = setup()
      const topicId = seedTopic(db)
      const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: readyStages })
      expect(result).toEqual({
        action: 'produced',
        jobId: expect.any(String),
        topicId,
        tier: 'volume',
        status: 'ready',
      })
      // topic consumed: claimed → used, bound to the created job
      const topic = db
        .prepare('SELECT status, job_id FROM topics WHERE id = ?')
        .get(topicId) as { status: string; job_id: string }
      expect(topic).toEqual({ status: 'used', job_id: result.jobId })
      // the job row carries the reframed topic title and landed in the library
      const job = db
        .prepare('SELECT topic, tier, status FROM jobs WHERE id = ?')
        .get(result.jobId) as { topic: string; tier: string; status: string }
      expect(job).toEqual({ topic: 'Venus rains molten metal', tier: 'volume', status: 'done' })
      const lib = db
        .prepare('SELECT state FROM library WHERE job_id = ?')
        .get(result.jobId) as { state: string }
      expect(lib.state).toBe('ready')
      db.close()
    })
  })

  describe('produceNextTick — resume', () => {
    it('resumes the blocked job through resumeJob before claiming anything', async () => {
      const { db, runsRoot } = setup()
      const channel = loadChannelConfig(join(channelsDir, 'loop-chan.toml'))
      const jobId = createJob(db, channel, { topic: 'parked by budget', tier: 'volume' })
      db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(jobId)
      // an eligible topic exists too: the resume pass must win over the claim pass
      seedTopic(db)
      const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: readyStages })
      expect(result).toEqual({ action: 'resumed', jobId, tier: 'volume', status: 'ready' })
      const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as {
        status: string
      }
      expect(job.status).toBe('done')
      // the topic was not claimed: it waits for the next tick
      const topics = db.prepare('SELECT status FROM topics').all() as { status: string }[]
      expect(topics).toEqual([{ status: 'candidate' }])
      db.close()
    })
  })
  ```

  Run it:

  ```bash
  pnpm vitest run src/loop/produce-next.test.ts
  ```

  Expected failure: the whole file fails to collect with a module-resolution error (`Failed to load url ./produce-next.js` / `Cannot find module`) — `src/loop/produce-next.ts` does not exist yet. (A file-load failure, not the missing-named-export TypeError — the entire module is absent.)

- [ ] **Step 2: Implement produceNextTick core dispatch (green)**

  Create `src/loop/produce-next.ts` with exactly:

  ```ts
  import type { Database } from 'better-sqlite3'
  import { loadChannelsDir } from '../config/channel.js'
  import { stagesForTier } from '../jobs/pipeline.js'
  import { resumeJob } from '../jobs/resume.js'
  import { createJob, runJob } from '../jobs/runner.js'
  import type { JobResult } from '../jobs/runner.js'
  import type { StageDef, Tier } from '../jobs/types.js'
  import { claimTopic, markTopicUsedByJob } from '../scout/topics.js'
  import { planTick } from './plan-tick.js'

  export interface TickResult {
    action: 'resumed' | 'produced' | 'noop'
    reason?: 'lease-held' | 'no-eligible-work' | 'no-fal-key'
    jobId?: string
    topicId?: number
    tier?: Tier
    status?: JobResult['status']
  }

  /**
   * One unit of work per invocation: resume the planner's blocked job, or claim
   * one topic and produce it. Cron cadence controls throughput — this function
   * never loops.
   */
  export async function produceNextTick(
    db: Database,
    opts: {
      channelsDir: string
      runsRoot: string
      stagesFor?: (tier: Tier) => StageDef[]
    },
  ): Promise<TickResult> {
    const stagesFor = opts.stagesFor ?? stagesForTier
    const channels = loadChannelsDir(opts.channelsDir)
    const plan = planTick(db, channels, { falKeyPresent: !!process.env.FAL_KEY })

    if (plan.kind === 'noop') {
      return { action: 'noop', reason: plan.reason }
    }

    if (plan.kind === 'resume') {
      // planTick only surfaces blocked jobs, so force stays unset: taking over
      // a 'running' job is an operator decision, never the loop's.
      const result = await resumeJob(db, plan.jobId, {
        runsRoot: opts.runsRoot,
        channelsDir: opts.channelsDir,
        stagesFor,
      })
      return { action: 'resumed', jobId: plan.jobId, tier: plan.tier, status: result.status }
    }

    const channel = channels.find((c) => c.name === plan.channel)
    if (channel === undefined) {
      throw new Error(`planTick chose a channel missing from the loaded set: ${plan.channel}`)
    }
    // createJob + claimTopic commit atomically: a crash between them can
    // neither orphan a queued job nor leave the topic unbound, and a false
    // claim (invariant breach — planTick selected this topic under this very
    // lease) rolls the job row back via the throw. better-sqlite3 nests
    // createJob's internal transaction as a savepoint, so the wrap is safe.
    const jobId = db.transaction(() => {
      const id = createJob(db, channel, { topic: plan.topic, tier: plan.tier })
      if (!claimTopic(db, plan.topicId, id)) {
        throw new Error(`topic ${plan.topicId} is no longer claimable (status changed since planning)`)
      }
      return id
    })()
    const result = await runJob(db, channel, jobId, stagesFor(plan.tier), {
      runsRoot: opts.runsRoot,
    })
    markTopicUsedByJob(db, jobId)
    return { action: 'produced', jobId, topicId: plan.topicId, tier: plan.tier, status: result.status }
  }
  ```

  Run to green:

  ```bash
  pnpm vitest run src/loop/produce-next.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  2 passed (2)`.

- [ ] **Step 3: Commit the core dispatch**

  ```bash
  git add src/loop/produce-next.ts src/loop/produce-next.test.ts
  git commit -m "feat(loop): produceNextTick — one resume-or-produce unit per tick" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 4: Write the failing lease tests (red)**

  In `src/loop/produce-next.test.ts`, add below the `./produce-next.js` import:

  ```ts
  import { acquireLease, PRODUCE_LEASE_TTL_MS } from './lease.js'
  ```

  Add after the `readyStages` function:

  ```ts
  // Guard seam for paths that must never reach the pipeline.
  function neverStages(): StageDef[] {
    throw new Error('stagesFor must not be called on this path')
  }
  ```

  Append at the end of the file:

  ```ts
  describe('produceNextTick — lease', () => {
    it('no-ops with reason lease-held while another process holds the lease', async () => {
      const { db, runsRoot } = setup()
      seedTopic(db)
      acquireLease(db, 'produce', 'pid:other-process', PRODUCE_LEASE_TTL_MS)
      const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: neverStages })
      expect(result).toEqual({ action: 'noop', reason: 'lease-held' })
      // the holder's lease survives untouched and nothing was claimed or created
      const lease = db.prepare("SELECT holder FROM leases WHERE name = 'produce'").get() as {
        holder: string
      }
      expect(lease.holder).toBe('pid:other-process')
      expect((db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(0)
      db.close()
    })

    it('releases the lease after a successful tick', async () => {
      const { db, runsRoot } = setup()
      seedTopic(db)
      const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: readyStages })
      expect(result.status).toBe('ready')
      // freed for the next cron firing: a fresh holder acquires immediately
      expect(acquireLease(db, 'produce', 'pid:probe', PRODUCE_LEASE_TTL_MS)).toBe(true)
      db.close()
    })

    it('releases the lease when the tick throws mid-flight', async () => {
      const { db, runsRoot } = setup()
      // an unparseable channel TOML makes loadChannelsDir throw inside the leased window
      const brokenDir = tmpDir('brainrot-loop-broken-')
      writeFileSync(join(brokenDir, 'broken.toml'), 'this is not toml [')
      await expect(
        produceNextTick(db, { channelsDir: brokenDir, runsRoot, stagesFor: neverStages }),
      ).rejects.toThrow()
      expect(acquireLease(db, 'produce', 'pid:probe', PRODUCE_LEASE_TTL_MS)).toBe(true)
      db.close()
    })
  })
  ```

  Run it:

  ```bash
  pnpm vitest run src/loop/produce-next.test.ts
  ```

  Expected failure: the lease-held test fails — Step 2's implementation never consults the lease, the seeded topic drives it into the produce branch, and evaluating `stagesFor(plan.tier)` throws, so the test rejects with `Error: stagesFor must not be called on this path`. The two release tests pass vacuously (no lease is ever taken yet — the probe acquire trivially succeeds); they exist to pin the release behavior the moment the gate lands. 2 existing tests stay green.

- [ ] **Step 5: Gate the tick behind the produce lease (green)**

  In `src/loop/produce-next.ts`, add below the `../scout/topics.js` import:

  ```ts
  import { acquireLease, PRODUCE_LEASE_TTL_MS, releaseLease } from './lease.js'
  ```

  Replace the whole `produceNextTick` function with:

  ```ts
  /**
   * One unit of work per invocation: resume the planner's blocked job, or claim
   * one topic and produce it. Cron cadence controls throughput — this function
   * never loops.
   */
  export async function produceNextTick(
    db: Database,
    opts: {
      channelsDir: string
      runsRoot: string
      stagesFor?: (tier: Tier) => StageDef[]
    },
  ): Promise<TickResult> {
    const stagesFor = opts.stagesFor ?? stagesForTier
    // A held lease is the NORMAL case while a long render from the previous
    // cron firing is still running — benign no-op, exit 0 at the CLI. The
    // pid-tagged holder means an expiry takeover can never be released by the
    // evicted process (releaseLease matches on holder).
    const holder = `pid:${process.pid}`
    if (!acquireLease(db, 'produce', holder, PRODUCE_LEASE_TTL_MS)) {
      return { action: 'noop', reason: 'lease-held' }
    }
    try {
      const channels = loadChannelsDir(opts.channelsDir)
      const plan = planTick(db, channels, { falKeyPresent: !!process.env.FAL_KEY })

      if (plan.kind === 'noop') {
        return { action: 'noop', reason: plan.reason }
      }

      if (plan.kind === 'resume') {
        // planTick only surfaces blocked jobs, so force stays unset: taking
        // over a 'running' job is an operator decision, never the loop's.
        const result = await resumeJob(db, plan.jobId, {
          runsRoot: opts.runsRoot,
          channelsDir: opts.channelsDir,
          stagesFor,
        })
        return { action: 'resumed', jobId: plan.jobId, tier: plan.tier, status: result.status }
      }

      const channel = channels.find((c) => c.name === plan.channel)
      if (channel === undefined) {
        throw new Error(`planTick chose a channel missing from the loaded set: ${plan.channel}`)
      }
      // createJob + claimTopic commit atomically: a crash between them can
      // neither orphan a queued job nor leave the topic unbound, and a false
      // claim (invariant breach — planTick selected this topic under this very
      // lease) rolls the job row back via the throw. better-sqlite3 nests
      // createJob's internal transaction as a savepoint, so the wrap is safe.
      const jobId = db.transaction(() => {
        const id = createJob(db, channel, { topic: plan.topic, tier: plan.tier })
        if (!claimTopic(db, plan.topicId, id)) {
          throw new Error(`topic ${plan.topicId} is no longer claimable (status changed since planning)`)
        }
        return id
      })()
      const result = await runJob(db, channel, jobId, stagesFor(plan.tier), {
        runsRoot: opts.runsRoot,
      })
      markTopicUsedByJob(db, jobId)
      return { action: 'produced', jobId, topicId: plan.topicId, tier: plan.tier, status: result.status }
    } finally {
      releaseLease(db, 'produce', holder)
    }
  }
  ```

  Run to green:

  ```bash
  pnpm vitest run src/loop/produce-next.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  5 passed (5)`.

- [ ] **Step 6: Commit the lease gate**

  ```bash
  git add src/loop/produce-next.ts src/loop/produce-next.test.ts
  git commit -m "feat(loop): serialize produce ticks behind the produce lease" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 7: Write the failing failed-stage test (red)**

  In `src/loop/produce-next.test.ts`, add after the `neverStages` function:

  ```ts
  function failingStages(): StageDef[] {
    return [
      {
        name: 'script',
        async run() {
          throw new Error('stage exploded')
        },
      },
    ]
  }
  ```

  Append at the end of the file:

  ```ts
  describe('produceNextTick — failed produce', () => {
    it('keeps the topic claimed and job-bound when a stage fails', async () => {
      const { db, runsRoot } = setup()
      const topicId = seedTopic(db)
      const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: failingStages })
      expect(result).toEqual({
        action: 'produced',
        jobId: expect.any(String),
        topicId,
        tier: 'volume',
        status: 'failed',
      })
      // claimed + bound to its failed job: the resume path owns recovery, the
      // topic is never re-claimed or lost
      const topic = db
        .prepare('SELECT status, job_id FROM topics WHERE id = ?')
        .get(topicId) as { status: string; job_id: string }
      expect(topic).toEqual({ status: 'claimed', job_id: result.jobId })
      const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(result.jobId) as {
        status: string
      }
      expect(job.status).toBe('failed')
      expect(acquireLease(db, 'produce', 'pid:probe', PRODUCE_LEASE_TTL_MS)).toBe(true)
      db.close()
    })
  })
  ```

  Run it:

  ```bash
  pnpm vitest run src/loop/produce-next.test.ts
  ```

  Expected failure: the new test fails at the topic assertion with a `toEqual` diff — `status: 'used'` received where `'claimed'` was expected — because Step 5's implementation calls `markTopicUsedByJob` unconditionally after `runJob`. The 5 existing tests stay green.

- [ ] **Step 8: Flip topics used only on library landing (green)**

  In `src/loop/produce-next.ts`, replace

  ```ts
      markTopicUsedByJob(db, jobId)
      return { action: 'produced', jobId, topicId: plan.topicId, tier: plan.tier, status: result.status }
  ```

  with

  ```ts
      if (result.status === 'ready' || result.status === 'needs-review') {
        // Library-landed is the only used-flip: a failed/blocked job keeps its
        // topic 'claimed' and bound to the job — the resume path owns recovery,
        // so the topic is never re-claimed or lost.
        markTopicUsedByJob(db, jobId)
      }
      return { action: 'produced', jobId, topicId: plan.topicId, tier: plan.tier, status: result.status }
  ```

  Run to green:

  ```bash
  pnpm vitest run src/loop/produce-next.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  6 passed (6)`.

- [ ] **Step 9: Commit the library-landed guard**

  ```bash
  git add src/loop/produce-next.ts src/loop/produce-next.test.ts
  git commit -m "feat(loop): flip topics used only when the job lands in the library" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 10: Write the failing CLI tests (red)**

  In `src/loop/produce-next.test.ts`, add below the vitest import:

  ```ts
  import { execa } from 'execa'
  ```

  Append at the end of the file (the subprocess runs with vitest's cwd — the repo root — so `src/cli.ts` resolves, matching `src/cli.test.ts`):

  ```ts
  describe('produce-next CLI', () => {
    it('`produce-next --help` prints usage with --db/--channels-dir/--runs-root', async () => {
      const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'produce-next', '--help'], {
        reject: false,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--db')
      expect(result.stdout).toContain('--channels-dir')
      expect(result.stdout).toContain('--runs-root')
    }, 60000)

    it('`produce-next` with no eligible work prints one noop JSON line and exits 0', async () => {
      const root = tmpDir('brainrot-loop-cli-')
      const result = await execa(
        'pnpm',
        ['exec', 'tsx', 'src/cli.ts', 'produce-next',
          '--db', join(root, 'brainrot.db'), '--channels-dir', channelsDir, '--runs-root', join(root, 'runs')],
        { reject: false },
      )
      expect(result.exitCode).toBe(0)
      // exactly one cron-greppable JSON line
      expect(result.stdout.trim().split('\n')).toHaveLength(1)
      expect(JSON.parse(result.stdout)).toEqual({ action: 'noop', reason: 'no-eligible-work' })
    }, 60000)
  })
  ```

  Run it:

  ```bash
  pnpm vitest run src/loop/produce-next.test.ts
  ```

  Expected failure: both new tests fail at their first assertion with `expected 1 to be +0` — commander exits 1 and prints `error: unknown command 'produce-next'` on stderr because the command is not wired yet. The 6 existing tests stay green.

- [ ] **Step 11: Wire the `produce-next` CLI command (green)**

  In `src/cli.ts`, add to the local-import group at the top, after the `import { scoutAll } from './scout/scout.js'` line Task 7 added (any position inside the group works if that anchor moved):

  ```ts
  import { produceNextTick } from './loop/produce-next.js'
  ```

  Add the command block after the last existing `program.command(...)` block, immediately before the comment beginning `// cli.test.ts imports` (registration order only affects `--help` listing):

  ```ts
  program
    .command('produce-next')
    .option('--db <path>', 'sqlite db path')
    .option('--channels-dir <dir>', 'channel TOML directory', 'channels')
    .option('--runs-root <path>', 'runs root directory', 'runs')
    .action(async (opts: { db?: string; channelsDir: string; runsRoot: string }) => {
      const db = openDb(resolveDbPath(opts.db))
      try {
        const result = await produceNextTick(db, {
          channelsDir: opts.channelsDir,
          runsRoot: opts.runsRoot,
        })
        // One cron-greppable JSON line. Exit mirrors produce: 0 for
        // ready/needs-review and benign no-ops, 1 for failed AND blocked (the
        // JSON line carries the finer distinction). status is undefined on
        // noops, so the ternary lands on 0 for them.
        process.stdout.write(JSON.stringify(result) + '\n')
        process.exitCode = result.status === 'failed' || result.status === 'blocked' ? 1 : 0
      } finally {
        db.close()
      }
    })
  ```

  (A thrown config/db error — bad channels dir, invalid db — propagates to the existing `parseAsync` catch: message on stderr, exit 1, no JSON line. That is exactly the carve-out the Global Constraints JSON-output rule makes: the one-JSON-line guarantee applies to runs that get past config/db validation; failure OUTCOMES of a valid run — a produced job that failed — still print their JSON line.)

  Run to green:

  ```bash
  pnpm vitest run src/loop/produce-next.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  8 passed (8)` (the two subprocess tests take a few seconds each for tsx startup).

- [ ] **Step 12: Run the whole suite and the type gate**

  ```bash
  pnpm vitest run
  ```

  Expected: every test file passes (the pre-existing suite plus `src/loop/produce-next.test.ts`; contract tests stay excluded unless `CONTRACT=1`), zero failures.

  ```bash
  pnpm tsc --noEmit
  ```

  Expected: no output, exit code 0.

- [ ] **Step 13: Final commit**

  ```bash
  git add src/cli.ts src/loop/produce-next.test.ts
  git commit -m "feat: add brainrot produce-next CLI command" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```


### Task 12: topics CLI subcommands

**Files:**
- Create: (none — no new module; wiring lives in `src/cli.ts` per contract)
- Modify: `src/cli.ts`, `src/cli.test.ts`
- Test: `src/cli.test.ts`

**Interfaces:**

Consumes (exact signatures from lower-numbered tasks and existing code):

```ts
// Task 1 — src/scout/topics.ts
export type TopicStatus = 'candidate' | 'approved' | 'claimed' | 'used' | 'rejected'
export interface TopicRow {
  id: number; channel: string; title: string; rawTitle: string; source: string;
  url: string; dedupeHash: string; score: number; reason: string;
  status: TopicStatus; jobId: string | null; createdAt: string
}
export function listTopics(db: Database, filter?: { channel?: string; status?: TopicStatus }): TopicRow[]  // newest first
export function approveTopics(db: Database, ids: number[]): number  // candidate→approved only; returns changed count
export function rejectTopics(db: Database, ids: number[]): number   // candidate|approved→rejected; returns changed count

// Existing — src/db/index.ts
export function openDb(dbPath: string): Database

// Existing module-private helper in src/cli.ts (reused as-is, not exported):
// function resolveDbPath(flagDb?: string): string   // flag → BRAINROT_DB → 'data/brainrot.db'
```

Produces (operator-facing; Task 14's README documents these commands — no later task imports them programmatically):

```ts
// src/cli.ts
export function parseTopicIds(raw: string[]): number[]
// throws Error naming the FIRST bad token unless every entry is a positive integer;
// "12abc", "0", "-3" all rejected

// CLI (nested commander subcommands):
//   brainrot topics list    [--db <path>] [--channel <name>] [--status <status>]
//     → console.table of { id, channel, score, status, title, reason } (via listTopics)
//   brainrot topics approve <ids...> [--db <path>]  → prints `approved ${changed} of ${ids.length}`; exit 0
//   brainrot topics reject  <ids...> [--db <path>]  → prints `rejected ${changed} of ${ids.length}`; exit 0
//   bad id token → parseTopicIds throws BEFORE the db opens → error message, exit 1, no writes
```

Binding shape (from the plan): `const topics = program.command('topics')`, then `topics.command('list')` / `topics.command('approve <ids...>')` / `topics.command('reject <ids...>')`. The actions are thin — id validation lives in `parseTopicIds` (tested in-process here) and the state transitions live in the Task 1 DAO (tested in `src/scout/topics.test.ts`) — matching how `produce`/`jobs`/`costs` actions are treated today. The actions are NOT spawned as subprocess tests; the single subprocess test below exercises command REGISTRATION only (`--help` never runs an action).

Context you will see in `src/cli.ts` when you start: Tasks 7/9/11 have already touched this file (a `scout` command; `stagesForTier`/`assertPremiumPreflight` re-exported from `./jobs/pipeline.js`; `resume` and `produce-next` commands). None of that changes this task's anchors: the `parseTier` function, the `openDb` import, the `costs` command block, and the `isMain` guard at the bottom are all still present. `src/cli.test.ts` imports from `./cli.js` in-process — the `isMain` guard keeps the argv parser from firing under vitest.

Run every command from the repo root `/Users/alex/code/project-brainrot`.

- [ ] **Step 1: Write the failing parseTopicIds tests (red)**

  In `src/cli.test.ts`, add `parseTopicIds` to the in-process import from `./cli.js`:

  ```ts
  import { assertPremiumPreflight, parseTier, parseTopicIds, stagesForTier } from './cli.js'
  ```

  Append a new top-level describe block at the end of the file (after the `assertPremiumPreflight (in-process)` block):

  ```ts
  describe('parseTopicIds (in-process)', () => {
    it('parses positive integer tokens in order', () => {
      expect(parseTopicIds(['12', '3', '400'])).toEqual([12, 3, 400])
      // commander's <ids...> guarantees at least one token, but the helper
      // itself is total: an empty list is an empty result, not an error.
      expect(parseTopicIds([])).toEqual([])
    })

    it('throws naming the first bad token; "12abc", "0", "-3" all reject', () => {
      expect(() => parseTopicIds(['12abc'])).toThrow(
        'invalid topic id "12abc": ids must be positive integers',
      )
      expect(() => parseTopicIds(['0'])).toThrow('invalid topic id "0"')
      expect(() => parseTopicIds(['-3'])).toThrow('invalid topic id "-3"')
      // the FIRST offender is the one named, even when later tokens are also bad
      expect(() => parseTopicIds(['5', '0', '-3'])).toThrow('invalid topic id "0"')
    })
  })
  ```

- [ ] **Step 2: Run, observe the failure**

  ```bash
  pnpm vitest run src/cli.test.ts
  ```

  Expected failure: both new tests fail because the named export does not exist yet (`cli.ts` exists, so the import line resolves — esbuild silently binds the missing named export to `undefined`; the failure surfaces only when the tests call it). The direct-call test shows the raw `TypeError: parseTopicIds is not a function`; the `toThrow`-shaped test catches that TypeError inside the matcher and reports an assertion mismatch naming the TypeError message instead of the expected `invalid topic id` text. Every pre-existing test in the file stays green.

- [ ] **Step 3: Implement parseTopicIds (green)**

  In `src/cli.ts`, add immediately after the `parseTier` function:

  ```ts
  /**
   * Validate `topics approve/reject` id arguments. Throws naming the FIRST bad
   * token, BEFORE any db handle exists, so one typo means exit 1 with no writes.
   * Canonical positive decimal integers only — "0", "-3", "12abc" all reject.
   * Exported so cli.test.ts can assert it in-process.
   */
  export function parseTopicIds(raw: string[]): number[] {
    return raw.map((token) => {
      if (!/^[1-9]\d*$/.test(token)) {
        throw new Error(`invalid topic id "${token}": ids must be positive integers`)
      }
      return Number(token)
    })
  }
  ```

- [ ] **Step 4: Run to green**

  ```bash
  pnpm vitest run src/cli.test.ts
  ```

  Expected: `Test Files  1 passed (1)` with 0 failures — 14 tests if Tasks 1–11 landed exactly as planned (12 pre-existing after Task 7's two scout tests, plus these 2; the absolute count may differ slightly if an earlier task added more, the gate is 0 failures).

- [ ] **Step 5: Commit parseTopicIds**

  ```bash
  git add src/cli.ts src/cli.test.ts
  git commit -m "feat: add parseTopicIds for topics CLI id arguments" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 6: Write the failing command-registration test (red)**

  Append inside the `describe('brainrot CLI', ...)` block of `src/cli.test.ts`, after its last test. `--help` exercises the nested-command wiring only — commander prints usage and exits before any action runs, so no db handle and no writes are involved:

  ```ts
    it('`topics --help` lists the list/approve/reject subcommands', async () => {
      const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'topics', '--help'], {
        reject: false,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('list')
      expect(result.stdout).toContain('approve')
      expect(result.stdout).toContain('reject')
    }, 60000)
  ```

- [ ] **Step 7: Run, observe the failure**

  ```bash
  pnpm vitest run src/cli.test.ts
  ```

  Expected failure: the new test's `expect(result.exitCode).toBe(0)` fails with `expected 1 to be 0` — the subprocess exits 1 and commander prints `error: unknown command 'topics'` on stderr, because no `topics` command is registered yet.

- [ ] **Step 8: Wire the topics subcommands (green)**

  In `src/cli.ts`, add two import lines after the existing `openDb` import (`import { openDb } from './db/index.js'`):

  ```ts
  import { approveTopics, listTopics, rejectTopics } from './scout/topics.js'
  import type { TopicStatus } from './scout/topics.js'
  ```

  Add the command block after the `costs` command block (before the `isMain` computation at the bottom of the file). Like `jobs`/`costs`, these synchronous actions leave the db handle to process exit — better-sqlite3 commits at each statement, so nothing is pending:

  ```ts
  // Operator gate over the scouted topic queue. Actions are thin: id validation
  // lives in parseTopicIds, state transitions in the topics DAO.
  const topics = program.command('topics')

  topics
    .command('list')
    .option('--db <path>', 'sqlite db path')
    .option('--channel <name>', 'filter by channel')
    .option('--status <status>', 'filter by topic status')
    .action((opts: { db?: string; channel?: string; status?: string }) => {
      const db = openDb(resolveDbPath(opts.db))
      // An unknown --status matches no rows (the DAO filters verbatim), so the
      // operator sees an empty table rather than an error.
      const rows = listTopics(db, {
        channel: opts.channel,
        status: opts.status as TopicStatus | undefined,
      })
      console.table(
        rows.map((r) => ({
          id: r.id,
          channel: r.channel,
          score: r.score,
          status: r.status,
          title: r.title,
          reason: r.reason,
        })),
      )
    })

  topics
    .command('approve <ids...>')
    .option('--db <path>', 'sqlite db path')
    .action((rawIds: string[], opts: { db?: string }) => {
      // Ids parse BEFORE the db opens: a bad token throws to the parseAsync
      // .catch (message on stderr, exit 1) with no writes.
      const ids = parseTopicIds(rawIds)
      const db = openDb(resolveDbPath(opts.db))
      const changed = approveTopics(db, ids)
      // changed < ids.length flags ids that were not in 'candidate' state.
      console.log(`approved ${changed} of ${ids.length}`)
    })

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

- [ ] **Step 9: Run to green**

  ```bash
  pnpm vitest run src/cli.test.ts
  ```

  Expected: `Test Files  1 passed (1)` with 0 failures (15 tests under the Step 4 count assumption; the subprocess tests take a few seconds each).

- [ ] **Step 10: Run the whole suite**

  ```bash
  pnpm vitest run
  ```

  Expected: every test file passes, 0 failures (contract tests are excluded by `vitest.config.ts` unless `CONTRACT=1`). This task added no schema or module changes, so only `src/cli.test.ts` grew.

- [ ] **Step 11: Typecheck**

  ```bash
  pnpm tsc --noEmit
  ```

  Expected: no output, exit 0.

- [ ] **Step 12: Final commit**

  ```bash
  git add src/cli.ts src/cli.test.ts
  git commit -m "feat: add brainrot topics list/approve/reject subcommands" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```


### Task 13: Digest + CLI

**Files:**
- Create: `src/loop/digest.ts`, `src/loop/digest.test.ts`
- Modify: `src/cli.ts`, `src/cli.test.ts`
- Test: `src/loop/digest.test.ts`, `src/cli.test.ts`

All paths are relative to the repo root `/Users/alex/code/project-brainrot`. Run every command from the repo root. `src/loop/` already exists (Task 8 created it for `lease.ts`). `buildDigest` returns ONE human-readable multi-line string (NOT JSON) with four sections in this exact order: topics last 24h, jobs last 24h, spend today (UTC), action items. The `digest` CLI command prints it and ALWAYS exits 0 — it is a report, not a check.

**Interfaces:**

Consumes (exact signatures — Tasks 2 and 5 plus existing code):

```ts
// src/db/index.ts (existing)
export function openDb(dbPath: string): Database   // better-sqlite3; FKs OFF by design

// src/config/channel.ts (existing + Task 2)
export interface ChannelConfig {
  name: string; niche: string[]; tierMix: { volume: number; premium: number };
  /* ...voice, premium, captionStyle, bgDir, bgmDir, scriptModel, scout... */
  budget: { perVideoUsdMicros: number; premiumPerVideoUsdMicros: number; perDayUsdMicros: number }
}
export function loadChannelsDir(dir: string): ChannelConfig[]  // all <dir>/*.toml, sorted by channel name; throws on unparseable file (Task 2)

// src/jobs/costs.ts (Task 5 extractions)
export function channelDaySpentMicros(db: Database, channel: string): number  // today UTC, JOIN through jobs
export function globalDaySpentMicros(db: Database): number                    // today UTC, ALL costs rows, no JOIN (sentinels count)
export function globalDailyCapMicros(): number                                // BRAINROT_GLOBAL_DAILY_USD, default $25, in micros

// src/stages/_testkit.ts (existing; Task 2 added the scout field to its literal)
export function testChannel(overrides?: Partial<ChannelConfig>): ChannelConfig

// src/cli.ts (existing internals reused by the new command, in-file)
function resolveDbPath(flagDb?: string): string    // module-private; flag ?? BRAINROT_DB ?? 'data/brainrot.db'
```

Relevant table shapes (from `src/db/schema.sql` — jobs/library are pre-existing; topics landed in Task 1):

```sql
jobs(id TEXT PK, channel, tier CHECK IN ('volume','premium'), topic,
     status CHECK IN ('queued','running','failed','done','blocked'),
     created_at DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), finished_at)
library(job_id TEXT PK, video_path, metadata_json,
        state CHECK IN ('ready','needs-review','published','blocked'), created_at)
topics(id INTEGER PK, channel, title, raw_title, source, url, dedupe_hash, score, reason,
       status CHECK IN ('candidate','approved','claimed','used','rejected'), job_id,
       created_at DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE (channel, dedupe_hash))
```

Produces (binding — Task 14's README cron block schedules `brainrot digest`):

```ts
// src/loop/digest.ts
export const ZOMBIE_RUNNING_MS = 7_200_000   // 2 h
export function buildDigest(db: Database, channels: ChannelConfig[]): string
// CLI: brainrot digest [--db <path>] [--channels-dir <dir>]   (default channels/)
// prints buildDigest to stdout; ALWAYS exit 0, even on config/db errors (error → stderr)
```

House style notes (match them): no semicolons in `src/loop/` and `src/jobs/`, single quotes, trailing commas, comments state constraints (never narrate changes). ESM: relative imports end in `.js`. Money is integer micro-USD; division happens only inside the display formatter, `$${(micros / 1e6).toFixed(2)}` — the same shape the existing `costs` CLI command uses. House gotcha: with vitest/esbuild a missing named export resolves to `undefined` and fails at runtime with a `TypeError`, not an import-time SyntaxError; a missing FILE, by contrast, fails at import time with vite's "Failed to resolve import".

- [ ] **Step 1: Failing tests — module, zombie constant, topics section**

  Create `src/loop/digest.test.ts`. All seed helpers take explicit `created_at` values (ISO-8601 with millisecond `Z` — the same shape as the schema default) so the 24h-window and zombie-age assertions are deterministic no matter when the suite runs. Helpers for later cycles (`seedLibrary`, job seeding) are defined up front so every later step is a pure describe-append:

  ```ts
  import { afterEach, describe, expect, it, vi } from 'vitest'
  import type { Database } from 'better-sqlite3'
  import { openDb } from '../db/index.js'
  import { buildDigest, ZOMBIE_RUNNING_MS } from './digest.js'

  const HOUR_MS = 3_600_000
  const DAY_MS = 24 * HOUR_MS

  // Explicit timestamps in the schema default's own format ('...T...Z' with
  // millis) keep string comparisons against created_at meaningful.
  function isoAgo(ms: number): string {
    return new Date(Date.now() - ms).toISOString()
  }

  function seedJob(
    db: Database,
    opts: {
      id: string
      channel?: string
      tier?: 'volume' | 'premium'
      status?: 'queued' | 'running' | 'failed' | 'done' | 'blocked'
      createdAt?: string
    },
  ): void {
    db.prepare(
      'INSERT INTO jobs (id, channel, tier, topic, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      opts.id,
      opts.channel ?? 'chan-a',
      opts.tier ?? 'volume',
      'digest test topic',
      opts.status ?? 'done',
      opts.createdAt ?? isoAgo(HOUR_MS),
    )
  }

  // Library rows carry the ready/needs-review outcome for 'done' jobs — the
  // same insert shape the runner's library upsert writes.
  function seedLibrary(db: Database, jobId: string, state: 'ready' | 'needs-review'): void {
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, '/tmp/out.mp4', '{}', ?)",
    ).run(jobId, state)
  }

  function seedTopic(
    db: Database,
    opts: {
      dedupeHash: string
      channel?: string
      status?: 'candidate' | 'approved' | 'claimed' | 'used' | 'rejected'
      createdAt?: string
    },
  ): void {
    db.prepare(
      'INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status, created_at) ' +
        "VALUES (?, 'digest topic', 'raw', 'reddit:r/space', 'https://example.com', ?, 70, 'test', ?, ?)",
    ).run(
      opts.channel ?? 'chan-a',
      opts.dedupeHash,
      opts.status ?? 'candidate',
      opts.createdAt ?? isoAgo(HOUR_MS),
    )
  }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('buildDigest — topics section', () => {
    it('exports the 2h zombie constant', () => {
      expect(ZOMBIE_RUNNING_MS).toBe(7_200_000)
    })

    it('counts last-24h topics per channel by status, excluding older rows', () => {
      const db = openDb(':memory:')
      seedTopic(db, { dedupeHash: 'h1', status: 'candidate' })
      seedTopic(db, { dedupeHash: 'h2', status: 'candidate' })
      seedTopic(db, { dedupeHash: 'h3', status: 'approved' })
      seedTopic(db, { dedupeHash: 'h4', status: 'rejected' })
      // 3 days old — outside every reading of the 24h window
      seedTopic(db, { dedupeHash: 'h5', createdAt: isoAgo(3 * DAY_MS) })
      seedTopic(db, { channel: 'chan-b', dedupeHash: 'h6', status: 'rejected' })
      const digest = buildDigest(db, [])
      expect(digest).toContain('Topics (last 24h)')
      expect(digest).toContain('  chan-a: 4 scouted — 2 candidate, 1 approved, 1 rejected')
      expect(digest).toContain('  chan-b: 1 scouted — 0 candidate, 0 approved, 1 rejected')
      db.close()
    })

    it('prints none when no topics were scouted in the last 24h', () => {
      const db = openDb(':memory:')
      expect(buildDigest(db, [])).toContain('Topics (last 24h)\n  none')
      db.close()
    })
  })
  ```

- [ ] **Step 2: Run and observe the failure**

  ```bash
  pnpm vitest run src/loop/digest.test.ts
  ```

  Expected: the file fails to load — vite reports `Failed to resolve import "./digest.js" from "src/loop/digest.test.ts". Does the file exist?` (a missing FILE is an import-time resolution error; the undefined-named-export TypeError gotcha applies only once the file exists). 0 tests run.

- [ ] **Step 3: Implement the module with the topics section**

  Create `src/loop/digest.ts`:

  ```ts
  import type { Database } from 'better-sqlite3'
  import type { ChannelConfig } from '../config/channel.js'

  // A job 'running' longer than this has almost certainly lost its process —
  // real runs finish in minutes. Digest-only visibility: auto-resume never
  // touches running jobs; the operator resumes with --force.
  export const ZOMBIE_RUNNING_MS = 7_200_000 // 2 h

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
  export function buildDigest(db: Database, channels: ChannelConfig[]): string {
    const lines: string[] = []

    lines.push('Topics (last 24h)')
    const topicRows = db
      .prepare(
        `SELECT channel, COUNT(*) AS scouted,
                SUM(CASE WHEN status = 'candidate' THEN 1 ELSE 0 END) AS candidate,
                SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
                SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
         FROM topics WHERE datetime(created_at) >= datetime('now', '-1 day')
         GROUP BY channel ORDER BY channel`,
      )
      .all() as {
      channel: string
      scouted: number
      candidate: number
      approved: number
      rejected: number
    }[]
    if (topicRows.length === 0) lines.push('  none')
    for (const r of topicRows) {
      lines.push(
        `  ${r.channel}: ${r.scouted} scouted — ${r.candidate} candidate, ${r.approved} approved, ${r.rejected} rejected`,
      )
    }

    return lines.join('\n')
  }
  ```

  (`channels` is consumed in Step 11; `tsconfig.json` does not enable `noUnusedParameters`, so this intermediate state typechecks.)

- [ ] **Step 4: Run to green and commit**

  ```bash
  pnpm vitest run src/loop/digest.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  3 passed (3)`.

  ```bash
  git add src/loop/digest.ts src/loop/digest.test.ts
  git commit -m "$(cat <<'EOF'
  feat(digest): add buildDigest topics section and zombie constant

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 5: Failing tests — jobs section**

  Append at the end of `src/loop/digest.test.ts`:

  ```ts
  describe('buildDigest — jobs section', () => {
    it('counts last-24h jobs per channel and tier with library-resolved outcomes', () => {
      const db = openDb(':memory:')
      // chan-a volume: one ready (done + library row), one failed
      seedJob(db, { id: 'j-ready', status: 'done' })
      seedLibrary(db, 'j-ready', 'ready')
      seedJob(db, { id: 'j-failed', status: 'failed' })
      // chan-a premium: one needs-review, one blocked
      seedJob(db, { id: 'j-review', tier: 'premium', status: 'done' })
      seedLibrary(db, 'j-review', 'needs-review')
      seedJob(db, { id: 'j-blocked', tier: 'premium', status: 'blocked' })
      // 3 days old — outside the window, not counted here (it will surface in
      // the action-items section, which is current-state, not last-24h)
      seedJob(db, { id: 'j-old', status: 'failed', createdAt: isoAgo(3 * DAY_MS) })
      const digest = buildDigest(db, [])
      expect(digest).toContain('Jobs (last 24h)')
      expect(digest).toContain('  chan-a volume: 2 — 1 ready, 0 needs-review, 1 failed, 0 blocked')
      expect(digest).toContain('  chan-a premium: 2 — 0 ready, 1 needs-review, 0 failed, 1 blocked')
      db.close()
    })

    it('prints none when no jobs were created in the last 24h', () => {
      const db = openDb(':memory:')
      expect(buildDigest(db, [])).toContain('Jobs (last 24h)\n  none')
      db.close()
    })
  })
  ```

- [ ] **Step 6: Run and observe the failure**

  ```bash
  pnpm vitest run src/loop/digest.test.ts
  ```

  Expected: 3 pass, 2 fail — both new tests fail on the first assertion with `AssertionError: expected '...' to contain 'Jobs (last 24h)'` (buildDigest currently emits only the topics section).

- [ ] **Step 7: Implement the jobs section**

  In `src/loop/digest.ts`, insert directly ABOVE the final `return lines.join('\n')`:

  ```ts
    lines.push('', 'Jobs (last 24h)')
    // 'done' jobs resolve to ready/needs-review through their library row;
    // failed/blocked read straight off jobs.status. queued/running jobs count
    // toward the total but have no outcome yet.
    const jobRows = db
      .prepare(
        `SELECT j.channel, j.tier, COUNT(*) AS total,
                SUM(CASE WHEN l.state = 'ready' THEN 1 ELSE 0 END) AS ready,
                SUM(CASE WHEN l.state = 'needs-review' THEN 1 ELSE 0 END) AS needsReview,
                SUM(CASE WHEN j.status = 'failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN j.status = 'blocked' THEN 1 ELSE 0 END) AS blocked
         FROM jobs j LEFT JOIN library l ON l.job_id = j.id
         WHERE datetime(j.created_at) >= datetime('now', '-1 day')
         GROUP BY j.channel, j.tier ORDER BY j.channel, j.tier`,
      )
      .all() as {
      channel: string
      tier: string
      total: number
      ready: number
      needsReview: number
      failed: number
      blocked: number
    }[]
    if (jobRows.length === 0) lines.push('  none')
    for (const r of jobRows) {
      lines.push(
        `  ${r.channel} ${r.tier}: ${r.total} — ${r.ready} ready, ${r.needsReview} needs-review, ${r.failed} failed, ${r.blocked} blocked`,
      )
    }
  ```

- [ ] **Step 8: Run to green and commit**

  ```bash
  pnpm vitest run src/loop/digest.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  5 passed (5)`.

  ```bash
  git add src/loop/digest.ts src/loop/digest.test.ts
  git commit -m "$(cat <<'EOF'
  feat(digest): add last-24h jobs section with library outcomes

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 9: Failing test — spend section with $X.XX formatting**

  In `src/loop/digest.test.ts`, add the testkit import after the `openDb` import line:

  ```ts
  import { testChannel } from '../stages/_testkit.js'
  ```

  Append at the end of the file:

  ```ts
  describe('buildDigest — spend section', () => {
    it('formats channel and global day spend from integer micros as $X.XX', () => {
      vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', '10')
      const db = openDb(':memory:')
      const budget = {
        perVideoUsdMicros: 8_000_000,
        premiumPerVideoUsdMicros: 7_000_000,
        perDayUsdMicros: 20_000_000,
      }
      const chA = testChannel({ name: 'chan-a', budget })
      const chB = testChannel({ name: 'chan-b', budget })
      seedJob(db, { id: 'j-spend', status: 'done' })
      // costs.created_at defaults to now — today's UTC spend by construction.
      // (Only a sub-second UTC-midnight rollover could race this — accepted,
      // same caveat as the costs tests.)
      db.prepare(
        "INSERT INTO costs (job_id, provider, operation, usd_micros) VALUES ('j-spend', 'anthropic', 'script', ?)",
      ).run(1_234_567)
      // Sentinel scout row: no jobs row behind it, so it is invisible to the
      // channel JOIN but counts toward the global sum.
      db.prepare(
        "INSERT INTO costs (job_id, provider, operation, usd_micros) VALUES ('scout:chan-a', 'anthropic', 'scout-score', ?)",
      ).run(20_000)
      const digest = buildDigest(db, [chA, chB])
      expect(digest).toContain('Spend today (UTC)')
      // 1_234_567 micros → $1.23 (toFixed(2)); cap 20_000_000 → $20.00
      expect(digest).toContain('  chan-a: $1.23 of $20.00')
      expect(digest).toContain('  chan-b: $0.00 of $20.00')
      // global: 1_234_567 + 20_000 = 1_254_567 → $1.25 vs the stubbed $10 cap
      expect(digest).toContain('  global: $1.25 of $10.00')
      db.close()
    })
  })
  ```

- [ ] **Step 10: Run and observe the failure**

  ```bash
  pnpm vitest run src/loop/digest.test.ts
  ```

  Expected: 5 pass, 1 fail — `AssertionError: expected '...' to contain 'Spend today (UTC)'`.

- [ ] **Step 11: Implement the spend section**

  In `src/loop/digest.ts`, extend the imports:

  ```ts
  import {
    channelDaySpentMicros,
    globalDailyCapMicros,
    globalDaySpentMicros,
  } from '../jobs/costs.js'
  ```

  Insert directly below the `ZOMBIE_RUNNING_MS` declaration:

  ```ts
  // Display-only conversion — everything upstream stays integer micro-USD.
  function usd(micros: number): string {
    return `$${(micros / 1e6).toFixed(2)}`
  }
  ```

  Insert directly ABOVE the final `return lines.join('\n')`:

  ```ts
    lines.push('', 'Spend today (UTC)')
    for (const channel of channels) {
      lines.push(
        `  ${channel.name}: ${usd(channelDaySpentMicros(db, channel.name))} of ${usd(channel.budget.perDayUsdMicros)}`,
      )
    }
    lines.push(`  global: ${usd(globalDaySpentMicros(db))} of ${usd(globalDailyCapMicros())}`)
  ```

- [ ] **Step 12: Run to green and commit**

  ```bash
  pnpm vitest run src/loop/digest.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  6 passed (6)`.

  ```bash
  git add src/loop/digest.ts src/loop/digest.test.ts
  git commit -m "$(cat <<'EOF'
  feat(digest): add UTC day spend section with dollar formatting

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 13: Failing tests — action items and section order**

  Append at the end of `src/loop/digest.test.ts`:

  ```ts
  describe('buildDigest — action items', () => {
    it('lists failed jobs and flags running jobs older than the zombie threshold', () => {
      const db = openDb(':memory:')
      seedJob(db, { id: 'j-dead', tier: 'premium', status: 'failed' })
      // 3h-old running job: past ZOMBIE_RUNNING_MS (2h) — flagged
      seedJob(db, { id: 'j-zombie', status: 'running', createdAt: isoAgo(3 * HOUR_MS) })
      // 1h-old running job: healthy — must NOT be flagged
      seedJob(db, { id: 'j-live', status: 'running', createdAt: isoAgo(HOUR_MS) })
      const digest = buildDigest(db, [])
      expect(digest).toContain('Action items')
      expect(digest).toContain('  failed job j-dead (chan-a, premium) — resume manually')
      expect(digest).toContain(
        '  running job j-zombie (chan-a, volume) running > 2h — probably crashed — resume with --force',
      )
      expect(digest).not.toContain('j-live')
      db.close()
    })

    it('reports approved and candidate queue depths per channel', () => {
      const db = openDb(':memory:')
      seedTopic(db, { dedupeHash: 'h1', status: 'approved' })
      seedTopic(db, { dedupeHash: 'h2', status: 'approved' })
      seedTopic(db, { dedupeHash: 'h3', status: 'candidate' })
      seedTopic(db, { channel: 'chan-b', dedupeHash: 'h4', status: 'candidate' })
      // claimed/used topics are neither queued nor awaiting approval
      seedTopic(db, { dedupeHash: 'h5', status: 'used' })
      const digest = buildDigest(db, [])
      expect(digest).toContain('  chan-a: 2 approved premium topics queued')
      expect(digest).toContain('  chan-a: 1 candidate topics awaiting approval')
      expect(digest).toContain('  chan-b: 1 candidate topics awaiting approval')
      db.close()
    })

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

- [ ] **Step 14: Run and observe the failure**

  ```bash
  pnpm vitest run src/loop/digest.test.ts
  ```

  Expected: 6 pass, 4 fail. The three action-items tests fail with `AssertionError: expected '...' to contain 'Action items'` (and the queue-depth variants); the order test fails on `expected false to be true` — `digest.indexOf('Action items')` is -1.

- [ ] **Step 15: Implement the action-items section**

  In `src/loop/digest.ts`, insert directly ABOVE the final `return lines.join('\n')`:

  ```ts
    lines.push('', 'Action items')
    const sectionStart = lines.length
    // Current state, not last-24h: a failed job awaits manual resume until the
    // operator acts, however old it is.
    const failedJobs = db
      .prepare("SELECT id, channel, tier FROM jobs WHERE status = 'failed' ORDER BY created_at ASC")
      .all() as { id: string; channel: string; tier: string }[]
    for (const j of failedJobs) {
      lines.push(`  failed job ${j.id} (${j.channel}, ${j.tier}) — resume manually`)
    }
    // Both sides are ISO-8601 UTC with millisecond 'Z' (schema default shape),
    // so a lexicographic compare is a time compare.
    const zombieCutoff = new Date(Date.now() - ZOMBIE_RUNNING_MS).toISOString()
    const zombies = db
      .prepare(
        "SELECT id, channel, tier FROM jobs WHERE status = 'running' AND created_at <= ? ORDER BY created_at ASC",
      )
      .all(zombieCutoff) as { id: string; channel: string; tier: string }[]
    for (const j of zombies) {
      lines.push(
        `  running job ${j.id} (${j.channel}, ${j.tier}) running > ${ZOMBIE_RUNNING_MS / 3_600_000}h — probably crashed — resume with --force`,
      )
    }
    const approvedDepth = db
      .prepare(
        "SELECT channel, COUNT(*) AS n FROM topics WHERE status = 'approved' GROUP BY channel ORDER BY channel",
      )
      .all() as { channel: string; n: number }[]
    for (const r of approvedDepth) {
      lines.push(`  ${r.channel}: ${r.n} approved premium topics queued`)
    }
    const candidateDepth = db
      .prepare(
        "SELECT channel, COUNT(*) AS n FROM topics WHERE status = 'candidate' GROUP BY channel ORDER BY channel",
      )
      .all() as { channel: string; n: number }[]
    for (const r of candidateDepth) {
      lines.push(`  ${r.channel}: ${r.n} candidate topics awaiting approval`)
    }
    if (lines.length === sectionStart) lines.push('  none')
  ```

- [ ] **Step 16: Run to green and commit**

  ```bash
  pnpm vitest run src/loop/digest.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  10 passed (10)`.

  ```bash
  git add src/loop/digest.ts src/loop/digest.test.ts
  git commit -m "$(cat <<'EOF'
  feat(digest): add action-items section with zombie and queue flags

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 17: Failing CLI tests — `digest` command**

  In `src/cli.test.ts`, append inside the `describe('brainrot CLI', ...)` block, after the last existing test (`tmpDbPath`, `cleanup`, `execa`, `mkdtempSync`, `tmpdir`, and `path` all already exist in this file; an EMPTY channels dir exercises the full command without any TOML fixture — `loadChannelsDir` returns `[]`):

  ```ts
    it('`digest --help` prints usage with --db/--channels-dir', async () => {
      const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'digest', '--help'], {
        reject: false,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--db')
      expect(result.stdout).toContain('--channels-dir')
    }, 60000)

    it('`digest` over an empty channels dir prints all four sections and exits 0', async () => {
      const dbPath = tmpDbPath()
      const channelsDir = mkdtempSync(path.join(tmpdir(), 'brainrot-digest-channels-'))
      cleanup.push(channelsDir)
      const result = await execa(
        'pnpm',
        ['exec', 'tsx', 'src/cli.ts', 'digest', '--db', dbPath, '--channels-dir', channelsDir],
        { reject: false },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Topics (last 24h)')
      expect(result.stdout).toContain('Jobs (last 24h)')
      expect(result.stdout).toContain('Spend today (UTC)')
      expect(result.stdout).toContain('Action items')
    }, 60000)

    it('`digest` with a missing channels dir still exits 0 (report, not check)', async () => {
      const dbPath = tmpDbPath()
      const result = await execa(
        'pnpm',
        ['exec', 'tsx', 'src/cli.ts', 'digest',
          '--db', dbPath, '--channels-dir', '/no/such/channels-dir'],
        { reject: false },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toMatch(/ENOENT|no such/)
    }, 60000)
  ```

- [ ] **Step 18: Run and observe the failure**

  ```bash
  pnpm vitest run src/cli.test.ts
  ```

  Expected: every pre-existing test passes; all 3 new tests fail on their `expect(result.exitCode).toBe(0)` — commander does not know the command yet, so each subprocess prints `error: unknown command 'digest'` on stderr and exits 1.

- [ ] **Step 19: Wire the `digest` CLI command**

  In `src/cli.ts`, add the digest import next to the other loop imports (Task 11 already imports from `./loop/produce-next.js`; `loadChannelsDir` is already imported from `./config/channel.js` since Task 7):

  ```ts
  import { buildDigest } from './loop/digest.js'
  ```

  Add the command after the `topics` command blocks (Task 12), before the `isMain` computation:

  ```ts
  program
    .command('digest')
    .option('--db <path>', 'sqlite db path')
    .option('--channels-dir <dir>', 'channel TOML directory', 'channels')
    .action((opts: { db?: string; channelsDir: string }) => {
      // A report, not a check: nothing here may set a non-zero exit — cron
      // MAILTO should deliver whatever printed, so even a config/db error is
      // reported on stderr and the process still exits 0.
      try {
        const channels = loadChannelsDir(opts.channelsDir)
        const db = openDb(resolveDbPath(opts.db))
        try {
          process.stdout.write(buildDigest(db, channels) + '\n')
        } finally {
          db.close()
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
      }
    })
  ```

- [ ] **Step 20: Run the CLI tests to green**

  ```bash
  pnpm vitest run src/cli.test.ts
  ```

  Expected: `Test Files  1 passed (1)` with every test passing — the 3 new digest tests plus all tests accumulated through Task 12 (the exact total depends on Tasks 9–12's additions; do not pin a count, pin zero failures).

- [ ] **Step 21: Whole-suite and typecheck gates**

  ```bash
  pnpm vitest run
  ```

  Expected: all test files pass (contract tests stay excluded unless `CONTRACT=1`).

  ```bash
  pnpm tsc --noEmit
  ```

  Expected: no output, exit 0.

- [ ] **Step 22: Final commit**

  ```bash
  git add src/cli.ts src/cli.test.ts
  git commit -m "$(cat <<'EOF'
  feat: add brainrot digest CLI command

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```


### Task 14: README cron docs + golden-path loop test

**Files:**
- Create: `src/jobs/golden-path-loop.test.ts`
- Modify: `README.md`
- Test: `src/jobs/golden-path-loop.test.ts`

**Interfaces:**

Consumes (exact signatures from lower-numbered tasks and existing code — all of Tasks 1–13 are complete before this task starts):

```ts
// Task 1 — src/scout/topics.ts
export type TopicStatus = 'candidate' | 'approved' | 'claimed' | 'used' | 'rejected'
export interface TopicRow {
  id: number; channel: string; title: string; rawTitle: string; source: string;
  url: string; dedupeHash: string; score: number; reason: string;
  status: TopicStatus; jobId: string | null; createdAt: string
}
export function listTopics(db: Database, filter?: { channel?: string; status?: TopicStatus }): TopicRow[]

// Task 2 — src/config/channel.ts
export function loadChannelsDir(dir: string): ChannelConfig[]  // all <dir>/*.toml, sorted by channel name
// ChannelConfig.scout: ScoutConfig parsed from the [scout] TOML table

// Task 3 — src/scout/sources/types.ts
export type FetchLike = typeof globalThis.fetch

// Task 7 — src/scout/scout.ts
export interface ScoutChannelResult {
  channel: string; fetched: number; alreadyKnown: number; scored: number;
  queued: number; rejected: number; sourceErrors: string[]; costUsdMicros: number;
  scoringError?: string
}
export async function scoutChannel(db: Database, channel: ChannelConfig, opts?: {
  client?: Anthropic; fetchImpl?: FetchLike;
}): Promise<ScoutChannelResult>

// Task 11 — src/loop/produce-next.ts
export interface TickResult {
  action: 'resumed' | 'produced' | 'noop'
  reason?: 'lease-held' | 'no-eligible-work' | 'no-fal-key'
  jobId?: string; topicId?: number; tier?: Tier; status?: JobResult['status']
}
export async function produceNextTick(db: Database, opts: {
  channelsDir: string; runsRoot: string;
  stagesFor?: (tier: Tier) => StageDef[];   // test seam; default stagesForTier
}): Promise<TickResult>

// Existing — src/db/index.ts
export function openDb(dbPath: string): Database

// Existing — src/jobs/types.ts
export const STAGE_ORDER: StageName[]   // ['script','voice','captions','visuals','assemble','qc']
export type Tier = 'volume' | 'premium'
export interface StageDef { name: StageName; run(ctx: JobContext): Promise<void> }
export interface JobContext { /* ...artifactPath(stage, file): string... */ }
```

Produces: nothing consumed by later tasks (this is the terminal task). Deliverables are the loop e2e test and the README `## Automation (cron)` section.

**runJob final-gate requirements (discovered from `src/jobs/runner.ts` lines 126–168 and `runner.test.ts` `buildStages`) — the injected fake stages must satisfy all of these or the job never lands in the library:**

1. `<runsRoot>/<jobId>/qc/qc.json` must exist and parse as JSON with a boolean `passed`. Missing or corrupt → the final gate catches, marks the job `'failed'`, writes NO library row (runner.test.ts "final gate: missing qc.json" / "corrupt qc.json" prove this). `passed: true` → library `state 'ready'`; `false` → `'needs-review'`. Both are "library-landed", which is what flips the claimed topic to `'used'`.
2. `<runsRoot>/<jobId>/script/script.json`, IF present, must parse as JSON (corrupt → `'failed'`); its `platformMeta` becomes `library.metadata_json` (absent file → `'{}'`).
3. `<runsRoot>/<jobId>/assemble/final.mp4` existing makes `JobResult.videoPath` defined (its absence does not change status).

The fake stages below mirror `buildStages` in `runner.test.ts`: script writes a real `script.json`, assemble writes a `FAKEMP4` marker, qc writes `{ passed: true, checks: [] }`, every other stage drops a marker `.txt`.

**A note on TDD for this task:** the loop e2e test adds no implementation — it is an integration verification over Tasks 1–13, so its first run is expected GREEN. There is no honest failing-test step to write for it. If it comes up red, that is an integration defect in a predecessor task (per the house gotcha, a missing named export from Tasks 1–13 surfaces as a runtime `TypeError: X is not a function`, not an import-time SyntaxError) — stop and debug the predecessor; do NOT weaken assertions. The README half uses a grep as its red/green cycle.

Run every command from the repo root `/Users/alex/code/project-brainrot`.

- [ ] **Step 1: Write the golden-path loop e2e test**

  Create `src/jobs/golden-path-loop.test.ts` (full file):

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

  // Reddit hot.json fixture: exactly the fields redditSource reads. One post
  // scores above the channel threshold, one below.
  const REDDIT_HOT_JSON = JSON.stringify({
    data: {
      children: [
        {
          kind: 't3',
          data: {
            name: 't3_moon',
            title: 'Moon drifting away measured precisely',
            permalink: '/r/space/comments/t3_moon/',
            stickied: false,
          },
        },
        {
          kind: 't3',
          data: {
            name: 't3_ad',
            title: 'Buy my telescope (ad)',
            permalink: '/r/space/comments/t3_ad/',
            stickied: false,
          },
        },
      ],
    },
  })

  // Serves only r/space's hot.json; any other URL is a test bug, never a
  // silent live-network hit.
  const fetchImpl: FetchLike = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/r/space/hot.json')) {
      return new Response(REDDIT_HOT_JSON, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
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

      // Real channel TOML incl. [scout] — the same file scoutChannel (loaded
      // via loadChannelsDir here) and produceNextTick (via opts.channelsDir)
      // read. bg/bgm dirs are schema-required strings; fake stages never read
      // them.
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

- [ ] **Step 2: Run the loop e2e — expect green**

  Run `pnpm vitest run src/jobs/golden-path-loop.test.ts`.

  Expected: `Test Files  1 passed (1)`, `Tests  1 passed (1)` (pure in-process: no network, no ffmpeg, no Remotion — finishes in a few seconds).

  This is a verification test over Tasks 1–13; green on first run is the expected outcome. If it is red, the failure is an integration defect in a predecessor, not a reason to adjust assertions. Typical modes: `TypeError: produceNextTick is not a function` (Task 11 export missing — esbuild resolves missing named exports to `undefined` at runtime), a `toEqual` mismatch on the second-tick noop (Task 10/11 claim-pass eligibility bug), `status: 'failed'` with a stage-row dump from the triage throw (fake-stage artifact not satisfying the final gate — recheck against the gate requirements documented above), or a `{ n: 1 }` leases mismatch (Task 11 lease not released in `finally`). Debug the responsible module; do not edit this test to pass.

- [ ] **Step 3: Commit the loop e2e test**

  ```bash
  git add src/jobs/golden-path-loop.test.ts
  git commit -m "$(cat <<'EOF'
  test: add golden-path loop e2e from scout fixtures to library

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 4: README red — prove the Automation section is absent**

  Run:

  ```bash
  grep -n '## Automation (cron)' README.md
  ```

  Expected failure: no output, exit code 1 — the section does not exist yet.

- [ ] **Step 5: Add the `## Automation (cron)` section to README.md**

  Edit `README.md`: replace the line `## Tests` (unique in the file, currently directly after the `## Inspect` section's code block) with the following content — the new section followed by the original `## Tests` heading. Insert verbatim:

  ````markdown
  ## Automation (cron)

  The production loop is three cron-invoked commands: `scout` fills the topic
  queue, `produce-next` performs one unit of work per tick (resume one blocked
  job or produce one video), and `digest` prints a daily report. Paste into
  `crontab -e`, adjusting the paths:

  ```cron
  # cron runs with a bare PATH (/usr/bin:/bin): pnpm, node, and ffmpeg do not
  # resolve without this line. Find your dirs with `which pnpm` / `which ffmpeg`.
  PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin

  # Digest delivery is operator wiring: cron mails each job's output to MAILTO
  # (needs working local mail), or replace the digest line with a pipe into
  # your notifier of choice.
  MAILTO=you@example.com

  # Scout trends into the topic queue, 3x/day at 07:00 / 12:00 / 17:00.
  0 7,12,17 * * * cd /Users/alex/code/project-brainrot && pnpm brainrot scout >> logs/scout.log 2>&1

  # One unit of production per tick (*/25 fires at :00, :25 and :50 each hour).
  */25 * * * * cd /Users/alex/code/project-brainrot && pnpm brainrot produce-next >> logs/produce-next.log 2>&1

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
    A `{"action":"noop","reason":"lease-held"}` tick is normal while a long
    render from the previous firing is still running.

  ## Tests
  ````

- [ ] **Step 6: README green — section present, documented commands exist**

  Run:

  ```bash
  grep -n '## Automation (cron)' README.md
  ```

  Expected: one line of output with the heading's line number, exit code 0.

  Then verify every command the crontab references actually exists (each must exit 0 and print usage):

  ```bash
  pnpm brainrot scout --help
  pnpm brainrot produce-next --help
  pnpm brainrot digest --help
  ```

  Expected: each prints its usage block (with `--db` and, for scout/produce-next, `--channels-dir`) and exits 0. A commander `error: unknown command` here means a predecessor CLI task did not land — stop and debug there.

- [ ] **Step 7: Whole-suite gate**

  Run `pnpm vitest run`.

  Expected: every test file passes, zero failures (contract tests stay excluded — `CONTRACT` unset; the two pre-existing golden-path files run real ffmpeg/Remotion and take minutes — that is normal).

- [ ] **Step 8: Typecheck gate**

  Run `pnpm tsc --noEmit`.

  Expected: no output, exit code 0.

- [ ] **Step 9: Final commit — README**

  ```bash
  git add README.md
  git commit -m "$(cat <<'EOF'
  docs: add cron automation section to README

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

