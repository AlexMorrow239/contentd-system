import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DASHBOARD_STAGE_ORDER } from './dashboard/queries/jobs.js'
import { classify } from './errors.js'
import { BudgetExceededError } from './jobs/costs.js'
import { pipelineStages } from './jobs/pipeline.js'
import { ResumeError } from './jobs/resume.js'
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

// Every lint below walks the same tree and greps the same files, so both the
// listings and the file contents are memoized per directory/path: the whole
// file then costs one read of src/ rather than one per lint.
const listings = new Map<string, Promise<string[]>>()
const contents = new Map<string, Promise<string | null>>()

function srcFiles(dir: string = SRC_ROOT): Promise<string[]> {
  const cached = listings.get(dir)
  if (cached !== undefined) return cached
  const walk = (async () => {
    const entries = await readdir(dir, { withFileTypes: true })
    const nested = await Promise.all(
      entries.map(async (e) => {
        const full = join(dir, e.name)
        if (e.isDirectory()) return srcFiles(full)
        return e.name.endsWith('.ts') ? [full] : []
      }),
    )
    return nested.flat()
  })()
  listings.set(dir, walk)
  return walk
}

/**
 * The source files of one module directory: the tree minus its own tests and
 * fixtures, which is what every "module X may not import Y" lint means by
 * "module X".
 */
async function moduleFiles(dir: string): Promise<string[]> {
  const files = await srcFiles(dir)
  return files.filter((f) => !f.endsWith('.test.ts') && !f.includes('.fixtures.'))
}

/**
 * A file's text, or null when it does not exist on disk — a resolved
 * specifier that points nowhere is a dead end for the import walker, not an
 * error to diagnose.
 */
function readSource(file: string): Promise<string | null> {
  const cached = contents.get(file)
  if (cached !== undefined) return cached
  const read = readFile(file, 'utf8').catch(() => null)
  contents.set(file, read)
  return read
}

/**
 * Resolves an import specifier against the file that contains it, mapping
 * the ESM `.js` extension back to the `.ts` source on disk. Returns
 * undefined for a bare/package specifier (`hono`, `node:fs`,
 * `better-sqlite3`, …) — those aren't part of this repo's own import graph.
 */
function resolveRelativeSpecifier(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined
  const tsSpec = spec.endsWith('.js') ? `${spec.slice(0, -'.js'.length)}.ts` : spec
  return join(dirname(fromFile), tsSpec)
}

/**
 * DFS over the import graph (both `import ... from` and `export ... from`
 * re-exports — a barrel is exactly the shape this needs to see through)
 * starting from `startFiles`, looking for `target`. Returns the chain of
 * absolute paths from whichever start file reaches it first, or null if none
 * do. A visited set stops a cycle, or a diamond-shaped import graph, from
 * re-walking the same file twice.
 */
async function findImportChain(startFiles: string[], target: string): Promise<string[] | null> {
  const visited = new Set<string>()
  async function walk(file: string, chain: string[]): Promise<string[] | null> {
    if (file === target) return chain
    if (visited.has(file)) return null
    visited.add(file)
    const source = await readSource(file)
    if (source === null) return null
    for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
      const resolved = resolveRelativeSpecifier(file, match[1])
      if (resolved === undefined) continue
      const found = await walk(resolved, [...chain, resolved])
      if (found !== null) return found
    }
    return null
  }
  for (const start of startFiles) {
    const found = await walk(start, [start])
    if (found !== null) return found
  }
  return null
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

describe('dashboard action isolation', () => {
  it('never directly or transitively imports src/actions/handlers.ts from src/dashboard/', async () => {
    // handlers.ts transitively imports Remotion and the provider clients. The
    // dashboard is the one process terminating unauthenticated HTTP; it reads
    // src/actions/catalog.ts, which is pure metadata, and enqueues. Same rule,
    // same reason, as DASHBOARD_STAGE_ORDER above.
    //
    // This walks the import graph rather than grepping for the literal
    // substring "actions/handlers": a dashboard file importing a module that
    // itself imports handlers.ts — or a barrel re-exporting from it — would
    // pass a one-hop text grep while still pulling Remotion and the provider
    // clients into the dashboard process. Same specifier-parsing shape as the
    // "src/stories purity" lint below.
    const target = join(SRC_ROOT, 'actions', 'handlers.ts')
    const files = await moduleFiles(join(SRC_ROOT, 'dashboard'))
    expect(files.length).toBeGreaterThan(0)

    const chain = await findImportChain(files, target)
    expect(chain === null ? null : chain.map((f) => relative(SRC_ROOT, f)).join(' -> ')).toBeNull()
  })

  it('positive control: the walker does find actions/catalog.ts reachable from the dashboard', async () => {
    // The test above proves handlers.ts is UNREACHABLE — a claim that only
    // means something if findImportChain can also find things that ARE
    // reachable. Without this, a walker silently broken to always return null
    // (a bad edit to the regex, the visited-set, or resolveRelativeSpecifier)
    // would make the isolation test above pass for the wrong reason: "found
    // nothing" instead of "checked everything and found nothing". catalog.ts
    // is real, known-reachable metadata the dashboard is expected to import.
    const target = join(SRC_ROOT, 'actions', 'catalog.ts')
    const files = await moduleFiles(join(SRC_ROOT, 'dashboard'))
    const chain = await findImportChain(files, target)
    expect(chain).not.toBeNull()
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
      const src = (await readSource(file)) ?? ''
      if (src.includes(BANNED_IDIOM)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it('declares no Error subclass outside the errors module', async () => {
    // Every classifiable error extends BrainrotError, which is the only thing
    // in the repo permitted to extend Error directly (or any of its standard
    // built-in subtypes — TypeError, RangeError, etc.). This is the guard
    // that stops a new module from re-rolling its own hierarchy — which is
    // how ten classes in four incompatible shapes happened the first time.
    //
    // The needle is built from two pieces rather than written as one literal
    // regex so that this file's own source doesn't contain the contiguous
    // banned substring — otherwise this test would list itself as an
    // offender the moment the pattern is reformatted (a plain `/\bextends
    // Error\b/` literal happens to not self-match today, but only because
    // the `\b`'s backslash sits directly before `extends` in the source
    // text, which defeats the leading boundary check — an accident, not a
    // guarantee).
    const BUILTIN_ERROR_TYPES = [
      'Error',
      'TypeError',
      'RangeError',
      'SyntaxError',
      'EvalError',
      'URIError',
      'ReferenceError',
    ]
    const EXTENDS_BUILTIN_ERROR = new RegExp(
      String.raw`\bextends` + ' ' + `(?:${BUILTIN_ERROR_TYPES.join('|')})\\b`,
    )
    const offenders: string[] = []
    for (const file of await srcFiles()) {
      const rel = relative(SRC_ROOT, file)
      if (rel === 'errors.ts') continue
      const src = (await readSource(file)) ?? ''
      if (EXTENDS_BUILTIN_ERROR.test(src)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it('imports nothing from src/ into the errors module', async () => {
    // Every layer imports src/errors.ts, so a dependency here becomes a
    // dependency everywhere. Only node: builtins are allowed.
    const src = (await readSource(join(SRC_ROOT, 'errors.ts'))) ?? ''
    const imports = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    expect(imports.filter((s) => s !== undefined && !s.startsWith('node:'))).toEqual([])
  })

  it('classifies every domain class to its declared domain and kind', () => {
    // The anti-drift guard for the taxonomy itself. It lives here rather than
    // in errors.test.ts because it drags storage, jobs and scout into
    // whatever file holds it — exactly what this file exists to absorb.
    const cases: [Error, string][] = [
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

describe('path resolution conventions', () => {
  it('imports only node builtins into config/paths.ts', async () => {
    // Every entrypoint resolves its paths through this module, so a dependency
    // here becomes a dependency everywhere — the same reason src/errors.ts has
    // its own version of this lint.
    const src = (await readSource(join(SRC_ROOT, 'config', 'paths.ts'))) ?? ''
    const imports = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    expect(imports.filter((s) => s !== undefined && !s.startsWith('node:'))).toEqual([])
  })
})

describe('src/stories purity', () => {
  it('imports nothing from src/ except errors.ts', async () => {
    const files = await moduleFiles(join(SRC_ROOT, 'stories'))
    expect(files.length).toBeGreaterThan(0)
    const offenders: string[] = []
    for (const file of files) {
      const source = (await readSource(file)) ?? ''
      for (const match of source.matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
        const spec = match[1]
        // Sibling imports inside stories/ are fine; anything reaching out of
        // the directory must be errors.js.
        if (spec.startsWith('./')) continue
        if (spec === '../errors.js') continue
        offenders.push(`${relative(SRC_ROOT, file)} -> ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('never touches the database, filesystem, or network', async () => {
    const files = await moduleFiles(join(SRC_ROOT, 'stories'))
    const offenders: string[] = []
    for (const file of files) {
      const source = (await readSource(file)) ?? ''
      for (const banned of ['better-sqlite3', 'node:fs', 'node:http', 'fetch(']) {
        if (source.includes(banned)) offenders.push(`${relative(SRC_ROOT, file)}: ${banned}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
