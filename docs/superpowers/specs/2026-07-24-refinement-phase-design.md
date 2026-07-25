# Refinement Phase (Plan 5) — Design

Date: 2026-07-24
Status: Approved by Alex (four sections, individually)
Prior specs: parent 2026-07-18, premium 2026-07-19, scout 2026-07-20, publishing 2026-07-22

## Intent

Plans 1–4 are merged: the prototype runs scout, content generation, and publishing
end-to-end (490 tests, ~6,300 source lines). This phase adds **nothing**. It refines
what exists: consolidate where parallel code has drifted, simplify where complexity
doesn't pay rent, and hunt unhandled scenarios and workflow-logic gaps left by four
plans built in sequence.

## Decisions of record

1. **Gap policy — triage-gated.** The audit produces a findings doc. Every gap fix
   (behavior-changing by nature) requires Alex's per-row accept before implementation.
   Behavior-preserving simplification proceeds without per-item gates.
2. **Frozen surfaces — none, but flagged.** Pre-go-live, DB schema, TOML config keys,
   CLI JSON contracts, and command names may all change when it genuinely simplifies.
   Any breaking change is flagged in the triage doc so acceptance is informed.
3. **Known backlog — included.** The ledger's accepted-minors backlog (lease heartbeat
   for hung renders, `topics requeue`, digest failed-list age cap, `finished_at`
   recording tick-start) enters the triage table as pre-seeded rows, judged like any
   fresh finding.
4. **DRY bar — proven drift only.** Consolidate only where parallel copies have
   diverged, are bug-prone, or force N-place fixes. Elsewhere simplify locally (dead
   code, needless branches, clearer flow) without introducing new abstractions. No
   speculative helpers; boring and greppable wins.
5. **Approach — audit-first, two-track.** One comprehensive multi-lens audit up front;
   the refactor track executes while Alex triages; approved gap fixes follow; one
   final whole-branch review. Chosen over module-by-module (weak at cross-module
   seams) and gaps-first (needlessly serial).
6. **Process deviation — no separate writing-plans cycle.** The work list is the
   audit's output and cannot be planned before it exists. This design doc is the
   process contract; the findings doc (Part A worklist + accepted Part B rows) is the
   implementation plan, executed under subagent-driven-development discipline with the
   usual ledger.

## Audit architecture

Seven finder lenses, each a separate agent with a distinct hunting ground, plus one
unprimed sweep:

1. **Duplication & drift** — parallel idioms across the four plans (three tick loops,
   DAO patterns, provider fetch/error mapping). Flags only copies that have diverged
   or force N-place fixes, per the DRY bar.
2. **Dead code & hygiene** — unused exports, unreachable branches, stale config keys,
   unused dependencies.
3. **Per-module simplification** — needless complexity, over-general code, convoluted
   flow that can become plainer without behavior change.
4. **Crash-window & state-machine gaps** — every point each tick can die; job /
   publish / library state machines; lease expiry semantics.
5. **Cross-module seams** — local vs UTC time domains, quota accounting, lease
   contention under co-firing crons, transaction discipline.
6. **Error handling & validation** — provider failures, malformed API responses,
   config validation, filesystem errors.
7. **Test-suite quality** — brittle assertions, boundary coverage gaps, test-helper
   drift.

Codex (gpt-5.5) runs an eighth, unprimed full sweep — no lens assigned, to catch what
the lens structure itself misses.

Guardrails: every auditor is primed with the decisions-of-record from the four prior
specs (two deliberate time domains, interface-ready platform array, conservative quota
counting, etc.) so settled design choices don't resurface as false gaps. Every finding
is adversarially verified against source before entering the findings doc; two
independent auditors converging on a finding is a high-confidence accept.

Models: opus-4.8 on the subtle lenses (4, 5, 6); sonnet-5 on the mechanical ones
(1, 2, 3, 7); gpt-5.5 for the sweep; opus-4.8 for verification. Fable synthesizes and
does not read the codebase wholesale.

## Findings doc & triage contract

One tracked document: `docs/superpowers/reviews/2026-07-24-refinement-findings.md`
(new `reviews/` subdirectory beside `specs/` and `plans/` — triage decisions are
decisions of record and belong in git).

**Part A — simplification worklist** (behavior-preserving; executed without per-item
gates). Each item: files touched, what changes, why it earns its keep, blast radius.
Dead-code removals are listed here so Alex sees what disappears.

**Part B — gap triage table** (Alex gates every row). Columns per gap:

- **ID** (G1, G2, …) and **severity** — critical = data loss, stranded state, or
  wrong-thing-published; major = wrong accounting or degraded behavior needing manual
  intervention; minor = quality/annoyance.
- **Scenario** — "when X happens, Y goes wrong," in plain words.
- **Evidence** — file:line plus the verified trace.
- **Proposed fix** — one line, so accepting a row is informed.
- **Breaking-change flag** — anything touching schema, TOML keys, or CLI contracts.
- **Verification** — who confirmed it (lens + verifier, or two-auditor convergence).

The four ledger backlog items are pre-seeded Part B rows. Triage is lightweight: Alex
replies "accept G1, G3–G5; reject G2; defer G7" or edits the doc. Only accepted rows
are fixed this phase; deferred rows return to the ledger backlog.

## Execution — two tracks, one branch

Branch `plan-5-refinement` off main; unmerged until Alex says otherwise.

**Track 1 — simplification worklist.** Starts when the findings doc lands, while Alex
triages. Workflow waves: disjoint-file items in parallel; test-DB contenders
serialized. Per item: 490-test baseline stays green, `tsc` clean, and
behavior-preserving is enforced literally — existing test assertions don't change
meaning. Assertions may be edited only when the test itself is the target (lens 7) or
a refactor moves an internal the test reached into; any such edit is justified in its
commit message. Commits per item or small cluster.

**Track 2 — accepted gap fixes.** Starts after triage. Each fix ships with a
regression test that fails before and passes after. Breaking-change rows carry their
flagged consequence (e.g. "delete data/brainrot.db, re-init").

**Ordering rule:** the refactor track lands first in any given file; gap fixes rebase
onto refactored code, never the reverse. Gaps in files the worklist doesn't touch may
interleave freely.

**Delegation:** mechanical worklist items → gpt-5.5 (Codex, workspace-write) or
sonnet-5; subtle state-machine and seam fixes → opus-4.8. After every wave Fable
verifies on disk: rerun suite and typecheck, spot-check diffs. Zero new dependencies;
zero new features; new code exists only inside accepted G-rows.

## Verification & done criteria

Final whole-branch adversarial review over `main..HEAD`: fresh fable/opus reviewer
plus one Codex pass, both primed with the findings doc and triage decisions. Hunting
grounds: regressions smuggled in by "behavior-preserving" changes, worklist items
marked done but half-applied, gap fixes that don't close their scenario, quiet
assertion drift. Findings get one consolidated fix wave, then re-verification.

Done means: suite green and `tsc` clean (test count reported honestly — up from
regression tests or down from lens-7 removals); every worklist item done or explicitly
dropped with a reason; every accepted G-row closed with its regression test; findings
doc updated with final per-row status; ledger updated. Then
finishing-a-development-branch — merge is Alex's call. Source LOC delta is reported
as a diagnostic, not a target.

## Out of scope

New features of any kind, including the future-plan candidates (TikTok adapter, IG
Reels, `library prune`, analytics loop). Go-live operations (OAuth, CONTRACT=1 run,
crontab) remain Alex's separate checklist.
