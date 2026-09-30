import { redirect } from 'next/navigation'
export default function PostsPage() {
  redirect('/jobs?posting=has-posts')
}
