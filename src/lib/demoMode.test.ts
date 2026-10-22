import { describe, expect, it } from 'vitest'
import { DEMO_FILE_BYTES } from '../../convex/lib/limits'
import { assertDemoFileSize } from './demoMode'

describe('assertDemoFileSize', () => {
  it("refuses a file over the demo's limit with the backend's sentence, only on the demo", () => {
    expect(() => assertDemoFileSize(DEMO_FILE_BYTES, true)).not.toThrow()
    expect(() => assertDemoFileSize(DEMO_FILE_BYTES + 1, true)).toThrow(
      'Choose a file no larger than 5 MiB.',
    )
    expect(() => assertDemoFileSize(DEMO_FILE_BYTES + 1, false)).not.toThrow()
  })
})
