import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { structuredCompletion, visionJudgment } from '../anthropic.js'
import { emitToolUse, fakeClient } from '../../../testing/anthropic.js'
import { tmpDir } from '../../../testing/tmp.js'
import { errorCostUsdMicros } from '../errors.js'
import { classify, errorMessage } from '../../errors.js'

const schema = z.object({ answer: z.string(), n: z.number() })

describe('structuredCompletion', () => {
  it('parses the emit tool input, computes cost, and passes a native JSON schema', async () => {
    const { client, create } = fakeClient(
      emitToolUse({ answer: 'hi', n: 3 }, { input_tokens: 100, output_tokens: 200 }),
    )
    const { data, cost } = await structuredCompletion({
      model: 'claude-sonnet-5',
      system: 's',
      prompt: 'p',
      schema,
      client,
    })
    expect(data).toEqual({ answer: 'hi', n: 3 })
    expect(cost.usdMicros).toBe(100 * 3 + 200 * 15) // 3300

    // The forced emit tool must carry the zod schema rendered to JSON Schema.
    const sentTool = create.mock.calls[0][0].tools[0]
    expect(sentTool.name).toBe('emit')
    expect(sentTool.input_schema.type).toBe('object')
    expect(sentTool.input_schema.required).toEqual(expect.arrayContaining(['answer', 'n']))
  })

  it('throws a zod error on malformed tool input', async () => {
    const { client } = fakeClient(
      emitToolUse({ answer: 'hi' }, { input_tokens: 10, output_tokens: 10 }),
    )
    await expect(
      structuredCompletion({ model: 'claude-sonnet-5', system: 's', prompt: 'p', schema, client }),
    ).rejects.toThrow(z.ZodError)
  })

  it('attaches the already-billed cost to a schema-validation failure so callers can ledger it', async () => {
    // The messages.create call is billed whether or not the tool output validates;
    // a schema failure must still carry the spend. `n` is missing -> invalid.
    const { client } = fakeClient(
      emitToolUse({ answer: 'hi' }, { input_tokens: 100, output_tokens: 200 }),
    )
    const err = await structuredCompletion({
      model: 'claude-sonnet-5',
      system: 's',
      prompt: 'p',
      schema,
      client,
    }).catch((e) => e)
    // Identity is preserved (still a ZodError), and the cost rides along on it.
    expect(err).toBeInstanceOf(z.ZodError)
    expect(errorCostUsdMicros(err)).toBe(100 * 3 + 200 * 15) // 3300
  })

  it('coerces a JSON-stringified nested value before validating (observed real-model behavior)', async () => {
    const arraySchema = z.object({ segments: z.array(z.object({ text: z.string() })) })
    // Anthropic tool_choice does not guarantee schema-conformant output;
    // models occasionally stringify a nested array/object instead of emitting
    // it structurally. Reproduces a failure seen against the real API where
    // `segments` came back as a JSON string.
    const { client } = fakeClient(
      emitToolUse(
        { segments: JSON.stringify([{ text: 'a' }, { text: 'b' }]) },
        { input_tokens: 10, output_tokens: 10 },
      ),
    )
    const { data } = await structuredCompletion({
      model: 'claude-sonnet-5',
      system: 's',
      prompt: 'p',
      schema: arraySchema,
      client,
    })
    expect(data).toEqual({ segments: [{ text: 'a' }, { text: 'b' }] })
  })

  it('still throws on genuinely malformed input (not a JSON string, just wrong)', async () => {
    const arraySchema = z.object({ segments: z.array(z.object({ text: z.string() })) })
    const { client } = fakeClient(
      emitToolUse({ segments: 'not json at all' }, { input_tokens: 10, output_tokens: 10 }),
    )
    await expect(
      structuredCompletion({
        model: 'claude-sonnet-5',
        system: 's',
        prompt: 'p',
        schema: arraySchema,
        client,
      }),
    ).rejects.toThrow(z.ZodError)
  })

  it('throws when there is no emit tool_use block', async () => {
    const { client } = fakeClient({
      content: [{ type: 'text', text: 'nope' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    await expect(
      structuredCompletion({ model: 'claude-sonnet-5', system: 's', prompt: 'p', schema, client }),
    ).rejects.toThrow(/no emit tool_use/)
  })

  it('attaches the already-billed cost to a missing-tool_use failure so callers can ledger it', async () => {
    // A billed response that came back without the forced tool block is still
    // billed: the spend must ride on the error like a schema failure's does.
    const { client } = fakeClient({
      content: [{ type: 'text', text: 'nope' }],
      usage: { input_tokens: 100, output_tokens: 200 },
    })
    const err = await structuredCompletion({
      model: 'claude-sonnet-5',
      system: 's',
      prompt: 'p',
      schema,
      client,
    }).catch((e) => e)
    expect(errorCostUsdMicros(err)).toBe(100 * 3 + 200 * 15) // 3300
  })

  it('rejects an unpriced model at zero spend, before the API is called', async () => {
    const { client, create } = fakeClient(
      emitToolUse({ answer: 'hi', n: 3 }, { input_tokens: 100, output_tokens: 200 }),
    )
    await expect(
      structuredCompletion({
        model: 'claude-nonexistent-9',
        system: 's',
        prompt: 'p',
        schema,
        client,
      }),
    ).rejects.toThrow(/no price table entry for model/)
    // The paid call must never fire for a model we cannot price.
    expect(create).not.toHaveBeenCalled()
  })
})

describe('visionJudgment', () => {
  const judgmentSchema = z.object({ pass: z.boolean(), critique: z.string() })

  // Tiny fake image bytes: visionJudgment reads and base64-encodes files, it
  // never decodes them, so magic-number-only "images" are enough for unit tests.
  function writeImages(): {
    dir: string
    pngPath: string
    jpgPath: string
    pngB64: string
    jpgB64: string
  } {
    const dir = tmpDir('brainrot-vision-')
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03])
    const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0x04, 0x05, 0x06])
    const pngPath = path.join(dir, 'scene-01.png')
    const jpgPath = path.join(dir, 'frame-2.JPG') // uppercase on purpose: extension mapping is case-insensitive
    writeFileSync(pngPath, pngBytes)
    writeFileSync(jpgPath, jpgBytes)
    return {
      dir,
      pngPath,
      jpgPath,
      pngB64: pngBytes.toString('base64'),
      jpgB64: jpgBytes.toString('base64'),
    }
  }

  it('sends base64 image blocks (media_type by extension) before the text prompt and parses the emit output', async () => {
    const { pngPath, jpgPath, pngB64, jpgB64 } = writeImages()
    const { client, create } = fakeClient(
      emitToolUse(
        { pass: true, critique: 'matches the scene' },
        { input_tokens: 1000, output_tokens: 100 },
      ),
    )
    const { data, cost } = await visionJudgment({
      model: 'claude-sonnet-5',
      system: 's',
      prompt: 'Does this keyframe match the scene intent?',
      imagePaths: [pngPath, jpgPath],
      schema: judgmentSchema,
      client,
    })
    expect(data).toEqual({ pass: true, critique: 'matches the scene' })
    expect(cost.usdMicros).toBe(1000 * 3 + 100 * 15) // 4500 — same PRICE_TABLE math as structuredCompletion

    const request = create.mock.calls[0][0]
    // Shared forced-tool core: emit tool, forced tool_choice.
    expect(request.tools[0].name).toBe('emit')
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'emit' })
    // Content layout: every image block precedes the single trailing text block.
    expect(request.messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngB64 } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpgB64 } },
      { type: 'text', text: 'Does this keyframe match the scene intent?' },
    ])
  })

  it('rejects an unpriced model at zero spend, before the API is called', async () => {
    const { pngPath } = writeImages()
    const { client, create } = fakeClient({
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    await expect(
      visionJudgment({
        model: 'claude-nonexistent-9',
        system: 's',
        prompt: 'p',
        imagePaths: [pngPath],
        schema: judgmentSchema,
        client,
      }),
    ).rejects.toThrow(/visionJudgment: no price table entry for model/)
    expect(create).not.toHaveBeenCalled()
  })

  it('throws on an unsupported image extension without calling the API, classified as provider/invalid', async () => {
    const { dir } = writeImages()
    const gifPath = path.join(dir, 'frame.gif')
    writeFileSync(gifPath, Buffer.from([0x47, 0x49, 0x46]))
    const { client, create } = fakeClient({
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const err = await visionJudgment({
      model: 'claude-sonnet-5',
      system: 's',
      prompt: 'p',
      imagePaths: [gifPath],
      schema: judgmentSchema,
      client,
    }).catch((e: unknown) => e)
    expect(errorMessage(err)).toMatch(/visionJudgment: unsupported image extension/)
    expect(classify(err)).toMatchObject({ domain: 'provider', kind: 'invalid' })
    expect(create).not.toHaveBeenCalled()
  })

  it('coerces a JSON-stringified nested value via the shared retry path', async () => {
    const { pngPath } = writeImages()
    const listSchema = z.object({ issues: z.array(z.string()) })
    const { client } = fakeClient(
      emitToolUse(
        { issues: JSON.stringify(['caption obscures subject']) },
        { input_tokens: 10, output_tokens: 10 },
      ),
    )
    const { data } = await visionJudgment({
      model: 'claude-sonnet-5',
      system: 's',
      prompt: 'p',
      imagePaths: [pngPath],
      schema: listSchema,
      client,
    })
    expect(data).toEqual({ issues: ['caption obscures subject'] })
  })
})

describe('strict tool schema enforcement', () => {
  it('sends the emit tool with strict: true so the API constrains input to the schema', async () => {
    // Observed live 2026-07-20: without strict mode, Sonnet stringifies large
    // nested arrays (the scenes format) in ~half of forced tool calls, and the
    // hand-written stringified JSON can carry typos the coercion cannot repair.
    // strict: true makes non-conformant tool input structurally impossible.
    const { client, create } = fakeClient(
      emitToolUse({ answer: 'hi', n: 3 }, { input_tokens: 100, output_tokens: 200 }),
    )
    await structuredCompletion({
      model: 'claude-sonnet-5',
      system: 's',
      prompt: 'p',
      schema,
      client,
    })
    expect(create.mock.calls[0][0].tools[0].strict).toBe(true)
  })

  it('strips integer minimum/maximum from the wire schema (strict mode rejects them)', async () => {
    // Observed live 2026-07-21: 400 invalid_request_error "tools.0.custom: For
    // 'integer' type, properties maximum, minimum are not supported". zod v4's
    // .int() alone emits safe-integer minimum/maximum, so any integer field
    // trips it — explicit .min/.max or not. Response validation keeps the full
    // zod bounds; only the wire schema is stripped.
    const intSchema = z.object({
      n: z.number().int().min(0).max(10),
      nested: z.array(z.object({ idx: z.number().int() })),
      ratio: z.number().min(0), // non-integer bounds must survive the strip
    })
    const { client, create } = fakeClient(
      emitToolUse(
        { n: 3, nested: [{ idx: 1 }], ratio: 0.5 },
        { input_tokens: 100, output_tokens: 200 },
      ),
    )
    await structuredCompletion({
      model: 'claude-sonnet-5',
      system: 's',
      prompt: 'p',
      schema: intSchema,
      client,
    })
    const sent = JSON.stringify(create.mock.calls[0][0].tools[0].input_schema)
    expect(sent).not.toContain('"maximum"')
    // the number-typed ratio keeps its minimum; no integer node carries one
    const wire = create.mock.calls[0][0].tools[0].input_schema as {
      properties: { n: Record<string, unknown>; ratio: Record<string, unknown> }
    }
    expect(wire.properties.n.minimum).toBeUndefined()
    expect(wire.properties.ratio.minimum).toBe(0)
  })
})
