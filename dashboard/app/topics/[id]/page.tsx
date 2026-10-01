import Link from 'next/link'
import { notFound } from 'next/navigation'
import { DashboardPage, value, type PageProps } from '../../../components/page'
import { JobWorkspace } from '../../../components/job-action-state'
import { TopicActions } from '../../../components/topic-actions'
import { TopicSource } from '../../../components/topic-source'
import { JobLink, SafeLink, Status, formatTime } from '../../../components/ui'
import { getTopic, topicActions } from '../../../lib/server/queries/topics'
import { sameSitePath } from '../../../lib/shared/navigation'

export default async function TopicPage(props: PageProps & { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) notFound()
  return (
    <DashboardPage {...props} refreshSeconds={3} compactActions>
      {(db, ctx) => {
        const topic = getTopic(db, Number(id))
        if (!topic) notFound()
        const candidate = sameSitePath(value(ctx.search, 'from') ?? '')
        const back =
          candidate && new URL(candidate, 'http://dashboard.invalid').pathname === '/topics'
            ? candidate
            : '/topics'
        const source = topic.sourceContext
        return (
          <JobWorkspace>
            <Link className="back-link" href={back}>
              Back to topics
            </Link>
            <h1>Topic #{topic.id}</h1>
            <div className="page-actions">
              <TopicActions
                topic={topic}
                action={topicActions(db, [topic.id]).get(topic.id) ?? null}
                token={ctx.token}
                disabled={ctx.stale}
              />
            </div>
            <section className="panel">
              <h2>{topic.title}</h2>
              <dl className="facts">
                <dt>Channel</dt>
                <dd>{topic.channel}</dd>
                <dt>Status</dt>
                <dd>
                  <Status value={topic.status} />
                </dd>
                <dt>Score</dt>
                <dd>{topic.score}/100</dd>
                <dt>Found</dt>
                <dd>{formatTime(topic.createdAt)}</dd>
                <dt>Job</dt>
                <dd>{topic.jobId ? <JobLink id={topic.jobId} /> : 'No job assigned'}</dd>
                <dt>Source material</dt>
                <dd>
                  <TopicSource topic={topic} />
                </dd>
              </dl>
            </section>
            <section className="panel">
              <h2>Scoring reason</h2>
              <p className="topic-body">{topic.reason}</p>
            </section>
            <section className="panel">
              <h2>Original post</h2>
              <dl className="facts">
                <dt>Original title</dt>
                <dd>{topic.rawTitle}</dd>
                <dt>Source</dt>
                <dd>{topic.source}</dd>
                <dt>Post URL</dt>
                <dd>
                  <SafeLink url={topic.url}>{topic.url}</SafeLink>
                </dd>
                <dt>Target URL</dt>
                <dd>
                  {topic.targetUrl ? (
                    <SafeLink url={topic.targetUrl}>{topic.targetUrl}</SafeLink>
                  ) : (
                    '—'
                  )}
                </dd>
                <dt>Author</dt>
                <dd>{source?.author ?? 'Not available'}</dd>
                <dt>Published</dt>
                <dd>{formatTime(source?.publishedAt ?? null)}</dd>
                <dt>Snapshot captured</dt>
                <dd>{formatTime(source?.fetchedAt ?? null)}</dd>
                <dt>External ID</dt>
                <dd>{source?.externalId ?? '—'}</dd>
              </dl>
              <h3>Post body</h3>
              {source?.body?.trim() ? (
                <div className="topic-body">{source.body}</div>
              ) : (
                <p className="empty">
                  {source
                    ? 'No post body saved. This snapshot contains metadata only.'
                    : 'No source snapshot saved for this topic.'}
                </p>
              )}
            </section>
            {topic.bodyText !== null && (
              <section className="panel">
                <h2>
                  Story part {topic.partIndex} of {topic.partCount}
                </h2>
                <p className="muted">Series: {topic.seriesKey}</p>
                {topic.truncated && <p className="warning">This story series was truncated.</p>}
                <div className="topic-body">{topic.bodyText}</div>
              </section>
            )}
          </JobWorkspace>
        )
      }}
    </DashboardPage>
  )
}
