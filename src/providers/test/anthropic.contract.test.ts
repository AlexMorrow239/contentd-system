import 'dotenv/config'
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { structuredCompletion } from '../anthropic.js'

// Runs only via `pnpm test:contract` (excluded from default `pnpm test`).
// Makes ONE real, cheap Anthropic call; needs ANTHROPIC_API_KEY (shell env
// or .env — loaded here because vitest does not read .env on its own).
describe.skipIf(!process.env.ANTHROPIC_API_KEY)('structuredCompletion (contract)', () => {
  it('extracts structured data from a real haiku-class call', async () => {
    const schema = z.object({ capital: z.string() })
    const { data, cost } = await structuredCompletion({
      model: 'claude-haiku-4-5',
      system: 'You extract facts. Always return the answer by calling the emit tool.',
      prompt: 'What is the capital of France?',
      schema,
      maxTokens: 256,
    })
    expect(data.capital.toLowerCase()).toContain('paris')
    expect(cost.usdMicros).toBeGreaterThan(0)
  }, 30_000)
})
