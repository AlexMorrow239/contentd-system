import 'server-only'
import { mintCsrfToken } from './csrf'
// The launcher provides one token to every Next bundle/worker. The fallback
// supports direct Next CLI use and survives development module reloads.
const state = globalThis as typeof globalThis & { contentdCsrf?: string }
export function csrfToken(): string {
  return process.env.CONTENTD_DASHBOARD_CSRF || (state.contentdCsrf ??= mintCsrfToken())
}
