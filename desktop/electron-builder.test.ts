import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

describe('desktop package fuses', () => {
  it('turns off running other code as Qivo and encrypts cookies', () => {
    const config = require('./electron-builder.cjs')
    // Every fuse electron-builder sets. Electron 44's ninth, wasmTrapHandlers,
    // only speeds up WebAssembly and keeps its default.
    expect(config.electronFuses).toEqual({
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      loadBrowserProcessSpecificV8Snapshot: false,
      grantFileProtocolExtraPrivileges: false,
    })
    // the fuses rely on the packaged app.asar
    expect(config.asar).toBe(true)
  })
})
