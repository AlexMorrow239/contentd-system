import { type SpendAgainstCap, type StatusCount } from '../lib/server/queries/overview'
import { formatUsdMicros } from '../../daemon/src/money'
import { Status } from './ui'
export function Counts({ counts }: { counts: StatusCount[] }) {
  return counts.length === 0 ? (
    <p className="empty">None</p>
  ) : (
    <dl className="counts">
      {counts.map((item) => (
        <div key={item.status}>
          <dt>
            <Status value={item.status} />
          </dt>
          <dd>{item.count}</dd>
        </div>
      ))}
    </dl>
  )
}
export function Spend({ label, spend }: { label: string; spend: SpendAgainstCap }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>
        {formatUsdMicros(spend.spentUsdMicros)} /{' '}
        {spend.capUsdMicros === null ? 'Global limit only' : formatUsdMicros(spend.capUsdMicros)}
        {spend.capUsdMicros !== null && spend.spentUsdMicros > spend.capUsdMicros && (
          <span className="error"> Over cap</span>
        )}
      </td>
    </tr>
  )
}
