import 'server-only'
import { ACTIONS } from '../../src/actions/catalog'
import { ActionFormControl, type ActionFormControlProps } from './controls'

export function ActionForm({
  confirmed = false,
  ...props
}: ActionFormControlProps & { confirmed?: boolean }) {
  const descriptor = ACTIONS[props.kind]
  return (
    <ActionFormControl
      {...props}
      label={descriptor.label}
      needsConfirmation={descriptor.confirm && !confirmed}
    />
  )
}
