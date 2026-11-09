// The small ZIP the benchmark page's stand-in server links an organization
// export to (scripts/perf/server.mjs orgexport), which the page serves
// itself (scripts/perf/files.mjs), so the export page's saving and saved
// lines can be shot. One stored README.txt. It imports nothing, so the
// server's Web Worker can load it beside Node.

/* The CRC-32 a ZIP entry carries. */
function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

/** The archive's bytes. */
export const EXPORT_ZIP = (() => {
  const encoder = new TextEncoder()
  const name = encoder.encode('README.txt')
  const data = encoder.encode('A Qivo export from the benchmark page.\n')
  const crc = crc32(data)
  const out = new Uint8Array(30 + name.length + data.length + 46 + name.length + 22)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(4, 20, true)
  view.setUint32(14, crc, true)
  view.setUint32(18, data.length, true)
  view.setUint32(22, data.length, true)
  view.setUint16(26, name.length, true)
  out.set(name, 30)
  out.set(data, 30 + name.length)
  const central = 30 + name.length + data.length
  view.setUint32(central, 0x02014b50, true)
  view.setUint16(central + 4, 20, true)
  view.setUint16(central + 6, 20, true)
  view.setUint32(central + 16, crc, true)
  view.setUint32(central + 20, data.length, true)
  view.setUint32(central + 24, data.length, true)
  view.setUint16(central + 28, name.length, true)
  out.set(name, central + 46)
  const end = central + 46 + name.length
  view.setUint32(end, 0x06054b50, true)
  view.setUint16(end + 8, 1, true)
  view.setUint16(end + 10, 1, true)
  view.setUint32(end + 12, 46 + name.length, true)
  view.setUint32(end + 16, central, true)
  return out
})()
