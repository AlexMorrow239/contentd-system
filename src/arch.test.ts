import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DASHBOARD_STAGE_ORDER } from './dashboard/queries/jobs.js'
import { classify } from './errors.js'
import { BudgetExceededError } from './jobs/costs.js'
import { pipelineStages } from './jobs/pipeline.js'
import { ResumeError } from './jobs/resume.js'
import { PublishError, PublishOutcomeUnknownError, PUBLISH_PLATFORMS } from './publish/types.js'
import {
  AllChannelsScoringFailedError,
  AllSourcesFailedError,
  ScoutRunFailedError,
} from './scout/scout.js'
import { StorageError } from './storage/types.js'

// Every .ts file under src/, as paths relative to src/. Used by the error
// convention lints below, which are source-text greps rather than import
// checks — the thing being guarded is "nobody writes this expression", which
// no amount of importing can observe.
const SRC_ROOT = fileURLToPath(new URL('.', import.meta.url))

async function srcFiles(dir: string = SRC_ROOT): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (e) => {
      const full = join(dir, e.name)
      if (e.isDirectory()) return srcFiles(full)
      return e.name.endsWith('.ts') ? [full] : []
    }),
  )
  return nested.flat()
}

/**
 * Repo-wide architecture lints: assertions about how modules may depend on
 * each other, rather than about any module's behavior.
 *
 * They live in their own file because they are import-heavy by nature — the
 * thing being guarded is usually "module A must not reach for module B at
 * runtime", which the guard itself can only check by importing B. Kept inside
 * a behavior test file, that cost lands on every run of a file that has no
 * other reason to pay it.
 */
describe('dashboard stage order', () => {
  it('matches the real pipeline order', () => {
    // The dashboard hardcodes the order rather than importing pipelineStages()
    // at runtime — that module pulls in remotion, kokoro and the ffmpeg
    // wrappers, which a read-only viewer has no business loading. This is the
    // anti-drift guard, and it pays the heavy import once, in test only.
    //
    // It was previously inside dashboard/queries/test/jobs.test.ts, which is
    // otherwise a set of instant in-memory SQL assertions.
    expect([...DASHBOARD_STAGE_ORDER]).toEqual(pipelineStages().map((s) => s.name))
  })
})

describe('publish-next platform agnosticism', () => {
  it('publish-next.ts contains no youtube/instagram string literal in its own source', async () => {
    // The tick drives platforms generically through the adapter registry
    // (src/publish/platforms/index.ts); a platform name appearing in its source
    // means a special case has crept back in.
    //
    // Previously lived inside loop/test/publish-next.test.ts, which is a
    // behavior file.
    const { readFile } = await import('node:fs/promises')
    const src = await readFile(new URL('./loop/publish-next.ts', import.meta.url), 'utf8')
    for (const platform of PUBLISH_PLATFORMS) {
      expect(src).not.toContain(`'${platform}'`)
      expect(src).not.toContain(`"${platform}"`)
    }
  })
})

describe('error handling conventions', () => {
  it('no module re-rolls the message-extraction ternary', async () => {
    // This exact expression had been copied into 13 files. `errorMessage()`
    // in src/errors.ts is the one implementation, and src/errors.ts is the
    // one place it legitimately appears — so it is the only exemption.
    //
    // The needle is built from two pieces rather than written as one literal
    // so that this file's own source doesn't contain the contiguous banned
    // substring — otherwise this test would always list itself as an
    // offender, since the text it searches for necessarily appears inside it.
    const BANNED_IDIOM = 'instanceof' + ' Error ?'
    const offenders: string[] = []
    for (const file of await srcFiles()) {
      const rel = relative(SRC_ROOT, file)
      if (rel === 'errors.ts') continue
      const src = await readFile(file, 'utf8')
      if (src.includes(BANNED_IDIOM)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it('declares no Error subclass outside the errors module', async () => {
    // Every classifiable error extends BrainrotError, which is the only thing
    // in the repo permitted to extend Error directly. This is the guard that
    // stops a new module from re-rolling its own hierarchy — which is how ten
    // classes in four incompatible shapes happened the first time.
    const offenders: string[] = []
    for (const file of await srcFiles()) {
      const rel = relative(SRC_ROOT, file)
      if (rel === 'errors.ts') continue
      const src = await readFile(file, 'utf8')
      if (/\bextends Error\b/.test(src)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it('imports nothing from src/ into the errors module', async () => {
    // Every layer imports src/errors.ts, so a dependency here becomes a
    // dependency everywhere. Only node: builtins are allowed.
    const src = await readFile(new URL('./errors.ts', import.meta.url), 'utf8')
    const imports = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    expect(imports.filter((s) => s !== undefined && !s.startsWith('node:'))).toEqual([])
  })

  it('classifies every domain class to its declared domain and kind', () => {
    // The anti-drift guard for the taxonomy itself. It lives here rather than
    // in errors.test.ts because it drags publish, storage, jobs and scout into
    // whatever file holds it — exactly what this file exists to absorb.
    const cases: [Error, string][] = [
      [new PublishError('x', 'auth'), 'publish/auth'],
      [new PublishError('x', 'quota'), 'publish/quota'],
      [new PublishError('x', 'rejected'), 'publish/rejected'],
      [new PublishError('x', 'transient'), 'publish/transient'],
      [new PublishOutcomeUnknownError('x'), 'publish/unknown-outcome'],
      [new StorageError('x', 'not-found'), 'storage/not-found'],
      [new StorageError('x', 'auth'), 'storage/auth'],
      [new StorageError('x', 'transient'), 'storage/transient'],
      [new BudgetExceededError('x'), 'job/budget'],
      [new ResumeError('x', 'not-found'), 'job/not-found'],
      [new ResumeError('x', 'refused'), 'job/refused'],
      [new ResumeError('x', 'conflict'), 'job/conflict'],
      [new ScoutRunFailedError('x', []), 'scout/transient'],
      [new AllSourcesFailedError('x', []), 'scout/transient'],
      [new AllChannelsScoringFailedError('x', []), 'scout/transient'],
    ]
    for (const [err, code] of cases) {
      expect(classify(err).code).toBe(code)
    }
  })
})
