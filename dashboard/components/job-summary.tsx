import type { JobListRow } from '../lib/server/queries/jobs'
import type { QcSummary } from '../lib/server/queries/library'
import { Status } from './ui'

export function QcResult({ qc, compact = false }: { qc: QcSummary; compact?: boolean }) {
  if (qc.kind === 'ok') return <span className="status-ok">QC passed</span>
  if (qc.kind === 'absent') return <span className="muted">No QC verdict</span>
  if (qc.kind === 'unparseable') return <span className="warning">Unreadable QC verdict</span>
  return compact ? (
    <span className="warning">
      {qc.issues.length} QC {qc.issues.length === 1 ? 'issue' : 'issues'}
    </span>
  ) : (
    <ul className="error">
      {qc.issues.map((issue, i) => (
        <li key={i}>{issue}</li>
      ))}
    </ul>
  )
}

export function VideoSummary({ video }: { video: JobListRow['video'] }) {
  if (!video) return <span className="muted">No video</span>
  return (
    <>
      <Status value={video.state === 'blocked' ? 'discarded' : video.state} />
      <p className="job-secondary">
        <QcResult qc={video.qc} compact />
        {video.bytes === 'missing' && <> · File missing</>}
      </p>
    </>
  )
}

export function PostingSummary({ posting }: { posting: JobListRow['posting'] }) {
  if (!posting) return <span className="muted">—</span>
  if (posting.kind === 'unconfigured') return <span className="muted">Platforms unavailable</span>
  return (
    <span className={posting.kind === 'full' ? 'status-ok' : 'muted'}>
      {posting.posted}/{posting.total} posted
    </span>
  )
}
