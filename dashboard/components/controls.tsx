'use client'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import type { ActionKind } from '../../daemon/src/actions/catalog'
import { sameSitePath } from '../lib/shared/navigation'

export function Navigation() {
  const pathname = usePathname()
  const items = [
    ['/post', 'Post'],
    ['/', 'Overview'],
    ['/jobs', 'Jobs'],
    ['/library', 'Library'],
    ['/posts', 'Posts'],
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

export interface ActionFormControlProps {
  kind: ActionKind
  token: string
  fields?: Record<string, string>
  disabled?: boolean
  from?: string
  children?: ReactNode
}

/** Rendered through the server `ActionForm`, which keeps the catalog out of the client bundle. */
export function ActionFormControl({
  kind,
  token,
  fields = {},
  disabled = false,
  from,
  children,
  label,
  needsConfirmation,
}: ActionFormControlProps & { label: string; needsConfirmation: boolean }) {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const current = `${pathname}${search.size ? `?${search.toString()}` : ''}`
  const destination = sameSitePath(from ?? current) ?? '/actions'
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current || disabled) return
    submitting.current = true
    setPending(true)
    setError('')
    try {
      const response = await fetch('/api/actions', {
        method: 'POST',
        body: new FormData(event.currentTarget),
      })
      const data: unknown = await response.json()
      if (!response.ok) {
        const message =
          typeof data === 'object' &&
          data !== null &&
          'error' in data &&
          typeof data.error === 'string'
            ? data.error
            : 'Could not queue action.'
        setError(message)
        return
      }
      if (
        typeof data !== 'object' ||
        data === null ||
        !('actionId' in data) ||
        typeof data.actionId !== 'number'
      )
        throw new Error('Invalid response')
      const target = new URL(destination, window.location.origin)
      target.searchParams.set('action', String(data.actionId))
      // The new ?action= URL always differs, so replace() already re-renders.
      router.replace(`${target.pathname}${target.search}`, { scroll: false })
    } catch {
      setError(
        'Could not confirm submission. Check Actions before trying again; it may already be queued.',
      )
    } finally {
      submitting.current = false
      setPending(false)
    }
  }
  return (
    <form
      className="action"
      action={needsConfirmation ? '/actions/confirm' : '/api/actions'}
      method={needsConfirmation ? 'get' : 'post'}
      onSubmit={
        needsConfirmation
          ? undefined
          : (event) => {
              void submit(event)
            }
      }
    >
      <input type="hidden" name="kind" value={kind} />
      {needsConfirmation ? (
        <input type="hidden" name="from" value={destination} />
      ) : (
        <input type="hidden" name="csrf" value={token} />
      )}
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
      <button type="submit" disabled={disabled || pending} aria-busy={pending}>
        {pending ? 'Queuing…' : `${label}${needsConfirmation ? '…' : ''}`}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
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
