'use client'
import { useEffect } from 'react'
export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])
  return (
    <section className="panel">
      <h1>Something went wrong</h1>
      <p role="alert">
        The dashboard could not render this page. Check the dashboard logs for details.
      </p>
      <button onClick={reset}>Try again</button>
    </section>
  )
}
