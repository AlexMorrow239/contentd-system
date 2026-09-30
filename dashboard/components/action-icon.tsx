import type { ActionKind } from '../../daemon/src/actions/catalog'

export function ActionIcon({ kind }: { kind: ActionKind }) {
  const paths: Partial<Record<ActionKind, string>> = {
    'jobs.resume': 'M8 5v14l11-7Z',
    'library.approve': 'm5 12 4 4L19 6',
    'jobs.delete': 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  }
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[kind]} />
    </svg>
  )
}
