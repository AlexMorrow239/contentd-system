'use client'
import { useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'

export function Navigation() {
  const pathname = usePathname()
  const items = [
    ['/post', 'Post'],
    ['/', 'Overview'],
    ['/jobs', 'Jobs'],
    ['/topics', 'Topics'],
    ['/actions', 'Actions'],
  ]
  return (
    <nav aria-label="Main navigation">
      {items.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          aria-current={
            pathname === href || (href !== '/' && pathname.startsWith(`${href}/`))
              ? 'page'
              : undefined
          }
        >
          {label}
        </Link>
      ))}
    </nav>
  )
}

export function Refresh({ seconds }: { seconds?: number }) {
  const router = useRouter()
  useEffect(() => {
    if (seconds === undefined) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh()
    }, seconds * 1000)
    return () => clearInterval(timer)
  }, [router, seconds])
  return null
}

export function PasteField({ label, value }: { label: string; value: string }) {
  const [message, setMessage] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setMessage('Copied')
    } catch {
      field.current?.focus()
      field.current?.select()
      setMessage('Select and copy the text manually')
    }
  }
  return (
    <label className="field">
      {label}
      <div className="copy-row">
        <textarea
          ref={field}
          readOnly
          value={value}
          rows={label === 'title' || label === 'tags' ? 2 : 5}
        />
        <button
          type="button"
          onClick={() => {
            void copy()
          }}
        >
          Copy
        </button>
      </div>
      <span role="status">{message}</span>
    </label>
  )
}
