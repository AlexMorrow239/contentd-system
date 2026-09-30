import { redirect } from 'next/navigation'
import { jobsUrl, parseJobFilters } from '../../lib/shared/job-filters'
import type { PageProps } from '../../components/page'
export default async function LibraryPage({ searchParams }: PageProps) {
  const search = await searchParams
  redirect(jobsUrl(parseJobFilters({ channel: search.channel, review: search.state })))
}
