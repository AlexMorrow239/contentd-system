import { JobPage } from '../../../components/operations'
import type { PageProps } from '../../../components/page'
export default async function Page(props: PageProps & { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  return <JobPage {...props} jobId={id} />
}
