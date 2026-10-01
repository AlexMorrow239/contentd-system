'use client'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { ActionKind } from '../../daemon/src/features/actions/catalog'
import { sameSitePath } from '../lib/shared/navigation'
import { ActionIcon } from './action-icon'
import { useJobActionState } from './job-action-state'

export interface ActionFormControlProps {
  kind: ActionKind
  token: string
  fields?: Record<string, string>
  disabled?: boolean
  from?: string
  children?: ReactNode
  confirmation?: 'page' | 'modal'
  icon?: boolean
  inPlace?: boolean
  subject?: string
}

/** The server wrapper supplies catalog metadata, keeping its validators off the client. */
export function ActionFormControl({
  kind,
  token,
  fields = {},
  disabled = false,
  from,
  children,
  label,
  needsConfirmation,
  danger,
  confirmation = 'page',
  icon = false,
  inPlace = false,
  subject,
}: ActionFormControlProps & { label: string; needsConfirmation: boolean; danger?: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()
  const { group, notify } = useJobActionState()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const submitting = useRef(false)
  const form = useRef<HTMLFormElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const pageConfirmation = needsConfirmation && confirmation === 'page'
  const modalConfirmation = needsConfirmation && confirmation === 'modal'
  const current = `${pathname}${search.size ? `?${search.toString()}` : ''}`
  const destination = sameSitePath(from ?? current) ?? '/actions'
  const unavailable = disabled || pending || (group?.busy ?? false)

  useEffect(() => {
    if (modalOpen && !dialog.current?.open) dialog.current?.showModal()
  }, [modalOpen])

  async function submit() {
    if (submitting.current || unavailable || !form.current) return
    if (group && !group.begin()) return
    submitting.current = true
    setPending(true)
    setError('')
    let actionId: number | undefined
    try {
      const response = await fetch('/api/actions', {
        method: 'POST',
        body: new FormData(form.current),
      })
      const data: unknown = await response.json()
      if (!response.ok) {
        setError(
          typeof data === 'object' &&
            data !== null &&
            'error' in data &&
            typeof data.error === 'string'
            ? data.error
            : 'Could not queue action.',
        )
        return
      }
      if (
        typeof data !== 'object' ||
        data === null ||
        !('actionId' in data) ||
        typeof data.actionId !== 'number'
      )
        throw new Error('Invalid response')
      actionId = data.actionId
      dialog.current?.close()
      if (inPlace) {
        notify(actionId, `Queued ${label} for ${fields.jobId ?? fields.jobIds ?? 'job'}`)
        router.refresh()
      } else {
        const target = new URL(destination, window.location.origin)
        target.searchParams.set('action', String(actionId))
        router.replace(`${target.pathname}${target.search}`, { scroll: false })
      }
    } catch {
      setError(
        'Could not confirm submission. Check Actions before trying again; it may already be queued.',
      )
    } finally {
      group?.finish(actionId)
      submitting.current = false
      setPending(false)
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (unavailable) return
    if (modalConfirmation) {
      setError('')
      setModalOpen(true)
    } else void submit()
  }

  return (
    <>
      <form
        ref={form}
        className={`action${icon ? ' icon-action' : ''}`}
        action={pageConfirmation ? '/actions/confirm' : '/api/actions'}
        method={pageConfirmation ? 'get' : 'post'}
        onSubmit={pageConfirmation ? undefined : handleSubmit}
      >
        <input type="hidden" name="kind" value={kind} />
        {pageConfirmation ? (
          <input type="hidden" name="from" value={destination} />
        ) : (
          <input type="hidden" name="csrf" value={token} />
        )}
        {Object.entries(fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        {children}
        <button
          ref={trigger}
          type="submit"
          disabled={unavailable}
          aria-busy={pending}
          aria-label={icon ? label : undefined}
          aria-haspopup={modalConfirmation ? 'dialog' : undefined}
          className={icon ? `icon-button action-${kind.replace('.', '-')}` : undefined}
        >
          {icon ? (
            <>
              <ActionIcon kind={kind} />
              <span className="action-tooltip" role="tooltip">
                {pending ? 'Queuing…' : label}
              </span>
            </>
          ) : pending ? (
            'Queuing…'
          ) : (
            `${label}${pageConfirmation ? '…' : ''}`
          )}
        </button>
        {error && !modalOpen && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
      {modalConfirmation && modalOpen && (
        <dialog
          ref={dialog}
          className="confirmation-modal"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onKeyDown={(event) => {
            if (event.key !== 'Tab') return
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
            )
            const first = buttons[0]
            const last = buttons[buttons.length - 1]
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last?.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first?.focus()
            }
          }}
          onClose={() => {
            setModalOpen(false)
            if (!trigger.current?.disabled) trigger.current?.focus()
          }}
        >
          <h2 id={titleId}>Confirm {label}</h2>
          {subject && <p className="modal-subject">{subject}</p>}
          <p className="muted">
            Job <code>{fields.jobId ?? fields.jobIds}</code>
          </p>
          <p id={descriptionId}>{danger}</p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" autoFocus onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={unavailable}
              aria-busy={pending}
              onClick={() => {
                void submit()
              }}
            >
              {pending ? 'Queuing…' : label}
            </button>
          </div>
        </dialog>
      )}
    </>
  )
}
