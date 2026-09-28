import { tryLoadChannelsDir } from '../../src/config/channel'
import { listPostQueue } from '../../src/dashboard/queries/post'
import { listPostLog } from '../../src/dashboard/queries/posts'
import { DashboardPage, type PageProps } from './page'
import { ActionForm } from './action-form'
import { PasteField } from './controls'
import { JobLink, SafeLink, Table, Video, formatTime } from './ui'
export function PostPage(props: PageProps) {
  return (
    <DashboardPage {...props}>
      {(db, ctx) => {
        const { channels, error } = tryLoadChannelsDir(ctx.config.paths.channelsDir)
        const cards = listPostQueue(db, channels)
        return (
          <>
            <h1>Post</h1>
            <p className="subtitle">Copy the metadata, post the video, then save its link here.</p>
            {error && <p className="warning">Channel config error: {error}</p>}
            {cards.length === 0 ? (
              <p className="empty">Nothing to post — no ready videos with unposted platforms.</p>
            ) : (
              cards.map((card) => (
                <article className="post-card panel" key={card.jobId}>
                  <div className="card-heading">
                    <h2>
                      {card.topic}{' '}
                      {card.seriesLabel && <span className="badge">{card.seriesLabel}</span>}
                    </h2>
                    <p className="muted">
                      {card.channel} · <JobLink id={card.jobId} /> · {formatTime(card.createdAt)}
                    </p>
                  </div>
                  <div className="post-content">
                    <Video bytes={card.bytes} jobId={card.jobId} />
                    <div className="post-platforms">
                      {card.platforms.map((platform) => (
                        <section className="post-platform" key={platform.platform}>
                          <h3>
                            {platform.platform}
                            {platform.posted ? ' — posted' : ''}
                          </h3>
                          {platform.posted ? (
                            <>
                              <SafeLink url={platform.url}>
                                {platform.url ?? 'No link saved'}
                              </SafeLink>
                              <ActionForm
                                kind="post.unmark"
                                token={ctx.token}
                                fields={{ jobId: card.jobId, platform: platform.platform }}
                                disabled={ctx.stale}
                              />
                            </>
                          ) : (
                            <>
                              {platform.title !== null && (
                                <PasteField label="title" value={platform.title} />
                              )}
                              <PasteField
                                label={platform.title === null ? 'caption' : 'description'}
                                value={platform.body}
                              />
                              {platform.tags !== null && (
                                <PasteField label="tags" value={platform.tags} />
                              )}
                              <ActionForm
                                kind="post.mark"
                                token={ctx.token}
                                fields={{ jobId: card.jobId, platform: platform.platform }}
                                disabled={ctx.stale}
                              >
                                <label className="field">
                                  Live link (optional)
                                  <input
                                    type="url"
                                    name="url"
                                    placeholder="https://…"
                                    autoComplete="off"
                                  />
                                </label>
                              </ActionForm>
                            </>
                          )}
                        </section>
                      ))}
                    </div>
                  </div>
                  <div className="page-actions">
                    <ActionForm
                      kind="library.reject"
                      token={ctx.token}
                      fields={{ jobIds: card.jobId }}
                      disabled={ctx.stale}
                    />
                  </div>
                </article>
              ))
            )}
          </>
        )
      }}
    </DashboardPage>
  )
}
export function PostsPage(props: PageProps) {
  return (
    <DashboardPage {...props}>
      {(db) => {
        const posts = listPostLog(db)
        return (
          <>
            <h1>Posts</h1>
            <p className="subtitle">The record of videos posted by hand.</p>
            {posts.length === 0 ? (
              <p className="empty">No posts yet.</p>
            ) : (
              <Table headings={['Posted', 'Platform', 'Channel', 'Topic', 'Job', 'Link']}>
                {posts.map((post) => (
                  <tr key={`${post.jobId}-${post.platform}`}>
                    <td>{formatTime(post.postedAt)}</td>
                    <td>{post.platform}</td>
                    <td>{post.channel}</td>
                    <td>{post.topic}</td>
                    <td>
                      <JobLink id={post.jobId} />
                    </td>
                    <td>
                      <SafeLink url={post.url}>{post.url ?? 'No link saved'}</SafeLink>
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
