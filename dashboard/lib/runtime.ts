import 'server-only'
import { mintCsrfToken } from '../../src/dashboard/csrf'
// The launcher provides one token to every Next bundle/worker. The fallback
// supports direct Next CLI use and survives development module reloads.
const state = globalThis as typeof globalThis & { brainrotCsrf?: string }
export function csrfToken(): string {
  return process.env.BRAINROT_DASHBOARD_CSRF || (state.brainrotCsrf ??= mintCsrfToken())
}
