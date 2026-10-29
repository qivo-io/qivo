/* CRC-32 as ZIP stores it (ISO 3309, the reflected polynomial 0xEDB88320,
 * initial value and final XOR 0xFFFFFFFF), the same value as Node's
 * zlib.crc32. fflate 0.8.3 computes one only inside its ZIP stream classes
 * and exports no function for it, so the organization export job, which
 * compresses each archive part on its own (orgExport.ts step), computes it
 * here. */

/* The CRC of each byte value, built once when the module loads. */
const TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** The CRC-32 of `bytes`, an unsigned 32-bit number. `previous`, the CRC of
 * the bytes before them, continues a CRC over several buffers. */
export function crc32(bytes: Uint8Array, previous = 0): number {
  let c = ~previous >>> 0
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}
