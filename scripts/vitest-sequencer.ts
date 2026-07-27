import { BaseSequencer } from 'vitest/node'
import type { TestSpecification } from 'vitest/node'

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
 * This list had gone stale: it was missing remotion/remotion.test.ts — 36
 * lines holding a real Remotion bundle, so byte-size ordering scheduled it
 * dead last, the exact failure this sequencer exists to prevent — along with
 * golden-path-loop and every CLI-spawning file. src/testing/sequencer.test.ts
 * now fails if an entry stops matching a real file, so a rename cannot
 * silently re-stale it.
 *
 * Suffix matching, not exact paths: moduleId is an absolute path.
 */
export const SLOW_FIRST = [
  'src/jobs/test/golden-path.test.ts', // one indivisible e2e render — the suite's floor
  'src/stages/test/assemble.test.ts', // real Remotion render
  'src/stages/test/visuals-volume.test.ts', // ffmpeg crop+loop
  'src/stages/test/qc.test.ts', // ffmpeg analysis passes
  'remotion/remotion.test.ts', // bundle() + selectComposition
  'src/jobs/test/golden-path-loop.test.ts', // scout -> produce -> publish e2e
  // Every CLI-spawning file: a cold `node dist/cli.js` costs seconds, not the
  // ~0.34s the runCli docstring once claimed, because the entry point pulls in
  // the whole pipeline. cli.test.ts and loop/test/publish-next.test.ts each
  // hold their subcommand's subprocess tests alongside their in-process ones —
  // a single file per module, not a facet split.
  'src/cli.test.ts',
  'src/testing/run-cli.test.ts',
  'src/jobs/test/resume.test.ts',
  'src/loop/test/publish-next.test.ts',
  'src/loop/test/produce-next.test.ts',
  'src/media/ffmpeg.test.ts', // real ffmpeg encodes
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
