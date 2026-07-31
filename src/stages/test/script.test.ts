import { describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import type Anthropic from '@anthropic-ai/sdk'
import { BudgetExceededError } from '../../jobs/costs.js'
import { createScriptStage, ESTIMATED_SCRIPT_COST_MICROS } from '../script.js'
import type { ScriptOutput } from '../script.js'
import { testChannel, PLATFORM_META } from '../../testing/channel.js'
import { makeCtx } from '../../testing/job.js'

const VALID_SCRIPT = {
  hook: 'The Moon is slowly leaving us',
  segments: [
    {
      text: 'Every year the Moon drifts about 3.8 centimeters farther from Earth.',
      visualDirection: 'moon over dark ocean',
    },
    {
      text: 'Tidal forces steal energy from Earth and hand it to the Moon.',
      visualDirection: 'animated tidal bulge diagram',
    },
    {
      text: 'In the deep future, total solar eclipses will vanish forever.',
      visualDirection: 'solar eclipse timelapse',
    },
    {
      text: 'But do not worry, that is billions of years away.',
      visualDirection: 'calm starfield',
    },
  ],
  platformMeta: {
    youtube: {
      title: 'The Moon Is Drifting Away From Earth',
      description: 'The Moon moves 3.8cm farther each year. Here is why.',
      hashtags: ['#space', '#astronomy', '#moon'],
    },
    tiktok: {
      title: 'The Moon is leaving us',
      description: 'A tiny drift with a huge future consequence.',
      hashtags: ['#space', '#moon'],
    },
    instagram: {
      title: 'Why the Moon drifts away',
      description: 'Tidal forces are slowly pushing the Moon out.',
      hashtags: ['#space', '#astronomy'],
    },
  },
}

function fakeClient(response: unknown): { client: Anthropic; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue(response)
  return { client: { messages: { create } } as unknown as Anthropic, create }
}

describe('scriptStage', () => {
  it('writes script.json, records cost, and forces the emit tool with the script schema', async () => {
    const ctx = makeCtx({ channel: testChannel() })
    const { client, create } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: VALID_SCRIPT }],
      usage: { input_tokens: 500, output_tokens: 800 },
    })
    await createScriptStage(client).run(ctx)

    const written = JSON.parse(await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'))
    expect(written).toEqual(VALID_SCRIPT)

    const rows = ctx.db
      .prepare('SELECT provider, operation, usd_micros FROM costs WHERE job_id = ?')
      .all(ctx.jobId)
    expect(rows).toEqual([
      { provider: 'anthropic', operation: 'script', usd_micros: 500 * 3 + 800 * 15 },
    ])

    // The emit tool's input_schema is the ScriptOutputSchema rendered to JSON Schema
    // by z.toJSONSchema — an object requiring hook, segments, and platformMeta.
    const sentArgs = create.mock.calls[0][0]
    expect(sentArgs.tool_choice).toEqual({ type: 'tool', name: 'emit' })
    // The script stage raises max_tokens above the provider's 2048 default so a full
    // script + three-platform metadata cannot be truncated into a ZodError.
    expect(sentArgs.max_tokens).toBe(4096)
    const sentTool = sentArgs.tools[0]
    expect(sentTool.name).toBe('emit')
    expect(sentTool.input_schema.type).toBe('object')
    expect(sentTool.input_schema.required).toEqual(
      expect.arrayContaining(['hook', 'segments', 'platformMeta']),
    )
  })

  it('throws a zod error when the tool input is malformed', async () => {
    const ctx = makeCtx({ channel: testChannel() })
    const { client } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { hook: 'x' } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    await expect(createScriptStage(client).run(ctx)).rejects.toThrow()
  })

  it('ledgers the paid cost on a schema-invalid response, then rejects', async () => {
    // A billed call whose tool output fails validation must not lose the spend:
    // the stage catches the cost-carrying error and records it before rethrowing.
    const ctx = makeCtx({ channel: testChannel() })
    const { client } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { hook: 'x' } }], // invalid ScriptOutput
      usage: { input_tokens: 100, output_tokens: 200 },
    })
    await expect(createScriptStage(client).run(ctx)).rejects.toThrow()
    const rows = ctx.db
      .prepare('SELECT provider, operation, usd_micros FROM costs WHERE job_id = ?')
      .all(ctx.jobId)
    expect(rows).toEqual([
      { provider: 'anthropic', operation: 'script', usd_micros: 100 * 3 + 200 * 15 },
    ])
  })

  it('throws BudgetExceededError before calling the API when over budget', async () => {
    const ctx = makeCtx({
      channel: testChannel({ budget: { perVideoUsdMicros: 1, perDayUsdMicros: 1 } }),
    })
    const { client, create } = fakeClient({})
    await expect(createScriptStage(client).run(ctx)).rejects.toBeInstanceOf(BudgetExceededError)
    expect(create).not.toHaveBeenCalled()
    expect(ESTIMATED_SCRIPT_COST_MICROS).toBeGreaterThan(1)
  })
})

describe('createScriptStage story mode', () => {
  // storyMetaSchema wraps the three platform entries in a `platformMeta` key —
  // the story call asks ONLY for metadata, so the narration fields of
  // ScriptOutput are absent from what the model returns.
  const META = {
    content: [
      {
        type: 'tool_use',
        id: 't1',
        name: 'emit',
        input: {
          platformMeta: {
            youtube: PLATFORM_META.youtube,
            tiktok: PLATFORM_META.tiktok,
            instagram: PLATFORM_META.instagram,
          },
        },
      },
    ],
    usage: { input_tokens: 100, output_tokens: 100 },
  }

  const story = {
    bodyText: 'One month ago I hosted a movie night. She said she would kill me.\n\nThen she called my mother.',
    partIndex: 1,
    partCount: 3,
    sourceUrl: 'https://reddit.com/r/AmItheAsshole/comments/abc/',
    truncated: false,
  }

  it('narrates the body verbatim, sanitized, without sending it to a model', async () => {
    const { client, create } = fakeClient(META)
    const ctx = makeCtx({ topic: 'AITA for X? (1/3)', story })
    await createScriptStage(client).run(ctx)

    const artifact = JSON.parse(
      await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
    ) as ScriptOutput
    const narration = artifact.segments.map((s) => s.text).join(' ')
    expect(narration).toBe(
      'One month ago I hosted a movie night. She said she would unalive me. Then she called my mother.',
    )
    // The narration must never appear in what was sent to the model.
    const sentArgs = create.mock.calls[0][0]
    const sentPrompt = JSON.stringify(sentArgs)
    expect(sentPrompt).not.toContain('hosted a movie night')
  })

  it('uses the post title as the hook on part 1', async () => {
    const { client } = fakeClient(META)
    const ctx = makeCtx({ topic: 'AITA for X? (1/3)', story })
    await createScriptStage(client).run(ctx)
    const artifact = JSON.parse(
      await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
    ) as ScriptOutput
    expect(artifact.hook).toBe('AITA for X?')
  })

  it('uses a continuation hook on later parts', async () => {
    const { client } = fakeClient(META)
    const ctx = makeCtx({ topic: 'AITA for X? (2/3)', story: { ...story, partIndex: 2 } })
    await createScriptStage(client).run(ctx)
    const artifact = JSON.parse(
      await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
    ) as ScriptOutput
    expect(artifact.hook).toBe('Part two.')
  })

  it('appends the outro only on the final part of a truncated series', async () => {
    const { client } = fakeClient(META)
    const ctx = makeCtx({
      topic: 'AITA for X? (3/3)',
      story: { ...story, partIndex: 3, partCount: 3, truncated: true },
    })
    await createScriptStage(client).run(ctx)
    const artifact = JSON.parse(
      await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
    ) as ScriptOutput
    const last = artifact.segments[artifact.segments.length - 1].text
    expect(last).toBe('The full story is linked in the description.')
  })

  it('omits the outro on a complete series', async () => {
    const { client } = fakeClient(META)
    const ctx = makeCtx({ topic: 'AITA for X? (3/3)', story: { ...story, partIndex: 3, partCount: 3 } })
    await createScriptStage(client).run(ctx)
    const artifact = JSON.parse(
      await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
    ) as ScriptOutput
    const last = artifact.segments[artifact.segments.length - 1].text
    expect(last).not.toContain('linked in the description')
  })

  it('puts the permalink in every platform description on a truncated series', async () => {
    const { client } = fakeClient(META)
    const ctx = makeCtx({
      topic: 'AITA for X? (3/3)',
      story: { ...story, partIndex: 3, partCount: 3, truncated: true },
    })
    await createScriptStage(client).run(ctx)
    const artifact = JSON.parse(
      await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
    ) as ScriptOutput
    for (const platform of ['youtube', 'tiktok', 'instagram'] as const) {
      expect(artifact.platformMeta[platform].description).toContain(story.sourceUrl)
    }
  })
})
