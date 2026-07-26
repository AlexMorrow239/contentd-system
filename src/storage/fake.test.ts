import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describeObjectStore } from './conformance.js'
import { fakeStore } from './fake.js'

describeObjectStore('fakeStore', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'brainrot-fake-store-'))
  return {
    store: fakeStore(root),
    cleanup: async () => {
      rmSync(root, { recursive: true, force: true })
    },
  }
})
