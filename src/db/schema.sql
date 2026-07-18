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
CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id),
  provider TEXT NOT NULL, operation TEXT NOT NULL, usd_micros INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS bg_usage (
  channel TEXT NOT NULL, file TEXT NOT NULL, used_at TEXT NOT NULL,
  PRIMARY KEY (channel, file, used_at)
);
-- topics & publishes tables arrive in Plans 2 and 3.
