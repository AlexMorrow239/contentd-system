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
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
  url TEXT NOT NULL, dedupe_hash TEXT NOT NULL,
  score INTEGER NOT NULL, reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate','claimed','used','rejected')),
  job_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (channel, dedupe_hash)
);
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
CREATE TABLE IF NOT EXISTS oauth_tokens (
  platform TEXT NOT NULL,
  channel TEXT NOT NULL,
  token_ciphertext BLOB NOT NULL,   -- iv (12B) || gcm tag (16B) || ciphertext
  scopes TEXT NOT NULL,
  expires_at TEXT,                  -- NULL = no expiry (YouTube's refresh token)
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (platform, channel)
);
