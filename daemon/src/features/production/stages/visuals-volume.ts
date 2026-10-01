import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { cropAndLoopToDuration, loopToDuration, probe } from '../../../infra/media/ffmpeg.js'
import { VIDEO_HEIGHT, VIDEO_WIDTH } from '../../../shared/contracts/video.js'
import { BrainrotError } from '../../../shared/errors.js'
import type { VoiceMeta } from '../artifacts/voice.js'
import type { JobContext, StageDef } from '../contracts.js'
import { checkpoint } from '../ownership.js'
import { recentBackgrounds, recordBackgroundUse } from './bg-usage.js'

const PAD_MS = 500

// Recursively collects .mp4 files under each root (case-insensitive
// extension match), deduping overlapping/nested roots by resolved path. A
// root that doesn't exist or isn't readable is skipped rather than failing
// the whole scan, matching the tolerance the old single-dir code had.
function listMp4sRecursively(dirs: string[]): string[] {
  const found = new Set<string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.resolve(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp4')) {
        found.add(full)
      }
    }
  }
  for (const dir of dirs) {
    try {
      walk(path.resolve(dir))
    } catch {
      // missing/unreadable root: skip it, same as the old flat scan
    }
  }
  return [...found]
}

export const visualsVolumeStage: StageDef = {
  name: 'visuals',
  async run(ctx: JobContext): Promise<void> {
    checkpoint(ctx)
    const voice = JSON.parse(
      readFileSync(ctx.artifactPath('voice', 'voice.json'), 'utf8'),
    ) as VoiceMeta

    const bgDirs = ctx.channel.bgDir
    const all = listMp4sRecursively(bgDirs)
    if (all.length === 0) {
      throw new BrainrotError(
        `visuals: no .mp4 background clips found under bgDir(s): ${bgDirs.join(', ')}`,
        { domain: 'config', kind: 'invalid' },
      )
    }

    const recentSet = new Set(recentBackgrounds(ctx.db, ctx.channel.name))
    let candidates = all.filter((f) => !recentSet.has(f))
    if (candidates.length === 0) candidates = all // don't empty the pool

    const chosenPath = candidates[Math.floor(Math.random() * candidates.length)]

    checkpoint(ctx)
    const p = await probe(chosenPath, ctx.signal)
    checkpoint(ctx)
    const targetMs = voice.durationMs + PAD_MS
    const out = ctx.artifactPath('visuals', 'background.mp4')
    if (p.width === VIDEO_WIDTH && p.height === VIDEO_HEIGHT) {
      await loopToDuration(chosenPath, out, targetMs, ctx.signal)
    } else {
      await cropAndLoopToDuration(chosenPath, out, targetMs, ctx.signal)
    }

    ctx.db
      .transaction(() => {
        checkpoint(ctx)
        recordBackgroundUse(ctx.db, ctx.channel.name, chosenPath, ctx.time)
      })
      .immediate()

    ctx.log.info({ chosen: chosenPath, targetMs, out }, 'visuals: background prepared')
  },
}
