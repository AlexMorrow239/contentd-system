import { afterAll, describe, expect, it } from 'vitest'
import { execa } from 'execa'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDb } from './db/index.js'
import { parsePublishDays, parseTopicIds, pipelineStages } from './cli.js'
import { visualsVolumeStage } from './stages/visuals-volume.js'

const cleanup: string[] = []
function tmpDbPath(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'brainrot-cli-'))
  cleanup.push(d)
  return path.join(d, 'brainrot.db')
}

afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true })
})

describe('brainrot CLI', () => {
  it('`jobs` opens the db and prints a table header, exiting 0', async () => {
    const dbPath = tmpDbPath()
    // Seed one job so console.table renders column headers (empty tables print nothing).
    const db = openDb(dbPath)
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1', 'example', 'volume', 'venus', 'queued')",
    ).run()
    db.close()

    const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'jobs', '--db', dbPath], {
      reject: false,
    })
    expect(result.exitCode).toBe(0)
    // console.table header row names the selected columns.
    expect(result.stdout).toContain('status')
  }, 60000)

  it('`produce --help` prints usage with --channel/--topic', async () => {
    const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'produce', '--help'], {
      reject: false,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--channel')
    expect(result.stdout).toContain('--topic')
  }, 60000)

  function countJobs(dbPath: string): number {
    const db = openDb(dbPath)
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }
    db.close()
    return n
  }

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

  it('`produce` with a nonexistent --channel exits 1 with a clean one-line error (no stack)', async () => {
    const dbPath = tmpDbPath()
    const result = await execa(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'produce',
        '--channel', '/no/such/channel.toml', '--topic', 'venus', '--db', dbPath],
      { reject: false },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/ENOENT|no such file/)
    // Just the message — no raw unhandled-rejection stack frames ("    at ...").
    expect(result.stderr).not.toMatch(/\n\s+at /)
    expect(countJobs(dbPath)).toBe(0)
  }, 60000)

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
    // filename must equal the channel name (loadChannelsDir invariant)
    writeFileSync(path.join(channelsDir, 'cli-scout-test.toml'), SCOUTLESS_TOML)
    const result = await execa(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'scout', '--db', dbPath, '--channels-dir', channelsDir],
      { reject: false },
    )
    expect(result.exitCode).toBe(0)
    // exactly one cron-greppable JSON line on stdout
    expect(JSON.parse(result.stdout)).toEqual({ channels: [] })
  }, 60000)

  // The same G14 symptom the two loops already fixed: a broken channels dir
  // used to exit 1 with an empty stdout, punching a hole in the cron log of
  // JSON lines every scout firing until someone noticed.
  it('`scout` over a broken channels dir still prints one JSON line and exits 0', async () => {
    const dbPath = tmpDbPath()
    const brokenDir = mkdtempSync(path.join(tmpdir(), 'brainrot-scout-broken-'))
    cleanup.push(brokenDir)
    writeFileSync(path.join(brokenDir, 'broken.toml'), 'this is not toml [')
    const result = await execa(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'scout', '--db', dbPath, '--channels-dir', brokenDir],
      { reject: false },
    )
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
  }, 60000)

  it('`scout` no-ops under a held lease, and releases its own lease on a clean run', async () => {
    const dbPath = tmpDbPath()
    const channelsDir = mkdtempSync(path.join(tmpdir(), 'brainrot-scout-lease-'))
    cleanup.push(channelsDir)
    writeFileSync(path.join(channelsDir, 'cli-scout-test.toml'), SCOUTLESS_TOML)
    const seeded = openDb(dbPath)
    seeded
      .prepare('INSERT INTO leases (name, holder, expires_at) VALUES (?, ?, ?)')
      .run('scout', 'pid:999999', new Date(Date.now() + 600_000).toISOString())
    seeded.close()

    const args = ['exec', 'tsx', 'src/cli.ts', 'scout', '--db', dbPath, '--channels-dir', channelsDir]
    const held = await execa('pnpm', args, { reject: false })
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

    const free = await execa('pnpm', args, { reject: false })
    expect(free.exitCode).toBe(0)
    expect(JSON.parse(free.stdout)).toEqual({ channels: [] })
    const afterRun = openDb(dbPath)
    const leases = afterRun.prepare("SELECT COUNT(*) AS n FROM leases WHERE name = 'scout'").get()
    afterRun.close()
    expect(leases).toEqual({ n: 0 })
  }, 60000)

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
        "INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status, job_id) " +
          "VALUES ('demo', 'T', 'R', 'reddit:r/space', 'https://example.com/1', 'h1', 80, 'seeded', 'claimed', ?)",
      )
      .run(opts.jobId)
    db.close()
    return Number(res.lastInsertRowid)
  }

  it('`topics requeue` returns an orphaned claimed topic to the queue', async () => {
    const dbPath = tmpDbPath()
    const id = seedClaimedTopic(dbPath, { jobId: 'job-stranded', jobStatus: 'failed' })
    const result = await execa(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'topics', 'requeue', String(id), '--db', dbPath],
      { reject: false },
    )
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ action: 'requeued', topicId: id })
    const db = openDb(dbPath)
    const row = db.prepare('SELECT status, job_id FROM topics WHERE id = ?').get(id) as {
      status: string
      job_id: string | null
    }
    db.close()
    expect(row).toEqual({ status: 'candidate', job_id: null })
  }, 60000)

  it('`topics requeue` refuses while a live job holds the topic, naming the job', async () => {
    const dbPath = tmpDbPath()
    const id = seedClaimedTopic(dbPath, { jobId: 'job-live', jobStatus: 'running' })
    const result = await execa(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'topics', 'requeue', String(id), '--db', dbPath],
      { reject: false },
    )
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
  }, 60000)

  it('`topics requeue` on an unknown id exits 1 with one JSON line and no stack', async () => {
    const dbPath = tmpDbPath()
    const result = await execa(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'topics', 'requeue', '9999', '--db', dbPath],
      { reject: false },
    )
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({
      action: 'refused',
      topicId: 9999,
      reason: 'unknown',
    })
    expect(result.stderr).not.toMatch(/\n\s+at /)
  }, 60000)

  it('`topics requeue` rejects a non-integer id before opening the db', async () => {
    const dbPath = tmpDbPath()
    const result = await execa(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'topics', 'requeue', 'abc', '--db', dbPath],
      { reject: false },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('invalid topic id "abc"')
  }, 60000)

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

  // A channels dir that will not load used to cost the operator the whole
  // report — one stderr line and nothing else, on the morning it matters most.
  it('`digest` with a missing channels dir still prints the db sections and names the config error', async () => {
    const dbPath = tmpDbPath()
    const result = await execa(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'digest',
        '--db', dbPath, '--channels-dir', '/no/such/channels-dir'],
      { reject: false },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Topics (last 24h)')
    expect(result.stdout).toContain('Jobs (last 24h)')
    expect(result.stdout).toContain('Action items')
    expect(result.stdout).toContain('the channels dir did not load')
    expect(result.stdout).toMatch(/ENOENT|no such/)
  }, 60000)

  it('`digest` with an unparseable channel TOML still prints the db sections and names the file', async () => {
    const dbPath = tmpDbPath()
    const channelsDir = mkdtempSync(path.join(tmpdir(), 'brainrot-digest-broken-'))
    cleanup.push(channelsDir)
    writeFileSync(path.join(channelsDir, 'broken.toml'), 'this is not toml [')
    const result = await execa(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'digest', '--db', dbPath, '--channels-dir', channelsDir],
      { reject: false },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Topics (last 24h)')
    expect(result.stdout).toContain('Jobs (last 24h)')
    expect(result.stdout).toContain('the channels dir did not load')
    expect(result.stdout).toContain('broken.toml')
  }, 60000)

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
})

describe('pipelineStages (in-process)', () => {
  it('returns the fixed stage list', () => {
    const stages = pipelineStages()
    const order = ['script', 'voice', 'captions', 'visuals', 'assemble', 'qc']
    expect(stages.map((s) => s.name)).toEqual(order)
    expect(stages[3]).toBe(visualsVolumeStage)
  })
})

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
