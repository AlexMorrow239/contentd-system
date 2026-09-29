import type { PostCard as PostCardData } from '../lib/server/queries/post'
import { ActionForm } from './action-form'
import { PasteField } from './controls'
import { JobLink, SafeLink, Video, formatTime } from './ui'
export function PostCard({
  card,
  token,
  disabled,
}: {
  card: PostCardData
  token: string
  disabled: boolean
}) {
  return (
    <article className="post-card panel">
      <div className="card-heading">
        <h2>
          {card.topic} {card.seriesLabel && <span className="badge">{card.seriesLabel}</span>}
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
                  <SafeLink url={platform.url}>{platform.url ?? 'No link saved'}</SafeLink>
                  <ActionForm
                    kind="post.unmark"
                    token={token}
                    fields={{ jobId: card.jobId, platform: platform.platform }}
                    disabled={disabled}
                  />
                </>
              ) : (
                <>
                  {platform.title !== null && <PasteField label="title" value={platform.title} />}
                  <PasteField
                    label={platform.title === null ? 'caption' : 'description'}
                    value={platform.body}
                  />
                  {platform.tags !== null && <PasteField label="tags" value={platform.tags} />}
                  <ActionForm
                    kind="post.mark"
                    token={token}
                    fields={{ jobId: card.jobId, platform: platform.platform }}
                    disabled={disabled}
                  />
                </>
              )}
            </section>
          ))}
        </div>
      </div>
      <div className="page-actions">
        <ActionForm
          kind="library.reject"
          token={token}
          fields={{ jobIds: card.jobId }}
          disabled={disabled}
        />
      </div>
    </article>
  )
}
