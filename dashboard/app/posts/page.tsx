import { listPostLog } from '../../lib/server/queries/posts'
import { DashboardPage, type PageProps } from '../../components/page'
import { JobLink, SafeLink, Table, formatTime } from '../../components/ui'
export default function PostsPage(props: PageProps) {
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
