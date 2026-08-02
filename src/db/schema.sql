CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, channel TEXT NOT NULL, tier TEXT NOT NULL CHECK (tier IN ('volume','premium')),
  topic TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','failed','done','blocked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS job_stages (
  job_id TEXT NOT NULL REFERENCES jobs(id), stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  error TEXT, started_at TEXT, finished_at TEXT,
  PRIMARY KEY (job_id, stage)
);
CREATE TABLE IF NOT EXISTS library (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id), video_path TEXT NOT NULL, metadata_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready','needs-review','published','blocked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS library_objects (
  job_id TEXT PRIMARY KEY REFERENCES library(job_id),
  object_key TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  etag TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Set when the sweep in publish/reclaim.ts deleted the object because every
  -- platform the channel declares had a settled leg. The row itself SURVIVES
  -- as the record of what was there: unstoredLibraryJobs finds backfill
  -- candidates by the ABSENCE of a row, so keeping it is what stops
  -- `library backfill-store` from re-uploading what the sweep deleted.
  reclaimed_at TEXT
);
CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id),
  provider TEXT NOT NULL, operation TEXT NOT NULL, usd_micros INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS bg_usage (
  channel TEXT NOT NULL, file TEXT NOT NULL, used_at TEXT NOT NULL,
  PRIMARY KEY (channel, file, used_at)
);
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL, title TEXT NOT NULL,
  raw_title TEXT NOT NULL, source TEXT NOT NULL,
  -- url is the reddit COMMENTS permalink; target_url is what the submission
  -- actually points at (an article, an image host, its own permalink for a
  -- self post). Nullable: an RSS item has no submission target, and rows
  -- written before this column existed have none either.
  url TEXT NOT NULL, target_url TEXT, dedupe_hash TEXT NOT NULL,
  score INTEGER NOT NULL, reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate','claimed','used','rejected')),
  job_id TEXT,
  -- Story mode (channels with a [story] table): one row per PART of one
  -- reddit self post. body_text is the narratable text of this part alone;
  -- series_key groups the parts of one post; part_index is 1-based; truncated
  -- marks a series cut short by max_parts, so the final part appends a pointer
  -- to the source. All null for topic-mode rows and for every row written
  -- before story mode existed.
  body_text TEXT, series_key TEXT, part_index INTEGER, part_count INTEGER,
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (channel, dedupe_hash)
);
-- The two story indexes are created by db/migrate.ts, NOT here: openDb execs
-- this file BEFORE calling migrate, so an index over the series_key/part_index
-- columns would throw on every existing database—those columns arrive via
-- migrate's ALTER TABLE. A failure during schema.sql wedges the whole CLI, so
-- this follows the same rule as ux_publishes_live below. Both are kept in
-- migrate.ts for cohesion even though ix_topics_job could safely live here
-- (job_id exists in all databases). They are named here so the shape reads
-- complete and migrate.ts can stay the single source of truth for column
-- creation:
--   CREATE INDEX IF NOT EXISTS ix_topics_job    ON topics (job_id);
--   CREATE INDEX IF NOT EXISTS ix_topics_series ON topics (series_key, part_index);
CREATE TABLE IF NOT EXISTS leases (
  name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS publishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  platform TEXT NOT NULL,
  channel TEXT NOT NULL,
  day TEXT NOT NULL,      -- local YYYY-MM-DD the attempt was made on
  seq INTEGER NOT NULL,   -- 1-based ordinal within (channel, platform, day)
  status TEXT NOT NULL CHECK (status IN ('claimed','done','failed','interrupted')),
  post_id TEXT, url TEXT, error TEXT,
  error_kind TEXT CHECK (error_kind IN ('auth','quota','rejected','transient')),  -- null unless failed
  attempt INTEGER NOT NULL,   -- 1-based ordinal per (job_id, platform)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  -- Bookkeeping only: seq is derived from existing rows, so two racing claims
  -- get distinct ordinals rather than colliding. The double-publish backstop is
  -- the partial index below.
  UNIQUE (channel, platform, day, seq)
);
-- At most one live (claimed/done/interrupted) row per (job_id, platform) — the
-- database-level double-publish guard. Created by migrate.ts, NOT here, and
-- that placement is load-bearing: openDb execs this file on every command, so a
-- CREATE UNIQUE INDEX here would throw on any database holding a pre-existing
-- violation and wedge the whole CLI. migrate.ts probes first and reports
-- instead. See ensureLivePublishIndex there for the full rationale.
--   CREATE UNIQUE INDEX ux_publishes_live ON publishes (job_id, platform)
--     WHERE status IN ('claimed','done','interrupted');
-- One row per (video, platform) the operator actually posted. There is no
-- status column on purpose: the row's EXISTENCE is the fact. Correcting a
-- mistake is a DELETE, not a transition. `url` is nullable because pasting
-- the link back is optional record-keeping, not a precondition.
--
-- `channel` is denormalized off `jobs` because every read here is
-- channel-scoped and the join is pure overhead — the same call the deleted
-- `publishes` table made.
CREATE TABLE IF NOT EXISTS posts (
  job_id    TEXT NOT NULL,
  channel   TEXT NOT NULL,
  platform  TEXT NOT NULL,
  url       TEXT,
  posted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (job_id, platform)
);
-- Per-channel scout attempt cadence: channels are config-file entities, not DB
-- rows, so this is the one small table keyed on channel name (mirrors
-- `leases`' PK-keyed shape) recording when a channel was last actually
-- scouted. Backs the SCOUT_RECHECK_MS gate in src/scout/scout.ts, so the gate
-- survives a daemon restart and is shared between the daemon's scout worker
-- and a manual `brainrot scout` run.
CREATE TABLE IF NOT EXISTS scout_state (
  channel TEXT PRIMARY KEY, last_attempt_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  platform TEXT NOT NULL,
  channel TEXT NOT NULL,
  token_ciphertext BLOB NOT NULL,   -- iv (12B) || gcm tag (16B) || ciphertext
  scopes TEXT NOT NULL,
  expires_at TEXT,                  -- NULL = no expiry (YouTube's refresh token)
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (platform, channel)
);

-- The operator-action queue. The dashboard's ONLY write is an INSERT here;
-- the daemon's actions-fast / actions-slow workers drain it and execute each
-- action in-process, under the same leases the produce/publish workers take.
-- That is what makes a dashboard-triggered mutation race-free where the
-- equivalent CLI command is not (see CLAUDE.md, "outside these leases").
--
-- `notice` carries an interactive status an action wants the operator to see
-- before it can proceed. Today the only writer is the worker's lease-blocked
-- path, stamped on a row that is still `pending` (e.g. "waiting for the
-- publish lease"). Once `auth` (phase 3) lands, a running action is expected
-- to use it for an OAuth consent URL the operator must click — never a
-- credential: handlers must record the consent url, never the code or the
-- token.
--
-- Rows are kept indefinitely as an audit log. The table is tiny and the
-- /actions page reads a bounded window, so there is no pruning step.
CREATE TABLE IF NOT EXISTS operator_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('fast','slow')),
  args TEXT NOT NULL,                 -- JSON object, validated against the catalog schema
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','done','failed')),
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT, finished_at TEXT,
  result TEXT,                        -- JSON, the handler's return value
  error TEXT,
  error_kind TEXT,                    -- classify()'s kind
  notice TEXT
);
-- The workers' hot path: "oldest pending row in this lane".
CREATE INDEX IF NOT EXISTS ix_operator_actions_queue
  ON operator_actions (lane, status, id);

-- Daemon liveness, so the dashboard can tell "queued" from "queued into the
-- void". One row, enforced by the CHECK: this is process state, not history.
-- Stamped by the actions-fast worker on a throttle (DAEMON_HEARTBEAT_MS), not
-- on every poll — a 1s poll writing every tick would churn the WAL for nothing.
CREATE TABLE IF NOT EXISTS daemon_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
