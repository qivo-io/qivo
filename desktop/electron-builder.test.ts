import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const configPath = require.resolve('./electron-builder.cjs')

/** Loads the build config as electron-builder would with this build-time feed. */
function loadConfig(updateUrl?: string) {
  const previous = process.env.QIVO_DESKTOP_UPDATE_URL
  if (updateUrl) process.env.QIVO_DESKTOP_UPDATE_URL = updateUrl
  else delete process.env.QIVO_DESKTOP_UPDATE_URL
  delete require.cache[configPath]
  try {
    return require(configPath)
  } finally {
    if (previous === undefined) delete process.env.QIVO_DESKTOP_UPDATE_URL
    else process.env.QIVO_DESKTOP_UPDATE_URL = previous
    delete require.cache[configPath]
  }
}

describe('desktop package fuses', () => {
  it('turns off the Node.js entry points and app code outside app.asar', () => {
    const config = loadConfig()
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

describe('desktop update feed in the build', () => {
  let appOutDir = ''
  afterEach(() => {
    if (appOutDir) fs.rmSync(appOutDir, { recursive: true, force: true })
  })

  /** Packs a fake app whose resources hold this app-update.yml, or none. */
  function packed(platform: string, updateConfig?: string) {
    const parent = path.resolve('dev-temp/desktop-builder-tests')
    fs.mkdirSync(parent, { recursive: true })
    appOutDir = fs.mkdtempSync(path.join(parent, 'run-'))
    const resources = path.join(appOutDir, 'resources')
    fs.mkdirSync(resources)
    if (updateConfig) fs.writeFileSync(path.join(resources, 'app-update.yml'), updateConfig)
    return {
      electronPlatformName: platform,
      appOutDir,
      packager: { getResourcesDir: (outDir: string) => path.join(outDir, 'resources') },
    }
  }

  const feed = 'https://downloads.qivo.io/desktop'
  const unsigned = `provider: generic\nurl: ${feed}\nupdaterCacheDirName: qivo-desktop-updater\n`
  const signed = `${unsigned}publisherName:\n  - Qivo AB\n`

  it('writes the build-time feed and refuses one that is not plain HTTPS', () => {
    expect(loadConfig(feed).publish).toEqual([{ provider: 'generic', url: feed }])
    expect(loadConfig().publish).toBeNull()
    for (const url of ['http://downloads.qivo.io/desktop', `${feed}?x=1`, 'https://u:p@qivo.io/'])
      expect(() => loadConfig(url), url).toThrow()
  })

  it('fails a Windows build with a feed but no signing publisher', async () => {
    await expect(loadConfig(feed).afterPack(packed('win32', unsigned))).rejects.toThrow(
      'known publisher',
    )
  })

  it('passes a signed Windows build, a Linux build and a build without a feed', async () => {
    await expect(loadConfig(feed).afterPack(packed('win32', signed))).resolves.toBeUndefined()
    await expect(loadConfig(feed).afterPack(packed('linux', unsigned))).resolves.toBeUndefined()
    await expect(loadConfig().afterPack(packed('win32'))).resolves.toBeUndefined()
  })
})
