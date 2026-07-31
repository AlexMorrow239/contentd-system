import { describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import type Anthropic from '@anthropic-ai/sdk'
import { BudgetExceededError } from '../../jobs/costs.js'
import {
  createScriptStage,
  ESTIMATED_SCRIPT_COST_MICROS,
  ESTIMATED_STORY_META_COST_MICROS,
  STORY_META_PREVIEW_WORDS,
} from '../script.js'
import type { ScriptOutput } from '../script.js'
import { testChannel, PLATFORM_META } from '../../testing/channel.js'
import { makeCtx } from '../../testing/job.js'
import { splitStory, STORY_MIN_TAIL_WORDS, STORY_WORDS_PER_PART } from '../../stories/split.js'
import { REALISTIC_STORY_BODY } from '../../stories/_stories.fixtures.js'

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

  it('narrates the body verbatim, sanitized, from local assembly alone', async () => {
    const { client } = fakeClient(META)
    const ctx = makeCtx({ topic: 'AITA for X? (1/3)', story })
    await createScriptStage(client).run(ctx)

    const artifact = JSON.parse(
      await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
    ) as ScriptOutput
    const narration = artifact.segments.map((s) => s.text).join(' ')
    // This is the real verbatim guarantee: META's stub response carries ONLY
    // platformMeta (storyMetaSchema has no narration field), yet segments
    // equal the sanitized body exactly. Narration is assembled locally from
    // ctx.story.bodyText, never from the model's response — so the model
    // structurally cannot alter what is spoken, regardless of what the
    // prompt shows it (see the preview tests below).
    expect(narration).toBe(
      'One month ago I hosted a movie night. She said she would unalive me. Then she called my mother.',
    )
  })

  it('produces one segment per paragraph end to end, through a real splitStory part', async () => {
    // storySegments' `.split(/\n{2,}/)` was dead code before splitStory
    // preserved paragraph breaks (it always joined chunks with a plain
    // space) — this runs the REAL splitStory output through the script
    // stage to prove the two are actually wired together now, not just that
    // storySegments can split a hand-built string.
    const body =
      'Paragraph one has a few sentences here today.\n\n' +
      'Paragraph two continues the story right along.\n\n' +
      'Paragraph three wraps everything up nicely now.'
    const { parts } = splitStory(body, 160, 1)
    expect(parts).toHaveLength(1) // fits one part; the interior breaks must survive the join
    const { client } = fakeClient(META)
    const ctx = makeCtx({
      topic: 'AITA for X? (1/3)',
      story: { ...story, bodyText: parts[0] },
    })
    await createScriptStage(client).run(ctx)
    const artifact = JSON.parse(
      await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
    ) as ScriptOutput
    expect(artifact.segments.map((s) => s.text)).toEqual([
      'Paragraph one has a few sentences here today.',
      'Paragraph two continues the story right along.',
      'Paragraph three wraps everything up nicely now.',
    ])
  })

  it('runs a realistic ~300-word multi-paragraph body through split -> script end to end without a runt part', async () => {
    // The regression test tying the blocker fix and Important 1 together: no
    // checked-in fixture before REALISTIC_STORY_BODY was long enough to
    // exercise splitStory's packing at production scale (every other fixture
    // in this file is well under STORY_WORDS_PER_PART), which is exactly why
    // both survived review. At the real STORY_WORDS_PER_PART budget this body
    // packs into a 128-word part and a 15-word remainder that the tail-merge
    // (split.ts) folds into the second part rather than shipping as its own
    // sub-STORY_MIN_TAIL_WORDS runt.
    const { parts, truncated } = splitStory(REALISTIC_STORY_BODY, STORY_WORDS_PER_PART, 10)
    expect(truncated).toBe(false)
    // This body does not fit in one Short — otherwise the tail-merge path
    // below would never run.
    expect(parts.length).toBeGreaterThan(1)
    // No text dropped by the split or the merge (whitespace-normalized: a
    // paragraph break that fell exactly on a part boundary becomes a single
    // space when parts are rejoined, same as any other sentence boundary).
    expect(parts.join(' ').replace(/\s+/g, ' ').trim()).toBe(
      REALISTIC_STORY_BODY.replace(/\s+/g, ' ').trim(),
    )

    const { client } = fakeClient(META)
    let sawMultiSegmentPart = false
    for (const [i, bodyText] of parts.entries()) {
      // The blocker, directly: every part -- including the last -- clears the
      // floor qc.ts's duration gate needs, not just the non-final ones the
      // paragraph-preference window already guarantees.
      expect(bodyText.trim().split(/\s+/).length).toBeGreaterThanOrEqual(STORY_MIN_TAIL_WORDS)

      const ctx = makeCtx({
        topic: 'AITA for co-signing a lease? (1/1)',
        story: {
          bodyText,
          partIndex: i + 1,
          partCount: parts.length,
          sourceUrl: 'https://reddit.com/r/AmItheAsshole/comments/xyz/',
          truncated,
        },
      })
      await createScriptStage(client).run(ctx)
      const artifact = JSON.parse(
        await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
      ) as ScriptOutput
      if (artifact.segments.length > 1) sawMultiSegmentPart = true
    }
    // Important 1, directly: at least one part's interior paragraph break
    // survived splitStory's join and produced more than one segment —
    // storySegments' paragraph split is live code, not dead code.
    expect(sawMultiSegmentPart).toBe(true)
  })

  it('includes a sanitized, bounded opening preview in the metadata prompt', async () => {
    const prefix = 'He said he would kill me. '
    // Counted, not assumed: the preview is a word count over the WHOLE
    // sanitized body, so the cut point for the `wordN` tail below has to
    // account for the prefix's own word count rather than starting at 0.
    const prefixWordCount = prefix.trim().split(/\s+/).length
    const longBody = Array.from({ length: STORY_META_PREVIEW_WORDS + 20 }, (_, i) => `word${i}`).join(
      ' ',
    )
    const { client, create } = fakeClient(META)
    const ctx = makeCtx({
      topic: 'AITA for X? (1/3)',
      story: { ...story, bodyText: `${prefix}${longBody}` },
    })
    await createScriptStage(client).run(ctx)

    const sentPrompt = JSON.stringify(create.mock.calls[0][0])
    // Sanitized: the raw flagged word is gone, the euphemism is present.
    expect(sentPrompt).not.toContain('kill me')
    expect(sentPrompt).toContain('unalive me')
    // Bounded: only the first STORY_META_PREVIEW_WORDS words of the whole
    // sanitized body are present, truncated with an ellipsis rather than the
    // full body. Pinned at the real cut point (not just "some bound <= 60"):
    // the LAST included word and the FIRST excluded one are both asserted, so
    // an off-by-one slice would fail this even though a "word0 present" check
    // alone would not.
    const lastIncludedIndex = STORY_META_PREVIEW_WORDS - prefixWordCount - 1
    const firstExcludedIndex = STORY_META_PREVIEW_WORDS - prefixWordCount
    expect(sentPrompt).toContain('word0')
    expect(sentPrompt).toContain(`word${lastIncludedIndex}`)
    expect(sentPrompt).not.toContain(`word${firstExcludedIndex}`)
    expect(sentPrompt).toContain('…')
  })

  it('does not ellipsize a preview shorter than the word cap', async () => {
    const { client, create } = fakeClient(META)
    // story.bodyText is well under STORY_META_PREVIEW_WORDS words.
    const ctx = makeCtx({ topic: 'AITA for X? (1/3)', story })
    await createScriptStage(client).run(ctx)
    const sentPrompt = JSON.stringify(create.mock.calls[0][0])
    expect(sentPrompt).not.toContain('…')
  })

  it('sanitizes returned platformMeta title and description, but not hashtags', async () => {
    const flagged = {
      title: 'He said he would kill me',
      description: 'He said he would kill me and I believed it.',
      hashtags: ['#kill', '#drama'],
    }
    const { client } = fakeClient({
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'emit',
          input: {
            platformMeta: { youtube: flagged, tiktok: flagged, instagram: flagged },
          },
        },
      ],
      usage: { input_tokens: 100, output_tokens: 100 },
    })
    const ctx = makeCtx({ topic: 'AITA for X? (1/3)', story })
    await createScriptStage(client).run(ctx)

    const artifact = JSON.parse(
      await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
    ) as ScriptOutput
    for (const platform of ['youtube', 'tiktok', 'instagram'] as const) {
      const entry = artifact.platformMeta[platform]
      expect(entry.title).toBe('He said he would unalive me')
      expect(entry.description).toBe('He said he would unalive me and I believed it.')
      // hashtags are lowercase tokens, not prose — left untouched.
      expect(entry.hashtags).toEqual(['#kill', '#drama'])
    }
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

  it('spells the continuation hook out as a bare number past the spelled-out word list', async () => {
    // PART_WORDS only spells one..eight; max_parts is bounded by
    // videos_per_day x backlog_days, so a channel config can legitimately
    // reach a part index past that list.
    const { client } = fakeClient(META)
    const ctx = makeCtx({
      topic: 'AITA for X? (9/10)',
      story: { ...story, partIndex: 9, partCount: 10 },
    })
    await createScriptStage(client).run(ctx)
    const artifact = JSON.parse(
      await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
    ) as ScriptOutput
    expect(artifact.hook).toBe('Part 9.')
  })

  it('does not strip a trailing ratio that is not this part\'s own suffix', async () => {
    // A title can legitimately end in something that looks like a queue
    // ratio ("My rent split was (1/3)") without it being the scout's own
    // `(partIndex/partCount)` suffix. Here the part is a standalone single
    // part (1/1), so its own suffix would be "(1/1)" -- the "(1/3)" in the
    // topic does not match it and must be left alone rather than stripped.
    const { client } = fakeClient(META)
    const ctx = makeCtx({
      topic: 'My rent split was (1/3)',
      story: { ...story, partIndex: 1, partCount: 1 },
    })
    await createScriptStage(client).run(ctx)
    const artifact = JSON.parse(
      await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
    ) as ScriptOutput
    expect(artifact.hook).toBe('My rent split was (1/3)')
  })

  it('throws BudgetExceededError before calling the API when over budget', async () => {
    const ctx = makeCtx({
      channel: testChannel({ budget: { perVideoUsdMicros: 1, perDayUsdMicros: 1 } }),
      topic: 'AITA for X? (1/3)',
      story,
    })
    const { client, create } = fakeClient({})
    await expect(createScriptStage(client).run(ctx)).rejects.toBeInstanceOf(BudgetExceededError)
    expect(create).not.toHaveBeenCalled()
    expect(ESTIMATED_STORY_META_COST_MICROS).toBeGreaterThan(1)
  })

  it('records one costs row for a successful run, at the haiku rate', async () => {
    // STORY_META_MODEL is claude-haiku-4-5: $1/MTok in, $5/MTok out (see
    // PRICE_TABLE in providers/anthropic.ts) -- distinct from topic mode's
    // sonnet rate, so this pins the story path's own ledger entry rather
    // than reusing the topic-mode pricing by coincidence.
    const ctx = makeCtx({ topic: 'AITA for X? (1/3)', story })
    const { client } = fakeClient({
      content: META.content,
      usage: { input_tokens: 100, output_tokens: 200 },
    })
    await createScriptStage(client).run(ctx)
    const rows = ctx.db
      .prepare('SELECT provider, operation, usd_micros FROM costs WHERE job_id = ?')
      .all(ctx.jobId)
    expect(rows).toEqual([
      { provider: 'anthropic', operation: 'script', usd_micros: 100 * 1 + 200 * 5 },
    ])
  })

  it('ledgers the paid cost on a schema-invalid metadata response, then rejects', async () => {
    const ctx = makeCtx({ topic: 'AITA for X? (1/3)', story })
    const { client } = fakeClient({
      content: [{ type: 'tool_use', id: 't1', name: 'emit', input: { platformMeta: {} } }], // invalid: missing platforms
      usage: { input_tokens: 50, output_tokens: 60 },
    })
    await expect(createScriptStage(client).run(ctx)).rejects.toThrow()
    const rows = ctx.db
      .prepare('SELECT provider, operation, usd_micros FROM costs WHERE job_id = ?')
      .all(ctx.jobId)
    expect(rows).toEqual([
      { provider: 'anthropic', operation: 'script', usd_micros: 50 * 1 + 60 * 5 },
    ])
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

  it('omits the outro on a truncated but non-final part', async () => {
    // Only the LAST part of a series says the story continues elsewhere — an
    // earlier truncated part still has more of the video coming right after it.
    const { client } = fakeClient(META)
    const ctx = makeCtx({
      topic: 'AITA for X? (1/3)',
      story: { ...story, partIndex: 1, partCount: 3, truncated: true },
    })
    await createScriptStage(client).run(ctx)
    const artifact = JSON.parse(
      await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
    ) as ScriptOutput
    const last = artifact.segments[artifact.segments.length - 1].text
    expect(last).not.toContain('linked in the description')
  })

  it('appends the outro on a truncated single-part story', async () => {
    // partCount === 1 is still "the last part of the series" — a whole story
    // cut short in one video needs the outro exactly like a truncated final
    // part of a multi-part series does.
    const { client } = fakeClient(META)
    const ctx = makeCtx({
      topic: 'AITA for X?',
      story: { ...story, partIndex: 1, partCount: 1, truncated: true },
    })
    await createScriptStage(client).run(ctx)
    const artifact = JSON.parse(
      await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
    ) as ScriptOutput
    const last = artifact.segments[artifact.segments.length - 1].text
    expect(last).toBe('The full story is linked in the description.')
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

  it('sanitizes before appending the permalink, so the URL itself is never rewritten', async () => {
    const flagged = {
      title: 'She said she would kill me',
      description: 'She said she would kill me before it ended.',
      hashtags: ['#drama'],
    }
    // The slug itself must contain a flagged token in a form the \b-anchored
    // PATTERN actually matches (a hyphenated word boundary), so this test can
    // discriminate ordering. Real reddit slugs use underscores between words,
    // and \b does not fire between word characters (underscore counts as one)
    // — so in practice this ordering is belt-and-braces rather than a live
    // hazard against real permalinks. The hyphenated form here is a
    // deliberate stand-in that pins the ordering anyway.
    const sourceUrl =
      'https://reddit.com/r/AmItheAsshole/comments/abc/aita-for-saying-i-would-kill-her-cat/'
    const { client } = fakeClient({
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'emit',
          input: {
            platformMeta: { youtube: flagged, tiktok: flagged, instagram: flagged },
          },
        },
      ],
      usage: { input_tokens: 100, output_tokens: 100 },
    })
    const ctx = makeCtx({
      topic: 'AITA for X? (3/3)',
      story: { ...story, partIndex: 3, partCount: 3, truncated: true, sourceUrl },
    })
    await createScriptStage(client).run(ctx)
    const artifact = JSON.parse(
      await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
    ) as ScriptOutput
    for (const platform of ['youtube', 'tiktok', 'instagram'] as const) {
      const description = artifact.platformMeta[platform].description
      // The URL must be appended intact and unsanitized: if the sanitize loop
      // ran AFTER the append instead of before, this exact trailing substring
      // would instead end "...i-would-unalive-her-cat/", failing this
      // character-for-character check.
      expect(description.endsWith(`Full story: ${sourceUrl}`)).toBe(true)
      expect(description).toContain('unalive me')
      expect(description).not.toContain('kill me')
    }
  })
})
