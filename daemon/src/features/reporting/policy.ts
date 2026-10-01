// A job 'running' longer than this has almost certainly lost its process —
// real runs finish in minutes. Digest-only visibility: auto-resume never
// touches running jobs; the operator resumes with --force.
export const ZOMBIE_RUNNING_MS = 7_200_000 // 2 h

// A job still 'queued' this long after creation was almost certainly stranded
// by a crash (or SQLITE_BUSY) between produce-next's claim transaction commit
// and runJob's first status write. resumeJob now accepts such jobs, but nothing
// auto-surfaces them (planTick only acts on 'blocked'), so the digest is the
// only place the strand becomes visible. Real runs flip off 'queued' in ms.
export const STRANDED_QUEUED_MS = 3_600_000 // 1 h

// Failures are listed newest-first-window, oldest-first-printed: past this
// many, fresh failures would be buried under a wall of history the operator
// has already seen. The remainder is still counted, never silently dropped.
export const FAILED_JOBS_LIMIT = 10
