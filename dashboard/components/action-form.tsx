import 'server-only'
import { ACTIONS } from '../../daemon/src/actions/catalog'
import { ActionFormControl, type ActionFormControlProps } from './action-control'

export function ActionForm({
  confirmed = false,
  ...props
}: ActionFormControlProps & { confirmed?: boolean }) {
  const descriptor = ACTIONS[props.kind]
  const needsConfirmation = descriptor.confirm && !confirmed
  return (
    <ActionFormControl
      {...props}
      label={descriptor.label}
      // Only the modal reads it; the confirmation page loads it from the catalog.
      danger={needsConfirmation && props.confirmation === 'modal' ? descriptor.danger : undefined}
      needsConfirmation={needsConfirmation}
    />
  )
}
