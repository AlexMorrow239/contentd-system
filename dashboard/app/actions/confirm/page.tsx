import {
  ACTIONS,
  actionArgFieldKind,
  actionArgNames,
  isActionKind,
} from '../../../../daemon/src/features/actions/catalog'
import { ActionForm } from '../../../components/action-form'
import { DashboardPage, value, type PageProps } from '../../../components/page'
import { sameSitePath } from '../../../lib/shared/navigation'
export default function ConfirmPage(props: PageProps) {
  return (
    <DashboardPage {...props}>
      {(_db, ctx) => {
        const kind = value(ctx.search, 'kind') ?? ''
        if (!isActionKind(kind) || !ACTIONS[kind].confirm)
          return (
            <>
              <h1>Invalid action</h1>
              <p className="error">No confirmation step for {kind}.</p>
            </>
          )
        const fields: Record<string, string> = {}
        const missing = actionArgNames(kind).filter((name) => {
          const raw = value(ctx.search, name)
          if (raw === undefined) return true
          fields[name] = raw
          return false
        })
        const from = sameSitePath(value(ctx.search, 'from') ?? '') ?? '/actions'
        return (
          <>
            <h1>Confirm: {ACTIONS[kind].label}</h1>
            <section className="panel">
              <p className="warning">{ACTIONS[kind].danger ?? 'This action cannot be undone.'}</p>
              <dl className="facts">
                {Object.entries(fields).map(([name, val]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>
                      <code>{val}</code>
                    </dd>
                  </div>
                ))}
              </dl>
              <ActionForm
                kind={kind}
                token={ctx.token}
                fields={fields}
                disabled={ctx.stale}
                confirmed
                from={from}
              >
                {missing.map((name) => {
                  const type = actionArgFieldKind(kind, name)
                  return (
                    <label key={name} className="field">
                      {name}
                      <input
                        name={name}
                        type="text"
                        required={type === 'text'}
                        autoComplete="off"
                      />
                    </label>
                  )
                })}
              </ActionForm>
              <a href={from}>Cancel</a>
            </section>
          </>
        )
      }}
    </DashboardPage>
  )
}
