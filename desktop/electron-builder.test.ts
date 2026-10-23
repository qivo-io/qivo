import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

describe('desktop package fuses', () => {
  it('turns off the Node.js entry points and app code outside app.asar', () => {
    const config = require('./electron-builder.cjs')
    // Every fuse electron-builder sets. Electron 44's ninth, wasmTrapHandlers,
    // only speeds up WebAssembly and keeps its default.
    expect(config.electronFuses).toEqual({
      runAsNode: false,
      enableCookieEncryption: false,
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
