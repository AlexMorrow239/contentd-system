import { tryLoadChannelsDir } from '../../../src/config/channel'
import { listPostQueue } from '../../../src/dashboard/queries/post'
import { DashboardPage, type PageProps } from '../../components/page'
import { PostCard } from '../../components/post-card'
export default function PostPage(props: PageProps) {
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
                <PostCard key={card.jobId} card={card} token={ctx.token} disabled={ctx.stale} />
              ))
            )}
          </>
        )
      }}
    </DashboardPage>
  )
}
