# Retire the `'approved'` topic status and `topics approve` — design

Date: 2026-07-25
Status: approved design, pending implementation plan

## Goal

Scout-curated topics should flow into production without requiring a manual
approval step. Remove the vestigial approval gate and the CLI/reporting
surface built around it, rather than change any actual eligibility behavior.

## Background

`eligibleTopic` (`src/scout/topics.ts:238-246`) already selects from
`status IN ('candidate', 'approved')`, and `claimTopic` accepts the same set.
Scout only ever writes `'candidate'` (or `'rejected'` below the score
threshold) — see `src/scout/scout.ts`. So scout topics have *always*
auto-flowed into `produce-next` without needing `topics approve`; the
`'approved'` status and the `approve` subcommand never gated anything in the
current pipeline.

They're a leftover from the removed premium/volume tier design
(`docs/superpowers/plans/2026-07-20-trend-scout-loop.md`,
`docs/superpowers/specs/2026-07-24-live-automation-design.md`), where premium
claims required `'approved'` unless a channel set `auto_premium = true`. That
tier system was deleted in `8983168` ("collapse to one pipeline"), and the
approval gate was never rewired to anything — it just stopped mattering.

The one place this half-life is visible to an operator: `src/loop/digest.ts`
reports candidate topics as "N candidate topics awaiting approval" in the
`Action items` section, and a separate "N approved topics queued" line — both
implying a manual step exists. It doesn't. The live DB (`data/brainrot.db`)
has zero `'approved'` rows today (36 `candidate`, 23 `rejected`, 1 `used`),
confirming the status is already dead in practice, not just in theory.

`topics reject <ids...>` is different: it has a real, current effect (removes
a topic from ever being claimed) and stays as the operator's veto over a bad
scout pick.

## Decisions

- **Remove `'approved'` from `TopicStatus`** (`src/scout/topics.ts:3`) and
  delete `approveTopics()` (`topics.ts:134-142`).
- **Narrow the status filters** in `rejectTopics`, `claimTopic`,
  `eligibleTopic` from `IN ('candidate','approved')` to `= 'candidate'` —
  nothing will ever write `'approved'` again, so the wider match is dead.
- **Narrow the schema `CHECK`** (`src/db/schema.sql:35`) to
  `('candidate','claimed','used','rejected')`. No migration is needed: no
  live row is `'approved'`, and there's no migration framework
  (`CREATE TABLE IF NOT EXISTS` — additive-only per CLAUDE.md), so this only
  affects fresh installs; it's a documentation-of-intent change on an
  already-unreachable state, not a live data change.
- **Delete `topics approve <ids...>`** (`src/cli.ts:282-292` region) and its
  import. `topics list`, `topics reject`, `topics requeue` are unaffected.
- **Digest cleanup** (`src/loop/digest.ts`):
  - `Topics (last 24h)` summary line: drop the `approved` column — becomes
    `N scouted — N candidate, N rejected`.
  - `Action items`: delete the `approvedDepth` block outright (always empty
    henceforth). Delete the `candidateDepth` "awaiting approval" line rather
    than reword it — the file already states the operating principle a few
    lines above it ("Ready-backlog pressure belongs in Publishing... NOT
    Action items"); a depth number with nothing to action doesn't belong in
    Action items either, and there's no other section asking for it.
- **Leave historical docs alone.** `docs/superpowers/plans/2026-07-20-trend-scout-loop.md`
  and `docs/superpowers/specs/2026-07-24-live-automation-design.md` describe a
  design that's already superseded by the tier removal in `8983168`; this
  change doesn't touch them.

## Testing

Update in place, no new test files:
- `src/scout/topics.test.ts` — remove the `approveTopics` describe block and
  every `status: 'approved'` seed/assertion; `rejectTopics`/`claimTopic`/
  `eligibleTopic` specs collapse to `'candidate'`-only fixtures.
- `src/loop/digest.test.ts` — update the two string assertions that expect
  `approved` in the summary line and the `queued`/`awaiting approval` lines;
  remove the now-dead `status: 'approved'` seeds those tests relied on.
- `src/cli.test.ts` — the `topics --help` assertion drops `approve` from its
  expected subcommand list.

`pnpm build` and `pnpm test` (no contract tests needed — no provider calls
involved) are sufficient to verify.
