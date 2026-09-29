import { buildTestCli } from './build-test-cli.js'

/** Runs once, before any test worker starts. ~19ms for the whole daemon/src/ tree. */
export default async function setup(): Promise<void> {
  await buildTestCli()
}
