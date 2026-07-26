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
    // Array.prototype.sort is stable, so files not in SLOW_FIRST keep the
    // ordering BaseSequencer chose for them.
    const base = await super.sort(files)
    return base.sort((a, b) => rank(a) - rank(b))
  }
}
