# Refinement Phase — Audit Findings & Triage

Date: 2026-07-24
Design: `docs/superpowers/specs/2026-07-24-refinement-phase-design.md`
Provenance: 17-agent workflow — 7 lens auditors (drift, dead-code, simplify,
crash-windows, seams, errors, tests) + 1 unprimed Codex (gpt-5.5) sweep → merge/dedup
→ per-module adversarial verification (opus). 30 merged findings, 29 survived, 1
refuted. Both criticals additionally verified on disk by the orchestrator.

Severity: **critical** = data loss, stranded state, or wrong-thing-published;
**major** = wrong accounting or degraded behavior needing manual intervention;
**minor** = quality/annoyance. **Breaking** = touches DB schema, TOML keys, or CLI
JSON/command contracts.

---

## Part A — Simplification worklist (behavior-preserving; executes without per-item gates)

| ID | Files | What |
|----|-------|------|
| S1 | lease.test.ts, publishes.test.ts | Add exact-boundary tests for lease expiry and sweep cutoff |
| S2 | publish/types.ts, stages/script.ts | Extract the twice-defined platformEntrySchema into one shared module |
| S3 | publish/publishes.ts | **Deferred to Track 2** — unify markPublishDone/markInterruptedDone (composes with G1/G4 fixes) |
| S4 | loop/digest.ts | Unify the six 'rows or none-line' sites behind one helper (indent-aware) |
| S5 | stages/visuals-premium.ts, stages/qc.ts | Single shared constant for premium clip duration bounds (3000/15000ms, currently two private copies) |
| S6 | stages/visuals-premium.ts | Extract the triplicated pay-then-rethrow ledger wrapper (needs a cost-selector arg — visionJudgment's cost shape differs) |
| S7 | publish/youtube.ts, cli.ts | Single `youtubeShortsUrl(postId)` helper for the URL built in two places (helper only — no platform dispatcher) |

Details:

- **S1** — `acquireLease` guards `expires_at > now` (lease.ts:21) and `sweepInterrupted` guards `created_at <= cutoff` (publishes.ts:116), but every test sits clearly on one side; flipping either comparator passes the whole suite. Two cheap tests pin the intended semantics at the exact instant. *(tests lens, confirmed)*
- **S2** — Byte-identical zod entry schema in script.ts:20-24 (writer into `metadata_json`) and types.ts:45-49 (reader in publish/digest), with nothing pointing at the other. A one-sided tighten silently routes valid rows to the synthesized-fallback title path. Pure dedup into `src/publish/platform-meta.ts`; also becomes the natural home for G6's normalization if accepted. *(errors lens, confirmed)*
- **S3** — Same two-table done-flip invariant in two shapes (id-keyed read-then-write vs job_id-keyed write-first). Extraction is correct but forcibly unifies the transaction shape, which is exactly what G1/G4 decide — so it executes after triage, alongside those fixes, whatever their verdict. *(crash-windows lens, confirmed)*
- **S4** — Six sections, two idioms for "print rows or a `none` line". Verifier caught that indent differs by section (two-space vs four-space `none`, pinned by digest.test.ts) — the helper takes the indent as a parameter; printed output unchanged. *(simplify lens, adjusted)*
- **S5** — visuals-premium.ts:27-28 carries a comment saying the bounds must match qc.ts:30-31. Classic N-place edit; both are private consts so a shared exported pair is drop-in. *(codex, confirmed)*
- **S6** — Three verbatim try/recordCost/catch/recordCost-paid/rethrow blocks (image, keyframe-check, video). Verifier correction: visionJudgment returns `{data, cost}` not `{costUsdMicros}`, so the wrapper takes a cost-selector rather than a naive generic constraint. *(simplify lens, adjusted)*
- **S7** — `https://youtube.com/shorts/` built in youtube.ts:218 and cli.ts:448. Extract the helper; the reviewer's platform-dispatcher suggestion is dropped (single-platform enum is a settled decision). *(seams lens, adjusted)*

---

## Part B — Gap triage table (every row needs your accept / reject / defer)

### Critical

**G1 — DB error after a successful upload republishes the video** · publish · not breaking
- **Scenario:** The upload succeeds — video live on YouTube — then `markPublishDone` (publish-next.ts:196) throws (SQLITE_BUSY past the 5s timeout under a co-firing produce tick, BUSY_SNAPSHOT from its deferred transaction, disk full). It sits inside the same try whose catch maps any throw to `markPublishFailed(kind:'transient')`. The library row stays `ready`, `failed` rows don't block eligibility, so the *same job uploads again next slot* — duplicate public video, first postId lost, and the logs claim the first attempt failed. Can repeat a third time.
- **Evidence:** publish-next.ts:185-222; publishes.ts:94-106 (failure never touches library), :181 (failed not blocking), :189 (only 'rejected' capped). The comment at :162-164 guards the pre-claim window but not this post-upload one.
- **Fix:** Split the try: only mint+upload inside the failure-mapping catch. If the finalize write throws, leave the row `claimed` — sweepInterrupted heals it to `interrupted`, the designed "uploaded but DB state unknown" path (digest already routes to Studio + `publish mark-done`). JSON/exit contract unchanged. Regression test: markPublishDone throws → row not failed, job not re-eligible.
- **Verification:** 3-lens convergence (crash-windows, seams, errors) → confirmed; re-verified on disk by orchestrator.

**G2 — Resume pass livelocks the produce loop on a per-video-cap-blocked job** · loop · not breaking
- **Scenario:** A premium job blocks with (say) $6.80 of $7 per-video budget spent. The resume pass (plan-tick.ts:33-53) checks channel-day and global-day headroom but **never the per-video cap**, and picks oldest-first. Resume reuses scenes 1-4 free, hits scene 5, throws the identical BudgetExceededError — blocked again, same `created_at`, still first in line. Every produce tick forever re-blocks this one job and never reaches the claim pass; **no channel produces anything again**. Per-video spend never resets at day boundaries, so it never self-heals.
- **Evidence:** plan-tick.ts:39-52 (no per-video check; verified on disk); costs.ts:106-109 (lifetime `SUM(usd_micros)` per job); visuals-premium.ts:189-210 (checkpoint reuse costs 0). No resume-attempt column exists for backoff.
- **Fix:** In the resume pass, skip a blocked job whose lifetime spend leaves less than a minimum step of per-video headroom (one SUM query, mirroring the existing guards) so it falls through to the claim pass; surface it via G9's blocked-jobs digest item.
- **Verification:** seams lens → confirmed (traced on paper); re-verified on disk by orchestrator.

### Major

**G3 — Malformed 200 after the upload PUT → 'transient' → duplicate upload** · publish · not breaking
- **Scenario:** youtube.ts:204 sees `uploadRes.ok` — YouTube accepted the bytes — then the body fails to parse or lacks `id` (:210-217) and both throw kind `'transient'`. Same re-eligibility path as G1: the already-published video uploads again next slot. Also covers the 5-min AbortSignal firing while response headers are in flight after the bytes were sent.
- **Fix:** Distinguish post-acceptance failures: adapter signals "platform accepted, outcome unreadable"; tick leaves the row `claimed` → `interrupted` → operator path. No new error_kind, schema untouched.
- **Verification:** seams lens → confirmed.

**G4 — claimPublish / markPublishDone use deferred read-then-write transactions** · publish · not breaking
- **Scenario:** Both start with a read under plain `db.transaction()` (deferred BEGIN). In WAL, a write committed between their read snapshot and first write (produce tick ledgering costs mid-render) yields SQLITE_BUSY_SNAPSHOT, which `busy_timeout` **cannot** retry. claimPublish runs outside the tick's try, so it escapes to cli.ts:496 — exit 1, no JSON line, both loop contracts broken. Inside markPublishDone it triggers G1's duplicate path.
- **Evidence:** publishes.ts:47-66, :86-91; lease.ts:29 already uses `.immediate()` with exactly this rationale — the pattern drifted.
- **Fix:** `.immediate()` on both (S3's helper then keeps the mode from drifting again).
- **Verification:** seams lens → confirmed.

**G6 — Model-authored titles reach YouTube unbounded; over-length = deterministic 'rejected' ×3 slots, then a good video retired** · publish · not breaking
- **Scenario:** The 90-char title bound lives only in the LLM prompt; schema has no length caps and `resolvePlatformMeta` caps only the *fallback*. YouTube 400s titles >100 chars (or containing `<`/`>`) → `'rejected'`. Metadata is never rewritten, so all three attempts fail identically: three burnt slots + quota units, then the poison cap retires a perfectly good video and the digest tells you to `library reject` it. Same for description+hashtags vs the 5000-char limit.
- **Fix:** Normalize in `resolvePlatformMeta` (the single choke point): trim/slice title to 100, strip `<`/`>`, bound description+hashtags, drop malformed hashtags; empty-after-normalize falls back to topic title. Well-formed metadata unchanged. (Lands naturally in S2's shared module.)
- **Verification:** errors lens → confirmed.

**G8 — Digest zombie check ages resumed jobs by `created_at` → tells you to --force a live run** · loop · not breaking
- **Scenario:** A job created yesterday, blocked, auto-resumed this morning: the digest's zombie query (`running AND created_at <= now-2h`) flags the 10-minute-old resume as "running > 2h — probably crashed — resume with --force". Following that while the render is live double-runs the job: two processes writing the same runs/ tree, double-paying stages, racing the library upsert. Verifier scope note: requires the daily digest to land inside a resume's run window — not routine, but the instruction it prints is actively dangerous.
- **Fix:** Age from `MAX(job_stages.started_at)` (runner already stamps it) with `created_at` fallback — non-breaking. Test: old job, fresh stage → not a zombie.
- **Verification:** crash-windows lens → adjusted (scope), bug confirmed.

**G9 — Unreachable blocked jobs are invisible after 24h; hardcoded $2 resume floor locks out small-budget channels** · loop · not breaking
- **Scenario:** Three config-drift paths silently exclude a blocked job from resume forever: channel TOML renamed/deleted; FAL_KEY missing (hint masked whenever other work exists); and `RESUME_MIN_HEADROOM_USD_MICROS` = $2 vs a channel whose whole daily budget is under $2 (per_day_usd 1.50 → locked out even at zero spend). In all cases: sunk premium spend unrecovered, its topic stays `claimed` forever, and after 24h the job vanishes from every operator surface (digest Action items query failed/running/queued only; blocked appears only in the 24h-windowed counts).
- **Fix:** Blocked-jobs Action-items block in the digest (current state, not 24h-windowed) naming job, channel, and the unreachability reason; make the resume floor relative (min of $2 and a fraction of the channel's daily budget). Verifier correction: tier slots are *not* permanently consumed (quota counts today's jobs only) — the topic binding is the permanent leak.
- **Verification:** crash-windows + seams convergence → adjusted (one claim corrected), core confirmed.

**G10 — Missing/undecryptable OAuth token stalls publishing silently** · loop · not breaking
- **Scenario:** Rotate BRAINROT_TOKEN_KEY (or restore a backup encrypted under the old key): every tick becomes `{"action":"noop","reason":"no-auth"}` exit 0 — indistinguishable from healthy idle. No publishes row is written, so the digest's auth hint (which queries `publishes WHERE error_kind='auth'`) can never fire; the only signal is "slots lapsed" a full day later, with no cause named. Same silence for unset env vars or a never-authorized channel.
- **Fix:** Digest token-health check per publish-enabled channel: attempt `loadRefreshToken`, emit an action item naming the exact failure mode + the `brainrot auth youtube --channel <name>` remedy. Optionally name the channel in the no-auth noop JSON.
- **Verification:** errors lens → confirmed (grep: oauth_tokens never read anywhere in src/loop).

**G12 — All-channel scoring failures exit as successful scout runs** · scout · not breaking
- **Scenario:** Sources fetch fine, but *every* channel fails in scoring (e.g. expired ANTHROPIC_API_KEY): `sourceErrors` stays empty so AllSourcesFailedError never fires — exit 0, healthy-looking JSON, zero topics inserted. The queue drains for days; cron mail shows nothing (stderr is redirected into the log file, bypassing MAILTO).
- **Fix:** Track channel-level scoring failures separately; when every channel failed to produce rows for that reason, exit as a failure (or a distinct action/reason).
- **Verification:** codex sweep → confirmed by opus verifier.

### Minor

**G5 — No video-file pre-flight before claiming a slot** · publish · not breaking — library.video_path is never `existsSync`-checked; a pruned runs/ tree means the claim happens first, then ENOENT maps to `'rejected'` — each orphan burns 3 slots + 3 quota units across 3 days before the poison cap retires it. Verifier correction: newest-first ordering means *old* pruned runs sort last, not first, so this is exposure-on-prune, not front-of-queue poison. **Fix:** `existsSync` in the candidate scan (pure read, dry-run-safe, skip with reason `no-video-file`) + digest item listing ready rows whose file is gone. *(3-lens convergence, adjusted)*

**G7 — OAuth consent 5-min timeout path has zero test coverage** · publish · not breaking — every oauth-flow test drives the redirect synchronously; the timeout+teardown branch has never executed under the suite. **Fix:** fake-timers test asserting rejection message + server closed. *(tests lens, adjusted down from major)*

**G11 — Scout tick has no lease, unlike the other two loops** · scout · not breaking — two overlapping scout runs race the global-budget check (TOCTOU) and double-spend. Verifier scope: ~$0.02 per overlap, duplicate topic rows impossible (INSERT OR IGNORE), and a scout lease wouldn't close the cross-loop race anyway. Worth doing for consistency, cheap. **Fix:** same acquireLease/releaseLease pattern, name `scout`. *(drift lens, adjusted)*

**G13 — Billed Anthropic response without the forced tool block loses its cost from the ledger** · providers · not breaking — throw at anthropic.ts:129 precedes cost computation, so callers' `errorCostUsdMicros` recovers nothing. Rare (forced tool_choice), one call's spend. **Fix:** compute cost immediately after `messages.create` and attach to every post-response error. *(codex, adjusted down)*

**G14 — One broken channel TOML crashes both loops with no JSON line and blanks the digest** · config · not breaking — `loadChannelsDir` throws on the first bad file; publish/produce ticks exit 1 with no JSON line every firing, and the digest catch degrades the whole daily report to one error line — exactly when you need it. Verifier scope: full skip-broken-files contradicts documented intent + pinned tests; survivable fix is narrower. **Fix:** loops catch config errors and emit a proper JSON line (`action:'config-error'` or similar); digest still renders its sqlite-only sections around the config failure. *(errors lens, adjusted)*

**G15 — Fractional BRAINROT_YT_UPLOADS_PER_DAY rounds the cap up** · publish · not breaking — `1.5` validates and `>=` gating permits 2 uploads. **Fix:** require `Number.isInteger`. *(codex, confirmed)*

**G16 — produce-next crashes with no JSON line when a claim loses a documented race** · loop · **breaking** (adds a `reason` value to the tick JSON union) — `topics reject`/`resume` racing a live tick makes claimTopic/claimJobForResume lose → uncaught throw → exit 1, no JSON line, for a benign self-healing race. publish-next already returns `claim-conflict` for its equivalent. **Fix:** catch lost-claim cases, return `{action:'noop', reason:'claim-conflict'}`, mirroring publish-next. *(crash-windows lens, confirmed)*

**G17 — Malformed env vars crash the publish tick; the same vars missing degrade gracefully** · loop · not breaking — a 63-char BRAINROT_TOKEN_KEY or `UPLOADS_PER_DAY=six` throws unguarded inside the tick → exit 1, no JSON line, every 15 min, no DB trace; unset, the same vars produce a clean noop. **Fix:** validate once at tick top → `{action:'noop', reason:'bad-env', error}`; pairs with G10's digest item. *(errors lens, confirmed)*

**G18 — Paid ElevenLabs success can be swallowed as a provider failure** · stages · not breaking — after paid audio returns, the wav write and cost insert sit inside the fallback catch; a local failure there silently downgrades to volume narration with the spend unledgered. **Fix:** only the provider call inside the fallback catch; ledger the cost before fallible local writes. *(codex, confirmed)*

**G19 — Scout ledgers spend and inserts the topics it paid for in two separate writes** · scout · not breaking — a kill between them keeps the charge, loses the dedupe hashes, and the next run re-pays Haiku for the same items. Bounded ~$0.02, microsecond window. **Fix:** one `db.transaction` wrapping both. *(crash-windows lens, confirmed)*

**G20 — WHISPERX_MAX_UPLOAD_MB in .env never reaches the sidecar** · providers · not breaking — verifier overturned the headline: the sidecar *does* read it (app.py:19, tested); the real residue is docker-compose passes only WHISPERX_DEVICE, so a .env value reaches nothing. **Fix:** add the var to docker-compose environment (or document it as sidecar-env-only). *(dead-code lens, adjusted)*

**G21 — ElevenLabs alignment arrays indexed without a length check → NaN timings → misleading premium failure** · providers · not breaking — a partial alignment yields NaN→null word timings; scene windows collapse to 0ms and the job fails blaming "empty or too-short narration" after paying for script+TTS, while the designed WhisperX fallback never fires. **Fix:** validate array-length agreement + finiteness in `synthWithTimestamps`; on violation return `words: []` so the existing fallback runs on the paid audio; also guard missing `audio_base64`. *(errors lens, confirmed)*

**G22 — WhisperX 200 body is cast, not checked** · providers · not breaking — a 200 with an unexpected shape becomes `Cannot read properties of undefined (reading 'map')` stored verbatim as the stage error — indistinguishable from a code bug. **Fix:** assert `Array.isArray(body.words)`, name the endpoint in the thrown error, drop non-finite words (pairs with G21). *(errors lens, confirmed)*

### Pre-seeded from the Plan 4 ledger backlog (accepted-minor then; judge now)

**B1 — Lease heartbeat for hung renders** · loop · not breaking — a render exceeding the 90-min produce lease TTL lets a second tick start while the first still runs. **Fix:** runner extends the lease at stage transitions. *(accepted-minor at Plan 4 close)*

**B2 — `topics requeue` command** · cli · **breaking** (new CLI surface) — no way to return an orphaned `claimed` topic to `queued`; G9 shows claimed topics leak permanently when their job strands. New surface, but it's the manual remedy G9's digest item would point at. *(accepted-minor at Plan 4 close)*

**B3 — Digest failed-list age cap** · loop · not breaking — the digest's failed list has no age bound; old failures accumulate and bury fresh ones. **Fix:** cap the list by age or count with an "and N older" line. *(accepted-minor at Plan 4 close)*

**B4 — `finished_at` records tick-start, not actual finish** · publish · not breaking — publish rows stamp the tick's `now` rather than completion time; cosmetic accounting skew of up to a few minutes. **Fix:** stamp at write time. *(accepted-minor at Plan 4 close)*

---

## Refuted (for the record)

- **G23** (tests): "per-file DB fixture helpers risk divergent defaults" — verifier: helpers are scoped, not divergent; no behavioral risk.

## Triage

Reply in any form — e.g. `accept G1-G4, G6; reject G15; defer the rest` — or edit
this file directly. Part A (minus S3) begins executing on branch
`plan-5-refinement` immediately; S3 and all accepted G-rows follow your triage.
