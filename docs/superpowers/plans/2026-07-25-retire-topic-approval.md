# Retire the vestigial topic approval gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the `'approved'` topic status, `approveTopics`, and the `topics approve` CLI command — dead surface left over from the removed premium/volume tier — and stop the digest from reporting a manual-approval step that no longer exists.

**Architecture:** Pure deletion/narrowing across four files that share the `topics` table's status lifecycle: the schema's `CHECK` constraint, the DAO (`src/scout/topics.ts`), the CLI (`src/cli.ts`), and the operator digest (`src/loop/digest.ts`). No new behavior — `eligibleTopic`/`claimTopic` already treat `'candidate'` and `'approved'` identically, so narrowing them to `'candidate'` only changes zero externally observable outcomes for real data (the live db has zero `'approved'` rows today).

**Tech Stack:** TypeScript, better-sqlite3, vitest, commander (CLI).

## Global Constraints

- No migration framework — schema changes in `src/db/schema.sql` are `CREATE TABLE IF NOT EXISTS`, applied fresh on every `openDb` call. No data migration step is needed here: the live db has zero `'approved'` rows (verified via `sqlite3 data/brainrot.db "SELECT status, COUNT(*) FROM topics GROUP BY status"` → `candidate|36`, `rejected|23`, `used|1`).
- `topics reject <ids...>` and the `'rejected'` status are unaffected — they have a real current effect (removing a topic from ever being claimed) and stay exactly as-is.
- Do not touch `docs/superpowers/plans/2026-07-20-trend-scout-loop.md` or `docs/superpowers/specs/2026-07-24-live-automation-design.md` — historical records of an already-superseded design.
- Do not touch `approveLibrary`/`library approve` in `src/jobs/library.ts` / `src/cli.ts` — a completely separate `needs-review → ready` gate, unrelated to topics.
- Reference spec: `docs/superpowers/specs/2026-07-25-retire-topic-approval-design.md`.

---

### Task 1: Narrow the topics DAO and schema

**Files:**
- Modify: `src/db/schema.sql:35`
- Modify: `src/scout/topics.ts:3`, `src/scout/topics.ts:131-152`, `src/scout/topics.ts:154-164`, `src/scout/topics.ts:238-246`
- Test: `src/scout/topics.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `TopicStatus = 'candidate' | 'claimed' | 'used' | 'rejected'` (was 5 members, now 4). `approveTopics` no longer exists — Task 2 (CLI) and Task 3 (digest) must not reference it after this task lands. `rejectTopics`, `claimTopic`, `eligibleTopic` keep their existing signatures; only their internal SQL narrows.

- [ ] **Step 1: Narrow the schema CHECK constraint**

Edit `src/db/schema.sql:35`:

```sql
-- before
    CHECK (status IN ('candidate','approved','claimed','used','rejected')),
-- after
    CHECK (status IN ('candidate','claimed','used','rejected')),
```

- [ ] **Step 2: Narrow the DAO**

In `src/scout/topics.ts`, line 3:

```ts
// before
export type TopicStatus = 'candidate' | 'approved' | 'claimed' | 'used' | 'rejected'
// after
export type TopicStatus = 'candidate' | 'claimed' | 'used' | 'rejected'
```

Replace the block at lines 131-152 (the comment plus `approveTopics` plus `rejectTopics`):

```ts
// before
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

```ts
// after
// Operator veto. The status guard in the WHERE clause makes this idempotent
// and blind to ids in the wrong state — the returned count is what actually
// changed, which the CLI reports against ids.length.
export function rejectTopics(db: Database, ids: number[]): number {
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(', ')
  return db
    .prepare(
      `UPDATE topics SET status = 'rejected' WHERE id IN (${placeholders}) AND status = 'candidate'`,
    )
    .run(...ids).changes
}
```

In `claimTopic` (line 160):

```ts
// before
      "UPDATE topics SET status = 'claimed', job_id = ? WHERE id = ? AND status IN ('candidate','approved')",
// after
      "UPDATE topics SET status = 'claimed', job_id = ? WHERE id = ? AND status = 'candidate'",
```

In `eligibleTopic` (line 241):

```ts
// before
      `SELECT ${TOPIC_COLUMNS} FROM topics WHERE channel = ? AND status IN ('candidate', 'approved') ` +
// after
      `SELECT ${TOPIC_COLUMNS} FROM topics WHERE channel = ? AND status = 'candidate' ` +
```

- [ ] **Step 3: Run the test suite and confirm the expected breakages**

Run: `pnpm vitest run src/scout/topics.test.ts`
Expected: FAIL — `approveTopics is not exported`/`is not a function` from the `approveTopics / rejectTopics` describe block, plus CHECK-constraint failures (`SQLITE_CONSTRAINT`) from every `seedTopic(db, { status: 'approved', ... })` fixture (used by the `recentTopicTitles`, `claimTopic`, `listTopics`, and `eligibleTopic` describes).

- [ ] **Step 4: Update the test file to match**

In `src/scout/topics.test.ts`, remove `approveTopics` from the import list (line 5):

```ts
// before
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
  requeueTopic,
} from './topics.js'
// after
import {
  claimTopic,
  eligibleTopic,
  insertTopics,
  knownHashes,
  listTopics,
  markTopicUsedByJob,
  RECENT_TITLES_LIMIT,
  recentTopicTitles,
  rejectTopics,
  requeueTopic,
} from './topics.js'
```

Add a regression check to the existing `'rejects a status outside the lifecycle CHECK'` test (lines 103-107) so the narrowing itself is pinned:

```ts
// before
  it('rejects a status outside the lifecycle CHECK', () => {
    const db = openDb(':memory:')
    expect(() => seedTopic(db, { status: 'simmering' })).toThrow(/CHECK/)
    db.close()
  })
// after
  it('rejects a status outside the lifecycle CHECK', () => {
    const db = openDb(':memory:')
    expect(() => seedTopic(db, { status: 'simmering' })).toThrow(/CHECK/)
    // 'approved' was a valid status under the old premium-tier lifecycle;
    // it is no longer part of the CHECK.
    expect(() => seedTopic(db, { status: 'approved' })).toThrow(/CHECK/)
    db.close()
  })
```

In the `recentTopicTitles` describe (line 169), swap the `'approved'` fixture for `'claimed'` — the test only needs a second non-rejected status to prove the exclusion is `status != 'rejected'`, not specifically `'approved'`:

```ts
// before
    seedTopic(db, { title: 'newest', createdAt: '2026-07-20T00:00:00.000Z', status: 'approved' })
// after
    seedTopic(db, { title: 'newest', createdAt: '2026-07-20T00:00:00.000Z', status: 'claimed' })
```

Replace the whole `describe('approveTopics / rejectTopics', ...)` block (lines 187-228) with a `rejectTopics`-only block:

```ts
// before
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
// after
describe('rejectTopics', () => {
  it('reject flips candidate only, leaves claimed/used alone, and reports the changed count', () => {
    const db = openDb(':memory:')
    const a = seedTopic(db) // candidate
    const b = seedTopic(db, { status: 'claimed', jobId: 'job-1' })
    const c = seedTopic(db, { status: 'used' })
    // b and c are not candidates and 9999 does not exist: all silently skipped
    expect(rejectTopics(db, [a, b, c, 9999])).toBe(1)
    const statuses = db.prepare('SELECT id, status FROM topics ORDER BY id').all() as {
      id: number
      status: string
    }[]
    expect(statuses).toEqual([
      { id: a, status: 'rejected' },
      { id: b, status: 'claimed' },
      { id: c, status: 'used' },
    ])
    expect(rejectTopics(db, [])).toBe(0)
    db.close()
  })
})
```

In the `claimTopic / markTopicUsedByJob` describe (line 233), drop the now-invalid `'approved'` fixture:

```ts
// before
  it('claim binds the topic to its job and reports success', () => {
    const db = openDb(':memory:')
    const id = seedTopic(db, { status: 'approved' })
// after
  it('claim binds the topic to its job and reports success', () => {
    const db = openDb(':memory:')
    const id = seedTopic(db) // candidate
```

In the `listTopics` describe's `'filters by channel and status independently'` test (lines 412-421):

```ts
// before
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
// after
  it('filters by channel and status independently', () => {
    const db = openDb(':memory:')
    seedTopic(db, { channel: 'chan-a', status: 'candidate' })
    seedTopic(db, { channel: 'chan-a', status: 'claimed', jobId: 'job-1' })
    seedTopic(db, { channel: 'chan-b', status: 'claimed', jobId: 'job-2' })
    expect(listTopics(db, { channel: 'chan-a' })).toHaveLength(2)
    expect(listTopics(db, { status: 'claimed' })).toHaveLength(2)
    expect(listTopics(db, { channel: 'chan-a', status: 'claimed' })).toHaveLength(1)
    db.close()
  })
```

In the `eligibleTopic` describe (lines 425-435):

```ts
// before
  it('takes candidate or approved, highest score first', () => {
    const db = openDb(':memory:')
    seedTopic(db, { score: 70, status: 'candidate', title: 'runner-up' })
    seedTopic(db, { score: 90, status: 'approved', title: 'winner' })
    seedTopic(db, { score: 95, status: 'rejected', title: 'rejected' })
    seedTopic(db, { score: 99, status: 'used', title: 'used' })
    seedTopic(db, { score: 99, status: 'claimed', title: 'claimed', jobId: 'job-1' })
    const pick = eligibleTopic(db, 'chan-a')
    expect(pick?.title).toBe('winner')
    db.close()
  })
// after
  it('takes only candidate, highest score first, ignoring every other status', () => {
    const db = openDb(':memory:')
    seedTopic(db, { score: 70, status: 'candidate', title: 'winner' })
    seedTopic(db, { score: 95, status: 'rejected', title: 'rejected' })
    seedTopic(db, { score: 99, status: 'used', title: 'used' })
    seedTopic(db, { score: 99, status: 'claimed', title: 'claimed', jobId: 'job-1' })
    const pick = eligibleTopic(db, 'chan-a')
    expect(pick?.title).toBe('winner')
    db.close()
  })
```

- [ ] **Step 5: Run the test suite and confirm it passes**

Run: `pnpm vitest run src/scout/topics.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 6: Type-check and commit**

Run: `pnpm build`
Expected: no errors (this also confirms no other file still imports `approveTopics` — if it did, this task's Step 6 would fail; Tasks 2 and 3 fix those call sites next).

```bash
git add src/db/schema.sql src/scout/topics.ts src/scout/topics.test.ts
git commit -m "$(cat <<'EOF'
feat: retire the approved topic status

approveTopics/claimTopic/eligibleTopic treated 'candidate' and 'approved'
identically, so approval never gated production after the premium/volume
tier that introduced it was removed. Narrow the lifecycle to candidate/
claimed/used/rejected; reject stays as the only operator veto.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Remove the `topics approve` CLI command

**Files:**
- Modify: `src/cli.ts:15`, `src/cli.ts:25-30`, `src/cli.ts:281-303`, `src/cli.ts:309-310`
- Test: `src/cli.test.ts:221-230`

**Interfaces:**
- Consumes: `rejectTopics`, `listTopics`, `requeueTopic` from `src/scout/topics.js` (unchanged signatures from Task 1). Does NOT import `approveTopics` (deleted in Task 1).
- Produces: `topics --help` output listing only `list`, `reject`, `requeue`.

- [ ] **Step 1: Run the CLI test to see it fail on the stale help assertion**

(This step assumes Task 1 has already landed, so `approveTopics` no longer exists — `pnpm build` would already be failing on `src/cli.ts`'s import. If running Task 2 immediately after Task 1, skip straight to Step 2.)

Run: `pnpm build`
Expected: FAIL — `src/cli.ts(15,3): error TS2305: Module '"./scout/topics.js"' has no exported member 'approveTopics'.`

- [ ] **Step 2: Delete the CLI command and its import**

In `src/cli.ts`, line 15:

```ts
// before
import { approveTopics, listTopics, rejectTopics, requeueTopic } from './scout/topics.js'
// after
import { listTopics, rejectTopics, requeueTopic } from './scout/topics.js'
```

Lines 25-30, update the doc comment (it documents `parseTopicIds`, shared by reject and requeue):

```ts
// before
/**
 * Validate `topics approve/reject` id arguments. Throws naming the FIRST bad
 * token, BEFORE any db handle exists, so one typo means exit 1 with no writes.
 * Canonical positive decimal integers only — "0", "-3", "12abc" all reject.
 * Exported so cli.test.ts can assert it in-process.
 */
// after
/**
 * Validate `topics reject`/`requeue` id arguments. Throws naming the FIRST bad
 * token, BEFORE any db handle exists, so one typo means exit 1 with no writes.
 * Canonical positive decimal integers only — "0", "-3", "12abc" all reject.
 * Exported so cli.test.ts can assert it in-process.
 */
```

Delete the `topics approve` command block (currently lines 281-292) entirely:

```ts
// delete this whole block
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

```

Update the comment on the `reject` command (now line ~294):

```ts
// before
    const changed = rejectTopics(db, ids)
    // reject takes candidate AND approved; claimed/used rows are skipped.
    console.log(`rejected ${changed} of ${ids.length}`)
// after
    const changed = rejectTopics(db, ids)
    // reject takes candidate only; claimed/used rows are skipped.
    console.log(`rejected ${changed} of ${ids.length}`)
```

Update the comment above `requeue` (now a few lines down):

```ts
// before
    // Same pre-db id validation as approve/reject: a bad token throws to the
    // parseAsync .catch (message on stderr, exit 1) with no writes.
// after
    // Same pre-db id validation as reject: a bad token throws to the
    // parseAsync .catch (message on stderr, exit 1) with no writes.
```

- [ ] **Step 3: Update the CLI test**

In `src/cli.test.ts`, lines 221-230:

```ts
// before
  it('`topics --help` lists the list/approve/reject/requeue subcommands', async () => {
    const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'topics', '--help'], {
      reject: false,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('list')
    expect(result.stdout).toContain('approve')
    expect(result.stdout).toContain('reject')
    expect(result.stdout).toContain('requeue')
  }, 60000)
// after
  it('`topics --help` lists the list/reject/requeue subcommands', async () => {
    const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'topics', '--help'], {
      reject: false,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('list')
    expect(result.stdout).toContain('reject')
    expect(result.stdout).toContain('requeue')
    expect(result.stdout).not.toContain('approve')
  }, 60000)
```

- [ ] **Step 4: Build and run the CLI test suite**

Run: `pnpm build && pnpm vitest run src/cli.test.ts`
Expected: PASS — type-check clean, all `cli.test.ts` tests green.

- [ ] **Step 5: Update CLAUDE.md's command list**

In `CLAUDE.md`, the `## Commands` section:

```
// before
pnpm brainrot topics list|approve|reject <ids...>
pnpm brainrot topics requeue <id>   # orphaned 'claimed' topic -> 'candidate'; refuses while a live job holds it
```

```
// after
pnpm brainrot topics list|reject <ids...>
pnpm brainrot topics requeue <id>   # orphaned 'claimed' topic -> 'candidate'; refuses while a live job holds it
```

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/cli.test.ts CLAUDE.md
git commit -m "$(cat <<'EOF'
feat: remove the topics approve CLI command

approveTopics was deleted in the DAO (previous commit) — its only caller
was this command, which never actually gated production. Drop the command
and the doc references to it.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Stop the digest reporting an approval step that doesn't exist

**Files:**
- Modify: `src/loop/digest.ts:97-120` (topics summary), `src/loop/digest.ts:353-368` (action items)
- Test: `src/loop/digest.test.ts:123` (seedTopic type), `src/loop/digest.test.ts:198-212`, `src/loop/digest.test.ts:314-327`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildDigest()`'s `Topics (last 24h)` line drops the `approved` column (`N scouted — N candidate, N rejected`); the `Action items` section no longer emits `"N approved topics queued"` or `"N candidate topics awaiting approval"` lines.

- [ ] **Step 1: Run the digest test file to see the current baseline pass**

Run: `pnpm vitest run src/loop/digest.test.ts`
Expected: PASS (digest.ts hasn't changed yet — this just confirms the starting point before editing).

- [ ] **Step 2: Drop the `approved` column from the topics summary**

In `src/loop/digest.ts`, lines 98-119:

```ts
// before
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
  const topicsStart = lines.length
  for (const r of topicRows) {
    lines.push(
      `  ${r.channel}: ${r.scouted} scouted — ${r.candidate} candidate, ${r.approved} approved, ${r.rejected} rejected`,
    )
  }
// after
  const topicRows = db
    .prepare(
      `SELECT channel, COUNT(*) AS scouted,
              SUM(CASE WHEN status = 'candidate' THEN 1 ELSE 0 END) AS candidate,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
       FROM topics WHERE datetime(created_at) >= datetime('now', '-1 day')
       GROUP BY channel ORDER BY channel`,
    )
    .all() as {
    channel: string
    scouted: number
    candidate: number
    rejected: number
  }[]
  const topicsStart = lines.length
  for (const r of topicRows) {
    lines.push(`  ${r.channel}: ${r.scouted} scouted — ${r.candidate} candidate, ${r.rejected} rejected`)
  }
```

- [ ] **Step 3: Delete the approved/candidate depth blocks from Action items**

In `src/loop/digest.ts`, lines 353-368:

```ts
// before
  const approvedDepth = db
    .prepare(
      "SELECT channel, COUNT(*) AS n FROM topics WHERE status = 'approved' GROUP BY channel ORDER BY channel",
    )
    .all() as { channel: string; n: number }[]
  for (const r of approvedDepth) {
    lines.push(`  ${r.channel}: ${r.n} approved topics queued`)
  }
  const candidateDepth = db
    .prepare(
      "SELECT channel, COUNT(*) AS n FROM topics WHERE status = 'candidate' GROUP BY channel ORDER BY channel",
    )
    .all() as { channel: string; n: number }[]
  for (const r of candidateDepth) {
    lines.push(`  ${r.channel}: ${r.n} candidate topics awaiting approval`)
  }
// after
  (delete both blocks — no replacement code)
```

Concretely: remove those two `const ... = db.prepare(...)` + `for` blocks entirely, leaving whatever code came immediately after (the auth-failures block) directly following the `strandedQueued`/blocked-jobs code that precedes them.

- [ ] **Step 4: Run the digest tests to see the expected breakages**

Run: `pnpm vitest run src/loop/digest.test.ts`
Expected: FAIL — the `'counts last-24h topics per channel by status, excluding older rows'` test (string mismatch: expects `approved` in the line), and the `'reports approved and candidate queue depths per channel'` test (the lines it asserts no longer exist).

- [ ] **Step 5: Update the test file**

In `src/loop/digest.test.ts`, line 123, narrow the `seedTopic` status union:

```ts
// before
    status?: 'candidate' | 'approved' | 'claimed' | 'used' | 'rejected'
// after
    status?: 'candidate' | 'claimed' | 'used' | 'rejected'
```

Lines 198-212, swap the `'approved'` fixture for `'claimed'` and drop `approved` from the expected strings:

```ts
// before
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
// after
  it('counts last-24h topics per channel by status, excluding older rows', () => {
    const db = openDb(':memory:')
    seedTopic(db, { dedupeHash: 'h1', status: 'candidate' })
    seedTopic(db, { dedupeHash: 'h2', status: 'candidate' })
    seedTopic(db, { dedupeHash: 'h3', status: 'claimed', jobId: 'job-1' })
    seedTopic(db, { dedupeHash: 'h4', status: 'rejected' })
    // 3 days old — outside every reading of the 24h window
    seedTopic(db, { dedupeHash: 'h5', createdAt: isoAgo(3 * DAY_MS) })
    seedTopic(db, { channel: 'chan-b', dedupeHash: 'h6', status: 'rejected' })
    const digest = buildDigest(db, [])
    expect(digest).toContain('Topics (last 24h)')
    expect(digest).toContain('  chan-a: 4 scouted — 2 candidate, 1 rejected')
    expect(digest).toContain('  chan-b: 1 scouted — 0 candidate, 1 rejected')
    db.close()
  })
```

Delete the `'reports approved and candidate queue depths per channel'` test (lines 314-327) entirely — the feature it covers no longer exists:

```ts
// delete this whole test
  it('reports approved and candidate queue depths per channel', () => {
    const db = openDb(':memory:')
    seedTopic(db, { dedupeHash: 'h1', status: 'approved' })
    seedTopic(db, { dedupeHash: 'h2', status: 'approved' })
    seedTopic(db, { dedupeHash: 'h3', status: 'candidate' })
    seedTopic(db, { channel: 'chan-b', dedupeHash: 'h4', status: 'candidate' })
    // claimed/used topics are neither queued nor awaiting approval
    seedTopic(db, { dedupeHash: 'h5', status: 'used' })
    const digest = buildDigest(db, [])
    expect(digest).toContain('  chan-a: 2 approved topics queued')
    expect(digest).toContain('  chan-a: 1 candidate topics awaiting approval')
    expect(digest).toContain('  chan-b: 1 candidate topics awaiting approval')
    db.close()
  })

```

- [ ] **Step 6: Run the digest tests and confirm they pass**

Run: `pnpm vitest run src/loop/digest.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 7: Full build and test run, then commit**

Run: `pnpm build && pnpm test`
Expected: PASS — clean type-check across `src/` and `remotion/`, full vitest suite green (contract tests excluded by default).

```bash
git add src/loop/digest.ts src/loop/digest.test.ts
git commit -m "$(cat <<'EOF'
fix: stop the digest reporting a topic-approval step that doesn't exist

Candidate topics were never actually gated on approval, but the digest's
Action items section told operators they were "awaiting approval" and
reported a separate approved-queue depth. Drop both — queue depth with
nothing to action doesn't belong in Action items either.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
