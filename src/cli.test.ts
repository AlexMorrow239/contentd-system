import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  applyDevFlag,
  DEV_VOICE_ENV,
  parsePublishDays,
  parseTopicIds,
  pipelineStages,
  resolveChannelsDir,
  resolveRunsRoot,
} from './cli.js'
import { visualsVolumeStage } from './stages/visuals-volume.js'
import { openDb } from './db/index.js'
import { runCli } from './testing/run-cli.js'
import { storageEnvVars } from './testing/storage.js'
import { countJobs, seedLibraryRow, seedPublishRow, tmpDbPath } from './testing/cli.js'
import { tmpDir } from './testing/tmp.js'

// Mirrors run-cli.ts's CLI_ENTRY resolution (dist/cli.js, built by the Vitest
// globalSetup) — duplicated here rather than imported because the `run`
// SIGTERM test needs a live child process (spawn), not runCli's
// run-to-completion execa wrapper.
const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

/**
 * The CLI's pure, in-process surface (parsers, path resolvers, the stage
 * list) alongside its subprocess-spawning coverage of every subcommand. One
 * file: each subcommand's tests share the same `runCli`/`tmpDbPath` testkit
 * abstractions regardless of file boundaries, so splitting by subcommand
 * bought nothing beyond a lower line count. `it.concurrent` batches at
 * maxConcurrency within this one file/worker.
 */

describe('path resolvers', () => {
  // These mirror resolveDbPath's flag > env > default precedence. They are
  // exported (not just exercised through a subprocess) because the dev/prod
  // split depends on the env tier existing at all — a literal commander
  // default would silently shadow it.
  it('resolveChannelsDir prefers the flag over the env var', () => {
    vi.stubEnv('BRAINROT_CHANNELS_DIR', 'channels-dev')
    expect(resolveChannelsDir('channels')).toBe('channels')
  })

  it('resolveChannelsDir falls back to the env var when no flag is passed', () => {
    vi.stubEnv('BRAINROT_CHANNELS_DIR', 'channels-dev')
    expect(resolveChannelsDir(undefined)).toBe('channels-dev')
  })

  it('resolveChannelsDir defaults to channels when neither is set', () => {
    vi.stubEnv('BRAINROT_CHANNELS_DIR', undefined)
    expect(resolveChannelsDir(undefined)).toBe('channels')
  })

  it('resolveRunsRoot prefers the flag over the env var', () => {
    vi.stubEnv('BRAINROT_RUNS_ROOT', 'runs-dev')
    expect(resolveRunsRoot('runs')).toBe('runs')
  })

  it('resolveRunsRoot falls back to the env var when no flag is passed', () => {
    vi.stubEnv('BRAINROT_RUNS_ROOT', 'runs-dev')
    expect(resolveRunsRoot(undefined)).toBe('runs-dev')
  })

  it('resolveRunsRoot defaults to runs when neither is set', () => {
    vi.stubEnv('BRAINROT_RUNS_ROOT', undefined)
    expect(resolveRunsRoot(undefined)).toBe('runs')
  })
})

describe('pipelineStages', () => {
  it('returns the fixed stage list', () => {
    const stages = pipelineStages()
    const order = ['script', 'voice', 'captions', 'visuals', 'assemble', 'qc', 'store']
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

describe('parsePublishDays', () => {
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

describe('applyDevFlag', () => {
  // applyDevFlag writes process.env directly, so the assertions have to read
  // it directly too. Stubbing the key to undefined first both clears it and
  // registers it with vitest, so setup.ts's global vi.unstubAllEnvs() reverts
  // whatever applyDevFlag wrote.
  beforeEach(() => {
    vi.stubEnv(DEV_VOICE_ENV, undefined)
  })

  it('sets BRAINROT_DEV_VOICE=1 when dev is true', () => {
    applyDevFlag(true)
    expect(process.env[DEV_VOICE_ENV]).toBe('1')
  })

  it('leaves BRAINROT_DEV_VOICE untouched when dev is falsy', () => {
    applyDevFlag(undefined)
    expect(process.env[DEV_VOICE_ENV]).toBeUndefined()
    applyDevFlag(false)
    expect(process.env[DEV_VOICE_ENV]).toBeUndefined()
  })
})

describe('brainrot CLI — jobs and produce', () => {
  it.concurrent(
    '`jobs` opens the db and prints a table header, exiting 0',
    async () => {
      const dbPath = tmpDbPath()
      // Seed one job so console.table renders column headers (empty tables print nothing).
      const db = openDb(dbPath)
      db.prepare(
        "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1', 'example', 'volume', 'venus', 'queued')",
      ).run()
      db.close()

      const result = await runCli(['jobs', '--db', dbPath])
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
    '`produce --help` lists --dev',
    async () => {
      const result = await runCli(['produce', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--dev')
    },
    60000,
  )

  it.concurrent(
    '`resume --help` lists --dev',
    async () => {
      const result = await runCli(['resume', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--dev')
    },
    60000,
  )

  it.concurrent(
    '`produce` with a nonexistent --channel exits 1 with a clean one-line error (no stack)',
    async () => {
      const dbPath = tmpDbPath()
      // Storage env passed explicitly: produce gates on it before opening the
      // channel file, so without this the assertion below depends on whether
      // the machine happens to have a .env.
      const result = await runCli(
        ['produce', '--channel', '/no/such/channel.toml', '--topic', 'venus', '--db', dbPath],
        { env: storageEnvVars() },
      )
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toMatch(/ENOENT|no such file/)
      // Just the message — no raw unhandled-rejection stack frames ("    at ...").
      expect(result.stderr).not.toMatch(/\n\s+at /)
      expect(countJobs(dbPath)).toBe(0)
    },
    60000,
  )

  // The `store` stage runs last, so an unconfigured deployment would otherwise
  // pay for a full Remotion render and only then fail. Object storage is
  // required (design spec §3.5) — so refuse up front, before any job row.
  it.concurrent(
    '`produce` exits 1 naming the missing storage keys, before creating a job',
    async () => {
      const dbPath = tmpDbPath()
      const result = await runCli(
        ['produce', '--channel', 'channels/test.toml', '--topic', 'venus', '--db', dbPath],
        // Empty, not absent: dotenv does not override a key already present in
        // the child env, so this holds whether or not the machine has a .env
        // with real R2 credentials in it.
        {
          env: {
            BRAINROT_S3_ENDPOINT: '',
            BRAINROT_S3_BUCKET: '',
            BRAINROT_S3_ACCESS_KEY_ID: '',
            BRAINROT_S3_SECRET_ACCESS_KEY: '',
          },
        },
      )
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('BRAINROT_S3_BUCKET')
      expect(result.stderr).toContain('object storage is not configured')
      expect(countJobs(dbPath)).toBe(0)
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
    'bgm_dir = "assets/bgm"',
    'videos_per_day = 2',
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

  it.concurrent(
    '`scout --help` prints usage with --db/--channels-dir',
    async () => {
      const result = await runCli(['scout', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--db')
      expect(result.stdout).toContain('--channels-dir')
    },
    60000,
  )

  it.concurrent(
    '`scout` over a sourceless channels dir prints one JSON line and exits 0',
    async () => {
      const dbPath = tmpDbPath()
      const channelsDir = tmpDir('brainrot-channels-')
      // filename must equal the channel name (loadChannelsDir invariant)
      writeFileSync(path.join(channelsDir, 'cli-scout-test.toml'), SCOUTLESS_TOML)
      const result = await runCli(['scout', '--db', dbPath, '--channels-dir', channelsDir])
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
      const dbPath = tmpDbPath()
      const brokenDir = tmpDir('brainrot-scout-broken-')
      writeFileSync(path.join(brokenDir, 'broken.toml'), 'this is not toml [')
      const result = await runCli(['scout', '--db', dbPath, '--channels-dir', brokenDir])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim().split('\n')).toHaveLength(1)
      const line = JSON.parse(result.stdout) as { action: string; reason: string; error: string }
      expect(line.action).toBe('noop')
      expect(line.reason).toBe('config-error')
      expect(line.error).toContain('broken.toml')
      // stderr keeps the cause visible where the JSON line is only grepped
      expect(result.stderr).toContain('broken.toml')
      // The failure precedes the lease: nothing was leased on a config's behalf.
      const after = openDb(dbPath)
      const leases = after.prepare("SELECT COUNT(*) AS n FROM leases WHERE name = 'scout'").get()
      after.close()
      expect(leases).toEqual({ n: 0 })
    },
    60000,
  )

  it.concurrent(
    '`scout` no-ops under a held lease, and releases its own lease on a clean run',
    async () => {
      const dbPath = tmpDbPath()
      const channelsDir = tmpDir('brainrot-scout-lease-')
      writeFileSync(path.join(channelsDir, 'cli-scout-test.toml'), SCOUTLESS_TOML)
      const seeded = openDb(dbPath)
      seeded
        .prepare('INSERT INTO leases (name, holder, expires_at) VALUES (?, ?, ?)')
        .run('scout', 'pid:999999', new Date(Date.now() + 600_000).toISOString())
      seeded.close()

      const args = ['scout', '--db', dbPath, '--channels-dir', channelsDir]
      const held = await runCli(args)
      // A held lease is the normal overlap case: benign one-line noop, exit 0.
      expect(held.exitCode).toBe(0)
      expect(JSON.parse(held.stdout)).toEqual({ action: 'noop', reason: 'lease-held' })
      const afterNoop = openDb(dbPath)
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
      const afterRun = openDb(dbPath)
      const leases = afterRun.prepare("SELECT COUNT(*) AS n FROM leases WHERE name = 'scout'").get()
      afterRun.close()
      expect(leases).toEqual({ n: 0 })
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
      const dbPath = tmpDbPath()
      const id = seedClaimedTopic(dbPath, { jobId: 'job-stranded', jobStatus: 'failed' })
      const result = await runCli(['topics', 'requeue', String(id), '--db', dbPath])
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ action: 'requeued', topicId: id })
      const db = openDb(dbPath)
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
      const dbPath = tmpDbPath()
      const id = seedClaimedTopic(dbPath, { jobId: 'job-live', jobStatus: 'running' })
      const result = await runCli(['topics', 'requeue', String(id), '--db', dbPath])
      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stdout)).toEqual({
        action: 'refused',
        topicId: id,
        reason: 'job-active',
        jobId: 'job-live',
        jobStatus: 'running',
      })
      expect(result.stderr).toContain('job-live')
      const db = openDb(dbPath)
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
      const dbPath = tmpDbPath()
      const result = await runCli(['topics', 'requeue', '9999', '--db', dbPath])
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
      const dbPath = tmpDbPath()
      const result = await runCli(['topics', 'requeue', 'abc', '--db', dbPath])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('invalid topic id "abc"')
    },
    60000,
  )
})

describe('brainrot CLI — digest', () => {
  it.concurrent(
    '`digest --help` prints usage with --db/--channels-dir',
    async () => {
      const result = await runCli(['digest', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--db')
      expect(result.stdout).toContain('--channels-dir')
    },
    60000,
  )

  it.concurrent(
    '`digest` over an empty channels dir prints all four sections and exits 0',
    async () => {
      const dbPath = tmpDbPath()
      const channelsDir = tmpDir('brainrot-digest-channels-')
      const result = await runCli(['digest', '--db', dbPath, '--channels-dir', channelsDir])
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
      const dbPath = tmpDbPath()
      const result = await runCli([
        'digest',
        '--db',
        dbPath,
        '--channels-dir',
        '/no/such/channels-dir',
      ])
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
      const dbPath = tmpDbPath()
      const channelsDir = tmpDir('brainrot-digest-broken-')
      writeFileSync(path.join(channelsDir, 'broken.toml'), 'this is not toml [')
      const result = await runCli(['digest', '--db', dbPath, '--channels-dir', channelsDir])
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
    '`library approve` exits 1 when every id was refused for having been reclaimed',
    async () => {
      // A wrapper script reads the exit code, not the stderr line: approving
      // nothing at all is a failed operation, not a quiet no-op.
      const dbPath = tmpDbPath()
      seedLibraryRow(dbPath, {
        jobId: 'job-gone-1',
        channel: 'demo',
        state: 'needs-review',
        reclaimed: true,
      })
      const result = await runCli(['library', 'approve', 'job-gone-1', '--db', dbPath])
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toContain('approved 0 of 1')
      expect(result.stderr).toContain('already reclaimed')
    },
    60000,
  )

  it.concurrent(
    '`library approve` exits 0 when an id approves normally',
    async () => {
      const dbPath = tmpDbPath()
      seedLibraryRow(dbPath, { jobId: 'job-ok-1', channel: 'demo', state: 'needs-review' })
      const result = await runCli(['library', 'approve', 'job-ok-1', '--db', dbPath])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('approved 1 of 1')
    },
    60000,
  )
})

describe('brainrot CLI — publish and publishes', () => {
  it.concurrent(
    '`publish --help` lists the retry/mark-done subcommands',
    async () => {
      const result = await runCli(['publish', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('retry')
      expect(result.stdout).toContain('mark-done')
    },
    60000,
  )

  it.concurrent(
    '`publish retry` on a job with no interrupted publish exits 1 naming the job',
    async () => {
      const dbPath = tmpDbPath()
      const result = await runCli(['publish', 'retry', 'no-such-job', '--db', dbPath])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('no interrupted publish for job no-such-job')
    },
    60000,
  )

  it.concurrent(
    '`publish retry` on a job with an interrupted publish clears it and returns the job to the pool',
    async () => {
      const dbPath = tmpDbPath()
      seedPublishRow(dbPath, {
        jobId: 'job-retry-1',
        channel: 'demo',
        day: '2026-07-22',
        seq: 1,
        status: 'interrupted',
      })
      const result = await runCli(['publish', 'retry', 'job-retry-1', '--db', dbPath])
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
    },
    60000,
  )

  it.concurrent(
    '`publish mark-done` on a job with no interrupted publish exits 1 naming the job',
    async () => {
      const dbPath = tmpDbPath()
      const result = await runCli([
        'publish',
        'mark-done',
        'no-such-job',
        'yt-post-1',
        '--db',
        dbPath,
      ])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('no interrupted publish for job no-such-job')
    },
    60000,
  )

  it.concurrent(
    '`publish mark-done` on a job with an interrupted publish marks it done and flips the library row',
    async () => {
      const dbPath = tmpDbPath()
      seedPublishRow(dbPath, {
        jobId: 'job-done-1',
        channel: 'demo',
        day: '2026-07-22',
        seq: 1,
        status: 'interrupted',
      })
      const result = await runCli([
        'publish',
        'mark-done',
        'job-done-1',
        'yt-post-1',
        '--db',
        dbPath,
      ])
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
    },
    60000,
  )

  it.concurrent(
    '`publishes --help` lists the list subcommand',
    async () => {
      const result = await runCli(['publishes', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('list')
    },
    60000,
  )

  it.concurrent(
    '`publishes list` on an empty db prints a friendly empty message',
    async () => {
      const dbPath = tmpDbPath()
      const result = await runCli(['publishes', 'list', '--db', dbPath])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('no publishes in the last 7 days')
    },
    60000,
  )

  it.concurrent(
    '`publishes list` prints day/seq/channel/platform/status/attempt/jobId and the url or error',
    async () => {
      const dbPath = tmpDbPath()
      seedPublishRow(dbPath, {
        jobId: 'job-list-done',
        channel: 'demo',
        day: '2026-07-22',
        seq: 1,
        status: 'done',
        postId: 'yt-1',
        url: 'https://youtube.com/shorts/yt-1',
        attempt: 1,
      })
      seedPublishRow(dbPath, {
        jobId: 'job-list-failed',
        channel: 'demo',
        day: '2026-07-22',
        seq: 2,
        status: 'failed',
        error: 'upload rejected: bad file',
        errorKind: 'rejected',
        attempt: 2,
      })
      const result = await runCli(['publishes', 'list', '--db', dbPath])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(
        '2026-07-22 #1 demo youtube done attempt 1 job-list-done https://youtube.com/shorts/yt-1',
      )
      expect(result.stdout).toContain(
        '2026-07-22 #2 demo youtube failed attempt 2 job-list-failed upload rejected: bad file',
      )
    },
    60000,
  )

  it.concurrent(
    '`publishes list --days garbage` exits 1 before opening the db',
    async () => {
      const dbPath = tmpDbPath()
      const result = await runCli(['publishes', 'list', '--days', 'garbage', '--db', dbPath])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('invalid --days "garbage"')
    },
    60000,
  )
})

describe('run', () => {
  it(
    'starts, emits daemon-started, and exits 0 on SIGTERM',
    async () => {
      const dbPath = tmpDbPath()
      const channelsDir = tmpDir('brainrot-run-channels-')
      const child = spawn(
        'node',
        [CLI_ENTRY, 'run', '--db', dbPath, '--channels-dir', channelsDir],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
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
        // action === 'daemon-started', capped at 10s.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(
              new Error(
                `timed out waiting for daemon-started; stdout=${stdout} stderr=${stderr}`,
              ),
            )
          }, 10_000)
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
    },
    20_000,
  )
})
