import { tmpDir } from '../testing/tmp.js'
import { describeObjectStore } from './conformance.js'
import { fakeStore } from './fake.js'

describeObjectStore('fakeStore', async () => {
  const root = tmpDir('brainrot-fake-store-')
  return {
    store: fakeStore(root),
    // The harness wants a cleanup hook (MinIO's implementation needs one);
    // tmpDir registers the dir with testing/tmp.ts, which sweeps it after the
    // file finishes, so there is nothing left for this one to do.
    cleanup: async () => {},
  }
})
