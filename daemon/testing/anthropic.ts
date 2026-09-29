import { vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'

/**
 * Anthropic SDK test doubles.
 *
 * The client-injection seam every paid-call site takes: a plain object with a
 * `vi.fn()` create, never a vitest constructor mock. Five test files carried a
 * byte-identical private copy of `fakeClient` and four of them re-derived the
 * `{ content: [tool_use], usage }` response envelope on top of it; both live
 * here now so an SDK shape change is a one-file edit.
 */

export interface FakeAnthropic {
  client: Anthropic
  create: ReturnType<typeof vi.fn>
}

/** A client whose `messages.create` resolves to `response` on every call. */
export function fakeClient(response: unknown): FakeAnthropic {
  const create = vi.fn().mockResolvedValue(response)
  return { client: { messages: { create } } as unknown as Anthropic, create }
}

export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
}

/**
 * A schema-valid forced-tool response carrying `input` as the emit tool's
 * arguments. Callers that assert on cost pass their own `usage`; the default
 * costs 1000×1 + 500×5 usd-micros at the claude-haiku-4-5 list price.
 */
export function emitToolUse(
  input: unknown,
  usage: AnthropicUsage = { input_tokens: 1000, output_tokens: 500 },
): {
  content: { type: string; name: string; id: string; input: unknown }[]
  usage: AnthropicUsage
} {
  return {
    content: [{ type: 'tool_use', name: 'emit', id: 't1', input }],
    usage,
  }
}
