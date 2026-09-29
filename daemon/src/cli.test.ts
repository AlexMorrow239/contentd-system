import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseTopicIds } from './cli.js'
// Straight from the module that owns it: cli.ts reaches pipelineStages through
// a dynamic import inside the commands that render, so it no longer re-exports
// it — a static re-export would put Remotion back on every command's startup.
import { pipelineStages } from './jobs/pipeline.js'
import { visualsVolumeStage } from './stages/visuals-volume.js'
import { openDb } from './db/index.js'
import { runCli } from '../testing/run-cli.js'
import { countJobs, seedLibraryRow } from '../testing/cli.js'
import { tmpDir, testRoot } from '../testing/tmp.js'

// Mirrors run-cli.ts's CLI_ENTRY resolution (daemon/dist/cli.js, built by the Vitest
// globalSetup) — duplicated here rather than imported because the `run`
// SIGTERM test needs a live child process (spawn), not runCli's
// run-to-completion execa wrapper.
const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

/**
 * The CLI's pure, in-process surface (parsers, the stage list) alongside its
 * subprocess-spawning coverage of every subcommand. One file: each
 * subcommand's tests share the same `runCli`/`testRoot` testkit
 * abstractions regardless of file boundaries, so splitting by subcommand
 * bought nothing beyond a lower line count. `it.concurrent` batches at
 * maxConcurrency within this one file/worker.
 */

describe('pipelineStages', () => {
  it('returns the fixed stage list', () => {
    const stages = pipelineStages()
    const order = ['script', 'voice', 'captions', 'visuals', 'assemble', 'qc']
    expect(stages.map((s) => s.name)).toEqual(order)
    expect(stages[3]).toBe(visualsVolumeStage)
  })
})

describe('parseTopicIds', () => {
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

describe('brainrot CLI — jobs and produce', () => {
  it('refuses operational commands without an explicit root', async () => {
    const result = await runCli(['jobs'], { env: { BRAINROT_ROOT: '' } })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/BRAINROT_ROOT.*required/)
  })

  it.concurrent(
    '`jobs` opens the db and prints a table header, exiting 0',
    async () => {
      const root = testRoot()
      // Seed one job so console.table renders column headers (empty tables print nothing).
      const db = openDb(root.dbPath)
      db.prepare(
        "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1', 'example', 'volume', 'venus', 'queued')",
      ).run()
      db.close()

      const result = await runCli(['jobs', '--root', root.root])
      expect(result.exitCode).toBe(0)
      // console.table header row names the selected columns.
      expect(result.stdout).toContain('status')
    },
    60000,
  )

  it.concurrent(
    '`produce --help` prints usage with --channel/--topic',
    async () => {
      const result = await runCli(['produce', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--channel')
      expect(result.stdout).toContain('--topic')
    },
    60000,
  )

  it.concurrent(
    '`produce --help` no longer offers --dev',
    async () => {
      const result = await runCli(['produce', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain('--dev')
    },
    60000,
  )

  it.concurrent(
    '`resume --help` no longer offers --dev',
    async () => {
      const result = await runCli(['resume', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain('--dev')
    },
    60000,
  )

  it.concurrent(
    '`produce` with a nonexistent --channel exits 1 with a clean one-line error (no stack)',
    async () => {
      const root = testRoot()
      const result = await runCli([
        'produce',
        '--channel',
        '/no/such/channel.toml',
        '--topic',
        'venus',
        '--root',
        root.root,
      ])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toMatch(/ENOENT|no such file/)
      // Just the message — no raw unhandled-rejection stack frames ("    at ...").
      expect(result.stderr).not.toMatch(/\n\s+at /)
      expect(countJobs(root.dbPath)).toBe(0)
    },
    60000,
  )
})

describe('brainrot CLI — scout', () => {
  // Plan-1-shape channel TOML with no [scout] table: loadChannelsDir parses it,
  // scoutAll skips it (DEFAULT_SCOUT has no sources) — the cheapest full E2E.
  const SCOUTLESS_TOML = [
    'name = "cli-scout-test"',
    'niche = ["space facts"]',
    'bg_dir = "assets/bg"',
    'videos_per_day = 2',
    '',
    '[voice]',
    'voice_id = "EXAVITQu4vr4xnSDxMaL"',
    '',
    '[budget]',
    'per_video_usd = 8.0',
    'per_day_usd = 20.0',
  ].join('\n')

  it.concurrent(
    '`scout --help` prints usage with --root',
    async () => {
      const result = await runCli(['scout', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--root')
      expect(result.stdout).not.toContain('--channels-dir')
    },
    60000,
  )

  it.concurrent(
    '`scout` over a sourceless channels dir prints one JSON line and exits 0',
    async () => {
      const root = testRoot()
      // filename must equal the channel name (loadChannelsDir invariant)
      writeFileSync(path.join(root.channelsDir, 'cli-scout-test.toml'), SCOUTLESS_TOML)
      const result = await runCli(['scout', '--root', root.root])
      expect(result.exitCode).toBe(0)
      // exactly one cron-greppable JSON line on stdout
      expect(JSON.parse(result.stdout)).toEqual({ channels: [] })
    },
    60000,
  )

  // The same G14 symptom the two loops already fixed: a broken channels dir
  // used to exit 1 with an empty stdout, punching a hole in the cron log of
  // JSON lines every scout firing until someone noticed.
  it.concurrent(
    '`scout` over a broken channels dir still prints one JSON line and exits 0',
    async () => {
      const root = testRoot()
      writeFileSync(path.join(root.channelsDir, 'broken.toml'), 'this is not toml [')
      const result = await runCli(['scout', '--root', root.root])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim().split('\n')).toHaveLength(1)
      const line = JSON.parse(result.stdout) as { action: string; reason: string; error: string }
      expect(line.action).toBe('noop')
      expect(line.reason).toBe('config-error')
      expect(line.error).toContain('broken.toml')
      // stderr keeps the cause visible where the JSON line is only grepped
      expect(result.stderr).toContain('broken.toml')
      // The failure precedes the lease: nothing was leased on a config's behalf.
      const after = openDb(root.dbPath)
      const leases = after.prepare("SELECT COUNT(*) AS n FROM leases WHERE name = 'scout'").get()
      after.close()
      expect(leases).toEqual({ n: 0 })
    },
    60000,
  )

  it.concurrent(
    '`scout` no-ops under a held lease, and releases its own lease on a clean run',
    async () => {
      const root = testRoot()
      writeFileSync(path.join(root.channelsDir, 'cli-scout-test.toml'), SCOUTLESS_TOML)
      const seeded = openDb(root.dbPath)
      seeded
        .prepare('INSERT INTO leases (name, holder, expires_at) VALUES (?, ?, ?)')
        .run('scout', 'pid:999999', new Date(Date.now() + 600_000).toISOString())
      seeded.close()

      const args = ['scout', '--root', root.root]
      const held = await runCli(args)
      // A held lease is the normal overlap case: benign one-line noop, exit 0.
      expect(held.exitCode).toBe(0)
      expect(JSON.parse(held.stdout)).toEqual({ action: 'noop', reason: 'lease-held' })
      const afterNoop = openDb(root.dbPath)
      const foreign = afterNoop.prepare("SELECT holder FROM leases WHERE name = 'scout'").get() as {
        holder: string
      }
      // the other holder's lease is untouched
      expect(foreign.holder).toBe('pid:999999')
      afterNoop.prepare("DELETE FROM leases WHERE name = 'scout'").run()
      afterNoop.close()

      const free = await runCli(args)
      expect(free.exitCode).toBe(0)
      expect(JSON.parse(free.stdout)).toEqual({ channels: [] })
      const afterRun = openDb(root.dbPath)
      const leases = afterRun.prepare("SELECT COUNT(*) AS n FROM leases WHERE name = 'scout'").get()
      afterRun.close()
      expect(leases).toEqual({ n: 0 })
    },
    60000,
  )

  it.concurrent('`scout --help` lists --force', async () => {
    const result = await runCli(['scout', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--force')
  })

  it.concurrent(
    '`scout` respects the recheck cooldown by default, and --force bypasses it',
    async () => {
      const root = testRoot()
      // A channel WITH a scout source, so it reaches scoutChannel's recheck
      // gate instead of being dropped as sourceless before ever reaching it.
      // The subreddit name is deliberately malformed: redditSource's
      // constructor throws synchronously on it (no network I/O), so --force's
      // bypass is provable without a real fetch — see scout.test.ts's
      // "isolates a subreddit whose name is malformed" for the same trick.
      writeFileSync(
        path.join(root.channelsDir, 'cli-scout-force-test.toml'),
        [
          SCOUTLESS_TOML.replace('cli-scout-test', 'cli-scout-force-test'),
          '',
          '[scout]',
          'subreddits = ["r/space"]',
        ].join('\n'),
      )
      const seeded = openDb(root.dbPath)
      // Recorded "just now" — well inside SCOUT_RECHECK_MS (20 min) — so the
      // channel is not due, and scoutChannel returns before touching any
      // source (no network I/O, hermetic).
      seeded
        .prepare('INSERT INTO scout_state (channel, last_attempt_at) VALUES (?, ?)')
        .run('cli-scout-force-test', new Date().toISOString())
      seeded.close()

      const args = ['scout', '--root', root.root]
      const gated = await runCli(args)
      expect(gated.exitCode).toBe(0)
      const gatedChannels = (JSON.parse(gated.stdout) as { channels: { skipped?: string }[] })
        .channels
      expect(gatedChannels).toEqual([expect.objectContaining({ skipped: 'recheck-not-due' })])

      const forced = await runCli([...args, '--force'])
      // --force bypassed the gate, so the channel was actually attempted —
      // this test does not depend on whether the real source fetch (no
      // network in this sandbox) succeeds or fails the whole run; either way
      // the CLI still prints its one JSON line (the failure-outcome contract
      // `scoutAll` and the CLI both hold).
      const forcedChannels = (JSON.parse(forced.stdout) as { channels: { skipped?: string }[] })
        .channels
      expect(forcedChannels[0]?.skipped).not.toBe('recheck-not-due')
    },
    60000,
  )
})

describe('brainrot CLI — topics', () => {
  it.concurrent(
    '`topics --help` lists the list/reject/requeue subcommands',
    async () => {
      const result = await runCli(['topics', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('list')
      expect(result.stdout).toContain('reject')
      expect(result.stdout).toContain('requeue')
      expect(result.stdout).not.toContain('approve')
    },
    60000,
  )

  // Claimed topic + (optionally) the job holding it — the state `topics
  // requeue` exists to repair.
  function seedClaimedTopic(dbPath: string, opts: { jobId: string; jobStatus?: string }): number {
    const db = openDb(dbPath)
    if (opts.jobStatus !== undefined) {
      db.prepare(
        "INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, 'demo', 'volume', 'venus', ?)",
      ).run(opts.jobId, opts.jobStatus)
    }
    const res = db
      .prepare(
        'INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status, job_id) ' +
          "VALUES ('demo', 'T', 'R', 'reddit:r/space', 'https://example.com/1', 'h1', 80, 'seeded', 'claimed', ?)",
      )
      .run(opts.jobId)
    db.close()
    return Number(res.lastInsertRowid)
  }

  it.concurrent(
    '`topics requeue` returns an orphaned claimed topic to the queue',
    async () => {
      const root = testRoot()
      const id = seedClaimedTopic(root.dbPath, { jobId: 'job-stranded', jobStatus: 'failed' })
      const result = await runCli(['topics', 'requeue', String(id), '--root', root.root])
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ action: 'requeued', topicId: id })
      const db = openDb(root.dbPath)
      const row = db.prepare('SELECT status, job_id FROM topics WHERE id = ?').get(id) as {
        status: string
        job_id: string | null
      }
      db.close()
      expect(row).toEqual({ status: 'candidate', job_id: null })
    },
    60000,
  )

  it.concurrent(
    '`topics requeue` refuses while a live job holds the topic, naming the job',
    async () => {
      const root = testRoot()
      const id = seedClaimedTopic(root.dbPath, { jobId: 'job-live', jobStatus: 'running' })
      const result = await runCli(['topics', 'requeue', String(id), '--root', root.root])
      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stdout)).toEqual({
        action: 'refused',
        topicId: id,
        reason: 'job-active',
        jobId: 'job-live',
        jobStatus: 'running',
      })
      expect(result.stderr).toContain('job-live')
      const db = openDb(root.dbPath)
      const row = db.prepare('SELECT status, job_id FROM topics WHERE id = ?').get(id) as {
        status: string
        job_id: string | null
      }
      db.close()
      expect(row).toEqual({ status: 'claimed', job_id: 'job-live' })
    },
    60000,
  )

  it.concurrent(
    '`topics requeue` on an unknown id exits 1 with one JSON line and no stack',
    async () => {
      const root = testRoot()
      const result = await runCli(['topics', 'requeue', '9999', '--root', root.root])
      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stdout)).toEqual({
        action: 'refused',
        topicId: 9999,
        reason: 'unknown',
      })
      expect(result.stderr).not.toMatch(/\n\s+at /)
    },
    60000,
  )

  it.concurrent(
    '`topics requeue` rejects a non-integer id before opening the db',
    async () => {
      const root = testRoot()
      const result = await runCli(['topics', 'requeue', 'abc', '--root', root.root])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('invalid topic id "abc"')
    },
    60000,
  )
})

describe('brainrot CLI — digest', () => {
  it.concurrent(
    '`digest --help` prints usage with --root',
    async () => {
      const result = await runCli(['digest', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--root')
      expect(result.stdout).not.toContain('--channels-dir')
    },
    60000,
  )

  it.concurrent(
    '`digest` over an empty channels dir prints all four sections and exits 0',
    async () => {
      const root = testRoot()
      const result = await runCli(['digest', '--root', root.root])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Topics (last 24h)')
      expect(result.stdout).toContain('Jobs (last 24h)')
      expect(result.stdout).toContain('Spend today (UTC)')
      expect(result.stdout).toContain('Action items')
    },
    60000,
  )

  // A channels dir that will not load used to cost the operator the whole
  // report — one stderr line and nothing else, on the morning it matters most.
  it.concurrent(
    '`digest` with a missing channels dir still prints the db sections and names the config error',
    async () => {
      // A bare tmpDir, deliberately not testRoot(): testRoot() pre-creates
      // channels/, and this test needs it absent so tryLoadChannelsDir fails.
      // openDb still creates db/'s parent on its own.
      const bareRoot = tmpDir('brainrot-digest-missing-')
      const result = await runCli(['digest', '--root', bareRoot])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Topics (last 24h)')
      expect(result.stdout).toContain('Jobs (last 24h)')
      expect(result.stdout).toContain('Action items')
      expect(result.stdout).toContain('the channels dir did not load')
      expect(result.stdout).toMatch(/ENOENT|no such/)
    },
    60000,
  )

  it.concurrent(
    '`digest` with an unparseable channel TOML still prints the db sections and names the file',
    async () => {
      const root = testRoot()
      writeFileSync(path.join(root.channelsDir, 'broken.toml'), 'this is not toml [')
      const result = await runCli(['digest', '--root', root.root])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Topics (last 24h)')
      expect(result.stdout).toContain('Jobs (last 24h)')
      expect(result.stdout).toContain('the channels dir did not load')
      expect(result.stdout).toContain('broken.toml')
    },
    60000,
  )
})

describe('brainrot CLI — library', () => {
  it.concurrent(
    '`library approve` exits 0 when an id approves normally',
    async () => {
      const root = testRoot()
      seedLibraryRow(root.dbPath, { jobId: 'job-ok-1', channel: 'demo', state: 'needs-review' })
      const result = await runCli(['library', 'approve', 'job-ok-1', '--root', root.root])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('approved 1 of 1')
    },
    60000,
  )
})

describe('run', () => {
  it('starts, emits daemon-started, and exits 0 on SIGTERM', async () => {
    const root = testRoot()
    const child = spawn('node', [CLI_ENTRY, 'run', '--root', root.root], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    try {
      // Read stdout incrementally until a line JSON-parses to
      // action === 'daemon-started', capped at 30s.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(`timed out waiting for daemon-started; stdout=${stdout} stderr=${stderr}`),
          )
        }, 30_000)
        const onData = (): void => {
          for (const line of stdout.split('\n')) {
            if (line.trim() === '') continue
            try {
              const parsed = JSON.parse(line) as { action?: string }
              if (parsed.action === 'daemon-started') {
                clearTimeout(timer)
                child.stdout?.off('data', onData)
                resolve()
                return
              }
            } catch {
              // not a complete/parseable JSON line yet — keep waiting
            }
          }
        }
        child.stdout?.on('data', onData)
        onData() // in case daemon-started already arrived before this listener attached
        child.once('exit', (code, signal) => {
          clearTimeout(timer)
          reject(new Error(`child exited early: code=${code} signal=${signal} stderr=${stderr}`))
        })
        // A failed spawn (e.g. bad CLI_ENTRY path) emits 'error', not 'exit' —
        // without this handler it becomes an uncaught exception instead of
        // failing this promise.
        child.once('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
      })

      child.kill('SIGTERM')

      const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`timed out waiting for exit after SIGTERM; stderr=${stderr}`))
          }, 10_000)
          child.once('exit', (exitCode, exitSignal) => {
            clearTimeout(timer)
            resolve({ code: exitCode, signal: exitSignal })
          })
        },
      )
      // A SIGTERM that lands as signal-terminated (code null, signal set)
      // means the handler in runDaemon did NOT run — a real bug, not
      // something to accommodate here.
      expect({ code, signal }).toEqual({ code: 0, signal: null })
    } finally {
      // Ensure a failed assertion above can never leak a live process.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }, 60000)
})
