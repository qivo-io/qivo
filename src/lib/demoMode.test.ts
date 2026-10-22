import { describe, expect, it } from 'vitest'
import { DEMO_FILE_BYTES, MIB } from '../../convex/lib/limits'
import { assertDemoFileSize, attachmentTooLarge } from './demoMode'

describe('assertDemoFileSize', () => {
  it("refuses a file over the demo's limit with the backend's sentence, only on the demo", () => {
    expect(() => assertDemoFileSize(DEMO_FILE_BYTES, true)).not.toThrow()
    expect(() => assertDemoFileSize(DEMO_FILE_BYTES + 1, true)).toThrow(
      'Choose a file no larger than 5 MiB.',
    )
    expect(() => assertDemoFileSize(DEMO_FILE_BYTES + 1, false)).not.toThrow()
  })
})

describe('attachmentTooLarge', () => {
  it("names the demo's limit only on the demo, when it is the one that applies", () => {
    expect(attachmentTooLarge('a.png', DEMO_FILE_BYTES, true)).toBe(
      '"a.png" is larger than the 5 MiB demo limit',
    )
    // an organization limit below the demo's is the one that refused
    expect(attachmentTooLarge('a.png', 2 * MIB, true)).toBe(
      '"a.png" is larger than the 2 MiB organization limit',
    )
    expect(attachmentTooLarge('a.png', DEMO_FILE_BYTES, false)).toBe(
      '"a.png" is larger than the 5 MiB organization limit',
    )
  })
})
