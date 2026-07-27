import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BrainrotError } from '../errors.js'
import { cropToVertical, loopToDuration, probe } from '../media/ffmpeg.js'
import type { JobContext, StageDef } from '../jobs/types.js'

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
    const voice = JSON.parse(readFileSync(ctx.artifactPath('voice', 'voice.json'), 'utf8')) as {
      durationMs: number
    }

    const bgDirs = ctx.channel.bgDir
    const all = listMp4sRecursively(bgDirs)
    if (all.length === 0) {
      throw new BrainrotError(
        `visuals: no .mp4 background clips found under bgDir(s): ${bgDirs.join(', ')}`,
        { domain: 'config', kind: 'invalid' },
      )
    }

    const recent = (
      ctx.db
        .prepare('SELECT file FROM bg_usage WHERE channel = ? ORDER BY used_at DESC LIMIT 5')
        .all(ctx.channel.name) as { file: string }[]
    ).map((r) => r.file)
    const recentSet = new Set(recent)
    let candidates = all.filter((f) => !recentSet.has(f))
    if (candidates.length === 0) candidates = all // don't empty the pool

    const chosenPath = candidates[Math.floor(Math.random() * candidates.length)]

    const p = await probe(chosenPath)
    const targetMs = voice.durationMs + PAD_MS
    const out = ctx.artifactPath('visuals', 'background.mp4')
    if (p.width === 1080 && p.height === 1920) {
      await loopToDuration(chosenPath, out, targetMs)
    } else {
      // Temp dir exists only for the cropped intermediate; always removed once
      // loopToDuration has consumed it (or the crop/loop failed).
      const tmp = mkdtempSync(path.join(tmpdir(), 'brainrot-visuals-'))
      try {
        const cropped = path.join(tmp, 'cropped.mp4')
        await cropToVertical(chosenPath, cropped)
        await loopToDuration(cropped, out, targetMs)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    }

    ctx.db
      .prepare('INSERT INTO bg_usage (channel, file, used_at) VALUES (?, ?, ?)')
      .run(ctx.channel.name, chosenPath, new Date().toISOString())

    ctx.log.info({ chosen: chosenPath, targetMs, out }, 'visuals: background prepared')
  },
}
