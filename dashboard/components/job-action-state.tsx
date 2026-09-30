'use client'
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import Link from 'next/link'
import type { JobAction } from '../lib/server/queries/job-content'

const FeedbackContext = createContext<(id: number, message: string) => void>(() => {})
const ActionGroupContext = createContext<{
  busy: boolean
  begin: () => boolean
  finish: (id?: number) => void
} | null>(null)

export function useJobActionState() {
  return { group: useContext(ActionGroupContext), notify: useContext(FeedbackContext) }
}

export function JobWorkspace({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<{ id: number; message: string }[]>([])
  const notify = useCallback((id: number, message: string) => {
    setMessages((previous) =>
      [...previous.filter((item) => item.id !== id), { id, message }].slice(-3),
    )
  }, [])
  return (
    <FeedbackContext.Provider value={notify}>
      {children}
      <div className="job-feedback" aria-live="polite">
        {messages.map(({ id, message }) => (
          <div key={id} className="job-notice" role="status">
            <span>
              {message} · <Link href={`/actions?action=${id}`}>View action</Link>
            </span>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => setMessages((previous) => previous.filter((item) => item.id !== id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </FeedbackContext.Provider>
  )
}

/** A row shares one synchronous submission lock across all its action buttons. */
export function JobActionGroup({
  action,
  children,
}: {
  action: JobAction | null
  children: ReactNode
}) {
  const lock = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const [accepted, setAccepted] = useState<number | null>(null)
  const waitingForRefresh = accepted !== null && (action === null || action.id < accepted)
  const busy =
    submitting || waitingForRefresh || action?.status === 'pending' || action?.status === 'running'
  const group = useMemo(
    () => ({
      busy,
      begin() {
        if (lock.current || busy) return false
        lock.current = true
        setSubmitting(true)
        return true
      },
      finish(id?: number) {
        if (id !== undefined) setAccepted(id)
        lock.current = false
        setSubmitting(false)
      },
    }),
    [busy],
  )
  return (
    <ActionGroupContext.Provider value={group}>
      <div className="job-action-group">
        <div className="job-action-buttons">{children}</div>
        {busy && (
          <span className="muted" role="status">
            {submitting ? 'Queuing…' : 'Action queued / running'}
          </span>
        )}
        {!busy && action?.status === 'failed' && (
          <p className="error" role="alert">
            {action.error ?? 'Action failed.'}{' '}
            <Link href={`/actions?action=${action.id}`}>Details</Link>
          </p>
        )}
        {action?.notice && <p className="muted">{action.notice}</p>}
      </div>
    </ActionGroupContext.Provider>
  )
}
