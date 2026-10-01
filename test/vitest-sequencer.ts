import type { TestSpecification } from 'vitest/node'
import { BaseSequencer } from 'vitest/node'

/**
 * Vitest orders files by byte size, which correlates poorly with runtime here:
 * the slowest files are small ones holding a handful of ffmpeg/Remotion tests.
 * Left alone, the run ends up waiting on them after everything else finished.
 * Start the known-slow files first instead, longest first, so the tail packs
 * behind them.
 *
 * Ordered by measured wall time, slowest first. Re-measure with:
 *   pnpm vitest run --reporter=json --outputFile=/tmp/t.json
 *
 * This list had gone stale: it was missing integrations/remotion/remotion.test.ts — 36
 * lines holding a real Remotion bundle, so byte-size ordering scheduled it
 * dead last, the exact failure this sequencer exists to prevent — along with
 * golden-path-loop and every CLI-spawning file. test/vitest-sequencer.test.ts
 * now fails if an entry stops matching a real file, so a rename cannot
 * silently re-stale it.
 *
 * Suffix matching, not exact paths: moduleId is an absolute path.
 */
export const SLOW_FIRST = [
  'daemon/src/features/production/jobs/test/golden-path.test.ts', // one indivisible e2e render — the suite's floor
  'daemon/src/features/production/stages/test/assemble.test.ts', // real Remotion render
  'daemon/src/features/production/stages/test/visuals-volume.test.ts', // ffmpeg crop+loop
  'daemon/src/features/production/stages/test/qc.test.ts', // ffmpeg analysis passes
  'integrations/remotion/remotion.test.ts', // bundle() + selectComposition
  'daemon/src/features/production/jobs/test/golden-path-loop.test.ts', // scout -> produce e2e
  // Every CLI-spawning file: a cold `node daemon/dist/cli.js` costs seconds, not the
  // ~0.34s the runCli docstring once claimed, because the entry point pulls in
  // the whole pipeline. cli.test.ts holds every subcommand's subprocess tests
  // alongside its in-process ones — a single file per module, not a facet
  // split.
  'daemon/src/cli.test.ts',
  'daemon/testing/run-cli.test.ts',
  'daemon/src/features/production/jobs/test/resume.test.ts',
  'daemon/src/features/production/test/produce-next.test.ts',
  'daemon/src/infra/media/ffmpeg.test.ts', // real ffmpeg encodes
]

function rank(spec: TestSpecification): number {
  const i = SLOW_FIRST.findIndex((suffix) => spec.moduleId.endsWith(suffix))
  return i === -1 ? SLOW_FIRST.length : i
}

export class SlowFilesFirstSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const base = await super.sort(files)
    // Partition instead of a flat re-sort: resorting the whole array by rank
    // would let any pair of non-SLOW_FIRST files swap across each other,
    // discarding whatever ordering BaseSequencer chose for them (project
    // sequencing, isolated-suites-first, etc). Pulling the slow files to the
    // front and leaving everyone else in BaseSequencer's exact relative order
    // gets the same effect without that risk.
    const slow = base.filter((f) => rank(f) < SLOW_FIRST.length)
    const rest = base.filter((f) => rank(f) === SLOW_FIRST.length)
    slow.sort((a, b) => rank(a) - rank(b))
    return [...slow, ...rest]
  }
}
