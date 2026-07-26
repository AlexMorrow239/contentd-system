import { BaseSequencer } from 'vitest/node'
import type { TestSpecification } from 'vitest/node'

/**
 * Vitest orders files by byte size. That puts golden-path.test.ts late — it is
 * a small file holding one indivisible ~15s test — so the whole run ends up
 * waiting on it after everything else has finished. Start the known-slow files
 * first instead, longest first, so the tail packs behind them.
 *
 * Suffix matching, not exact paths: moduleId is an absolute path.
 */
const SLOW_FIRST = [
  'src/jobs/golden-path.test.ts',
  'src/stages/visuals-volume.test.ts',
  'src/stages/qc.test.ts',
  'src/stages/assemble.test.ts',
  'src/cli.test.ts',
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
