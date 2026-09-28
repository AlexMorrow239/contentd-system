import { listRecentActions } from '../../../src/actions/queue'
import {
  ACTIONS_PAGE_LIMIT,
  actionsTableExists,
  hasActiveAction,
} from '../../lib/server/queries/actions'
import { DashboardPage, type PageProps } from '../../components/page'
import { ActionDetail } from '../../components/ui'
export default function ActionsPage(props: PageProps) {
  return (
    <DashboardPage
      {...props}
      refreshSeconds={(db) => (actionsTableExists(db) && hasActiveAction(db) ? 3 : undefined)}
    >
      {(db) => {
        if (!actionsTableExists(db))
          return (
            <>
              <h1>Actions</h1>
              <p className="warning">
                This database has no action queue yet — start the daemon once against this root to
                initialize the schema.
              </p>
            </>
          )
        const actions = listRecentActions(db, ACTIONS_PAGE_LIMIT)
        return (
          <>
            <h1>Actions</h1>
            <p className="subtitle">Operator requests, executed by the daemon.</p>
            {actions.length === 0 ? (
              <p className="empty">No operator actions yet.</p>
            ) : (
              actions.map((action) => <ActionDetail key={action.id} action={action} />)
            )}
          </>
        )
      }}
    </DashboardPage>
  )
}
