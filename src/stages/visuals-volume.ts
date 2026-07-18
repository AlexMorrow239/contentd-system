import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cropToVertical, loopToDuration, probe } from '../media/ffmpeg.js'
import type { JobContext, StageDef } from '../jobs/types.js'

const PAD_MS = 500

export const visualsVolumeStage: StageDef = {
  name: 'visuals',
  async run(ctx: JobContext): Promise<void> {
    const voice = JSON.parse(
      readFileSync(ctx.artifactPath('voice', 'voice.json'), 'utf8'),
    ) as { durationMs: number }

    const bgDir = ctx.channel.bgDir
    let all: string[]
    try {
      all = readdirSync(bgDir).filter((f) => f.toLowerCase().endsWith('.mp4'))
    } catch {
      all = []
    }
    if (all.length === 0) {
      throw new Error(`visuals: no .mp4 background clips found in bgDir '${bgDir}'`)
    }

    const recent = (
      ctx.db
        .prepare('SELECT file FROM bg_usage WHERE channel = ? ORDER BY used_at DESC LIMIT 5')
        .all(ctx.channel.name) as { file: string }[]
    ).map((r) => r.file)
    const recentSet = new Set(recent)
    let candidates = all.filter((f) => !recentSet.has(f))
    if (candidates.length === 0) candidates = all // don't empty the pool

    const chosen = candidates[Math.floor(Math.random() * candidates.length)]
    const chosenPath = path.join(bgDir, chosen)

    const p = await probe(chosenPath)
    const tmp = mkdtempSync(path.join(tmpdir(), 'brainrot-visuals-'))
    let source = chosenPath
    if (!(p.width === 1080 && p.height === 1920)) {
      const cropped = path.join(tmp, 'cropped.mp4')
      await cropToVertical(chosenPath, cropped)
      source = cropped
    }

    const targetMs = voice.durationMs + PAD_MS
    const out = ctx.artifactPath('visuals', 'background.mp4')
    await loopToDuration(source, out, targetMs)

    ctx.db
      .prepare('INSERT INTO bg_usage (channel, file, used_at) VALUES (?, ?, ?)')
      .run(ctx.channel.name, chosen, new Date().toISOString())

    ctx.log.info({ chosen, targetMs, out }, 'visuals: background prepared')
  },
}
