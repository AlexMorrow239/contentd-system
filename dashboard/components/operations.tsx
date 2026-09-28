import { notFound } from 'next/navigation'
import {
  JOB_STATUSES,
  countJobs,
  listJobs,
  jobChannels,
  getJobDetail,
} from '../../src/dashboard/queries/jobs'
import {
  countLibraryEntries,
  listLibraryEntries,
  libraryChannels,
} from '../../src/dashboard/queries/library'
import { countTopics, topicChannels } from '../../src/dashboard/queries/topics'
import { TOPIC_STATUSES, listTopics } from '../../src/scout/topics'
import { LIBRARY_STATES } from '../../src/jobs/library'
import { tryLoadChannelsDir } from '../../src/config/channel'
import { formatUsdMicros } from '../../src/money'
import { DashboardPage, pick, value, type PageProps } from './page'
import { ActionForm } from './action-form'
import {
  ActionDetail,
  Filters,
  JobLink,
  SafeLink,
  Status,
  Table,
  Truncation,
  Video,
  formatDuration,
  formatTime,
} from './ui'
import {
  ACTIONS,
  actionArgNames,
  actionArgFieldKind,
  isActionKind,
} from '../../src/actions/catalog'
import {
  ACTIONS_PAGE_LIMIT,
  actionsTableExists,
  hasActiveAction,
} from '../../src/dashboard/queries/actions'
import { listRecentActions } from '../../src/actions/queue'
import { sameSitePath } from '../../src/dashboard/navigation'

export function JobsPage(props: PageProps) {
  return (
    <DashboardPage {...props}>
      {(db, ctx) => {
        const filter = {
          channel: value(ctx.search, 'channel'),
          status: pick(JOB_STATUSES, value(ctx.search, 'status')),
        }
        const jobs = listJobs(db, filter)
        const channels = tryLoadChannelsDir(ctx.config.paths.channelsDir)
        return (
          <>
            <h1>Jobs</h1>
            <p className="subtitle">Production progress, costs, and recovery.</p>
            {channels.error && <p className="warning">Channel config error: {channels.error}</p>}
            <div className="page-actions">
              <ActionForm kind="produce.next" token={ctx.token} disabled={ctx.stale} />
              <ActionForm
                kind="jobs.produce"
                token={ctx.token}
                disabled={ctx.stale || channels.channels.length === 0}
              >
                <label>
                  Channel
                  <select name="channel">
                    {channels.channels.map((c) => (
                      <option key={c.name}>{c.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Topic
                  <input name="topic" required placeholder="What should we make?" />
                </label>
              </ActionForm>
            </div>
            <Filters
              path="/jobs"
              filters={[
                { name: 'channel', values: jobChannels(db), selected: filter.channel },
                { name: 'status', values: JOB_STATUSES, selected: filter.status },
              ]}
            />
            <Truncation shown={jobs.length} total={countJobs(db, filter)} />
            {jobs.length === 0 ? (
              <p className="empty">No jobs match these filters.</p>
            ) : (
              <Table
                headings={[
                  'Job',
                  'Channel',
                  'Tier',
                  'Topic',
                  'Status',
                  'Created',
                  'Elapsed',
                  'Cost',
                  'Actions',
                ]}
              >
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <JobLink id={job.id} />
                    </td>
                    <td>{job.channel}</td>
                    <td>{job.tier}</td>
                    <td>{job.topic}</td>
                    <td>
                      <Status value={job.status} />
                    </td>
                    <td>{formatTime(job.createdAt)}</td>
                    <td>{formatDuration(job.createdAt, job.finishedAt)}</td>
                    <td>{formatUsdMicros(job.costUsdMicros)}</td>
                    <td>
                      {['failed', 'blocked'].includes(job.status) && (
                        <ActionForm
                          kind="jobs.resume"
                          token={ctx.token}
                          fields={{ jobId: job.id }}
                          disabled={ctx.stale}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </>
        )
      }}
    </DashboardPage>
  )
}

export function JobPage(props: PageProps & { jobId: string }) {
  return (
    <DashboardPage {...props}>
      {(db, ctx) => {
        const detail = getJobDetail(db, props.jobId)
        if (detail === null) notFound()
        const { job } = detail
        return (
          <>
            <h1>Job {job.id}</h1>
            <section className="panel">
              <h2>{job.topic}</h2>
              <dl className="facts">
                <dt>Channel</dt>
                <dd>{job.channel}</dd>
                <dt>Tier</dt>
                <dd>{job.tier}</dd>
                <dt>Status</dt>
                <dd>
                  <Status value={job.status} />
                </dd>
                <dt>Created</dt>
                <dd>{formatTime(job.createdAt)}</dd>
                <dt>Finished</dt>
                <dd>{formatTime(job.finishedAt)}</dd>
                <dt>Total spend</dt>
                <dd>{formatUsdMicros(job.costUsdMicros)}</dd>
                <dt>Library</dt>
                <dd>{detail.libraryState ?? 'Not in library'}</dd>
                <dt>Artifacts</dt>
                <dd>
                  <code>
                    {ctx.config.paths.runsRoot}/{job.id}/
                  </code>
                </dd>
              </dl>
            </section>
            {detail.bytes && (
              <section className="panel">
                <h2>Video</h2>
                <Video bytes={detail.bytes} jobId={job.id} />
                {detail.links.map((link) => (
                  <p key={link.platform}>
                    <SafeLink url={link.url}>{link.platform}</SafeLink>
                  </p>
                ))}
              </section>
            )}
            <section className="panel">
              <h2>Stages</h2>
              <Table headings={['Stage', 'Status', 'Duration', 'Started / error']}>
                {detail.stages.map((stage) => (
                  <tr key={stage.stage}>
                    <td>{stage.stage}</td>
                    <td>
                      <Status value={stage.status} />
                    </td>
                    <td>{formatDuration(stage.startedAt, stage.finishedAt)}</td>
                    <td>
                      {formatTime(stage.startedAt)}
                      {stage.error && <p className="error">{stage.error}</p>}
                    </td>
                  </tr>
                ))}
              </Table>
            </section>
            <section className="panel">
              <h2>Spend</h2>
              {detail.costs.length === 0 ? (
                <p className="empty">No ledgered spend.</p>
              ) : (
                <Table headings={['Provider', 'Operation', 'Cost', 'At']}>
                  {detail.costs.map((cost, i) => (
                    <tr key={i}>
                      <td>{cost.provider}</td>
                      <td>{cost.operation}</td>
                      <td>{formatUsdMicros(cost.usdMicros)}</td>
                      <td>{formatTime(cost.createdAt)}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </section>
            <a href="/jobs">← All jobs</a>
          </>
        )
      }}
    </DashboardPage>
  )
}

export function LibraryPage(props: PageProps) {
  return (
    <DashboardPage {...props}>
      {(db, ctx) => {
        const filter = {
          channel: value(ctx.search, 'channel'),
          state: pick(LIBRARY_STATES, value(ctx.search, 'state')),
        }
        const entries = listLibraryEntries(db, filter)
        return (
          <>
            <h1>Library</h1>
            <p className="subtitle">Finished videos and quality checks.</p>
            <div className="page-actions">
              <ActionForm kind="library.backfillStore" token={ctx.token} disabled={ctx.stale} />
            </div>
            <Filters
              path="/library"
              filters={[
                { name: 'channel', values: libraryChannels(db), selected: filter.channel },
                { name: 'state', values: LIBRARY_STATES, selected: filter.state },
              ]}
            />
            <Truncation shown={entries.length} total={countLibraryEntries(db, filter)} />
            {entries.length === 0 ? (
              <p className="empty">No library entries match these filters.</p>
            ) : (
              <Table
                headings={['Video', 'Job', 'Topic', 'State', 'Live', 'QC', 'Created', 'Actions']}
              >
                {entries.map((entry) => (
                  <tr key={entry.jobId}>
                    <td>
                      <Video bytes={entry.bytes} jobId={entry.jobId} />
                    </td>
                    <td>
                      <JobLink id={entry.jobId} />
                      <p className="muted">{entry.channel}</p>
                    </td>
                    <td>{entry.topic}</td>
                    <td>
                      <Status value={entry.state} />
                    </td>
                    <td>
                      {entry.links.length === 0
                        ? '—'
                        : entry.links.map((link) => (
                            <p key={link.platform}>
                              <SafeLink url={link.url}>{link.platform}</SafeLink>
                            </p>
                          ))}
                    </td>
                    <td>
                      {entry.qc.kind === 'issues' ? (
                        <ul className="error">
                          {entry.qc.issues.map((issue, i) => (
                            <li key={i}>{issue}</li>
                          ))}
                        </ul>
                      ) : entry.qc.kind === 'ok' ? (
                        <Status value="qc ok" />
                      ) : entry.qc.kind === 'unparseable' ? (
                        <span className="warning">Unparseable QC verdict</span>
                      ) : (
                        <span className="muted">No QC verdict</span>
                      )}
                    </td>
                    <td>{formatTime(entry.createdAt)}</td>
                    <td>
                      {entry.state === 'needs-review' && (
                        <ActionForm
                          kind="library.approve"
                          token={ctx.token}
                          fields={{ jobIds: entry.jobId }}
                          disabled={ctx.stale}
                        />
                      )}
                      {entry.state !== 'blocked' && (
                        <ActionForm
                          kind="library.reject"
                          token={ctx.token}
                          fields={{ jobIds: entry.jobId }}
                          disabled={ctx.stale}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </>
        )
      }}
    </DashboardPage>
  )
}

export function TopicsPage(props: PageProps) {
  return (
    <DashboardPage {...props}>
      {(db, ctx) => {
        const filter = {
          channel: value(ctx.search, 'channel'),
          status: pick(TOPIC_STATUSES, value(ctx.search, 'status')),
        }
        const topics = listTopics(db, { ...filter, limit: 200 }).sort(
          (a, b) => b.score - a.score || a.id - b.id,
        )
        return (
          <>
            <h1>Topics</h1>
            <p className="subtitle">Scout candidates and the production queue.</p>
            <div className="page-actions">
              <ActionForm kind="scout.run" token={ctx.token} disabled={ctx.stale} />
              <ActionForm kind="topics.pruneMedia" token={ctx.token} disabled={ctx.stale} />
            </div>
            <Filters
              path="/topics"
              filters={[
                { name: 'channel', values: topicChannels(db), selected: filter.channel },
                { name: 'status', values: TOPIC_STATUSES, selected: filter.status },
              ]}
            />
            <Truncation shown={topics.length} total={countTopics(db, filter)} />
            {topics.length === 0 ? (
              <p className="empty">No topics match these filters.</p>
            ) : (
              <Table
                headings={[
                  'Score',
                  'Title',
                  'Channel',
                  'Status',
                  'Job',
                  'Source',
                  'Reason',
                  'Found',
                  'Actions',
                ]}
              >
                {topics.map((topic) => (
                  <tr key={topic.id}>
                    <td>{topic.score}</td>
                    <td>{topic.title}</td>
                    <td>{topic.channel}</td>
                    <td>
                      <Status value={topic.status} />
                    </td>
                    <td>{topic.jobId ? <JobLink id={topic.jobId} /> : '—'}</td>
                    <td>
                      <SafeLink url={topic.url}>{topic.source}</SafeLink>
                    </td>
                    <td>{topic.reason}</td>
                    <td>{formatTime(topic.createdAt)}</td>
                    <td>
                      {topic.status === 'candidate' && (
                        <ActionForm
                          kind="topics.reject"
                          token={ctx.token}
                          fields={{ ids: String(topic.id) }}
                          disabled={ctx.stale}
                        />
                      )}
                      {topic.status === 'claimed' && (
                        <ActionForm
                          kind="topics.requeue"
                          token={ctx.token}
                          fields={{ id: String(topic.id) }}
                          disabled={ctx.stale}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </>
        )
      }}
    </DashboardPage>
  )
}

export function ActionsPage(props: PageProps) {
  return (
    <DashboardPage
      {...props}
      refreshSeconds={(db) => (actionsTableExists(db) && hasActiveAction(db) ? 3 : undefined)}
    >
      {(db) => {
        if (!actionsTableExists(db))
          return (
            <>
              <h1>Actions</h1>
              <p className="warning">
                This database has no action queue yet — start the daemon once against this root to
                initialize the schema.
              </p>
            </>
          )
        const actions = listRecentActions(db, ACTIONS_PAGE_LIMIT)
        return (
          <>
            <h1>Actions</h1>
            <p className="subtitle">Operator requests, executed by the daemon.</p>
            {actions.length === 0 ? (
              <p className="empty">No operator actions yet.</p>
            ) : (
              actions.map((action) => <ActionDetail key={action.id} action={action} />)
            )}
          </>
        )
      }}
    </DashboardPage>
  )
}

export function ConfirmPage(props: PageProps) {
  return (
    <DashboardPage {...props}>
      {(_db, ctx) => {
        const kind = value(ctx.search, 'kind') ?? ''
        if (!isActionKind(kind) || !ACTIONS[kind].confirm)
          return (
            <>
              <h1>Invalid action</h1>
              <p className="error">No confirmation step for {kind}.</p>
            </>
          )
        const fields: Record<string, string> = {}
        const missing = actionArgNames(kind).filter((name) => {
          const raw = value(ctx.search, name)
          if (raw === undefined) return true
          fields[name] = raw
          return false
        })
        const from = sameSitePath(value(ctx.search, 'from') ?? '') ?? '/actions'
        return (
          <>
            <h1>Confirm: {ACTIONS[kind].label}</h1>
            <section className="panel">
              <p className="warning">{ACTIONS[kind].danger ?? 'This action cannot be undone.'}</p>
              <dl className="facts">
                {Object.entries(fields).map(([name, val]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>
                      <code>{val}</code>
                    </dd>
                  </div>
                ))}
              </dl>
              <ActionForm
                kind={kind}
                token={ctx.token}
                fields={fields}
                disabled={ctx.stale}
                confirmed
                from={from}
              >
                {missing.map((name) => {
                  const type = actionArgFieldKind(kind, name)
                  return (
                    <label key={name} className="field">
                      {name}
                      <input
                        name={name}
                        type={type === 'checkbox' ? 'checkbox' : 'text'}
                        value={type === 'checkbox' ? '1' : undefined}
                        required={type === 'text'}
                        autoComplete="off"
                      />
                    </label>
                  )
                })}
              </ActionForm>
              <a href={from}>Cancel</a>
            </section>
          </>
        )
      }}
    </DashboardPage>
  )
}
