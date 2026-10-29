/* The export job's CRC-32 (convex/lib/crc32.ts) against Node's zlib.crc32,
 * the reference ZIP readers agree with. It runs here, in the Node project,
 * because the Convex suites run without Node's modules. */
import { randomBytes } from 'node:crypto'
import { crc32 as nodeCrc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { crc32 } from '../../convex/lib/crc32'

describe('crc32', () => {
  it("gives Node's zlib.crc32 for empty, text, binary and continued input", () => {
    const encoder = new TextEncoder()
    const inputs = [
      new Uint8Array(),
      encoder.encode('123456789'),
      encoder.encode('[\n{"id":"漢字","body":"Field notes"}\n]\n'),
      new Uint8Array(randomBytes(70_000)),
    ]
    for (const input of inputs) expect(crc32(input)).toBe(nodeCrc32(input))
    // the standard check value of CRC-32/ISO-HDLC
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926)
    // a CRC continued over two buffers is the CRC of both
    const [head, tail] = [inputs[3].subarray(0, 12_345), inputs[3].subarray(12_345)]
    expect(crc32(tail, crc32(head))).toBe(nodeCrc32(inputs[3]))
  })

  it('differs when one bit of the input changes', () => {
    const bytes = new Uint8Array(randomBytes(1024))
    const flipped = bytes.slice()
    flipped[500] ^= 1
    expect(crc32(flipped)).not.toBe(crc32(bytes))
    expect(crc32(flipped)).toBe(nodeCrc32(flipped))
  })
})
