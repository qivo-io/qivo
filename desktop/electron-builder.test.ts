import fs from 'node:fs'
import { createRequire } from 'node:module'
import net, { type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  type AfterPackContext,
  Arch,
  build,
  type Configuration,
  Packager,
  Platform,
} from 'electron-builder'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const configPath = require.resolve('./electron-builder.cjs')
const feed = 'https://downloads.qivo.io/desktop'

/** Sets these environment variables, removing those set to undefined, and returns a function that restores them. */
function setEnv(values: Record<string, string | undefined>) {
  const previous = Object.keys(values).map((name) => [name, process.env[name]] as const)
  const assign = (entries: Iterable<readonly [string, string | undefined]>) => {
    for (const [name, value] of entries) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  assign(Object.entries(values))
  return () => assign(previous)
}

/** Sets the build-time feed, or removes it, and returns a function that restores it. */
function setFeed(updateUrl?: string) {
  return setEnv({ QIVO_DESKTOP_UPDATE_URL: updateUrl || undefined })
}

/** Loads the build config as electron-builder would with this build-time feed. */
function loadConfig(updateUrl?: string): Configuration {
  const restore = setFeed(updateUrl)
  try {
    const createConfig: () => Configuration = require(configPath)
    return createConfig()
  } finally {
    restore()
  }
}

/** Runs the config's afterPack hook on a packed app. */
async function afterPack(config: Configuration, context: AfterPackContext): Promise<unknown> {
  if (typeof config.afterPack !== 'function') throw new Error('the config has no afterPack hook')
  return await config.afterPack(context)
}

/** Returns a local port that nothing listens on. */
async function closedPort() {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
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
  let runDirectory = ''
  beforeEach(() => {
    const parent = path.resolve('dev-temp/desktop-builder-tests')
    fs.mkdirSync(parent, { recursive: true })
    runDirectory = fs.mkdtempSync(path.join(parent, 'run-'))
  })
  afterEach(() => fs.rmSync(runDirectory, { recursive: true, force: true }))

  /**
   * Packs a fake app for this platform whose resources hold this
   * app-update.yml, or none. The context holds only what the hook reads when
   * the app holds the file or the platform is Windows.
   */
  function packed(updateConfig?: string, electronPlatformName = 'win32') {
    const appOutDir = fs.mkdtempSync(path.join(runDirectory, 'app-'))
    const resources = path.join(appOutDir, 'resources')
    fs.mkdirSync(resources)
    if (updateConfig) fs.writeFileSync(path.join(resources, 'app-update.yml'), updateConfig)
    return {
      electronPlatformName,
      appOutDir,
      packager: { getResourcesDir: (outDir: string) => path.join(outDir, 'resources') },
    } as unknown as AfterPackContext
  }

  const unsigned = `provider: generic\nurl: ${feed}\nupdaterCacheDirName: qivo-desktop-updater\n`
  const signed = `${unsigned}publisherName:\n  - Qivo AB\n`

  it('writes the build-time feed and refuses one that is not plain HTTPS', () => {
    expect(loadConfig(feed).publish).toEqual([{ provider: 'generic', url: feed }])
    expect(loadConfig().publish).toBeNull()
    for (const url of ['http://downloads.qivo.io/desktop', `${feed}?x=1`, 'https://u:p@qivo.io/'])
      expect(() => loadConfig(url), url).toThrow()
  })

  it('fails a Windows build with a feed but no signing publisher', async () => {
    for (const config of [
      unsigned,
      `${unsigned}publisherName: null\n`,
      `${unsigned}publisherName:\n`,
      `${unsigned}publisherName: []\n`,
      `${unsigned}publisherName: '  '\n`,
      `${unsigned}publisherName:\n  - Qivo AB\n  - ''\n`,
    ])
      await expect(afterPack(loadConfig(feed), packed(config)), config).rejects.toThrow(
        'known publisher',
      )
    // a feed from another publish setting than QIVO_DESKTOP_UPDATE_URL
    await expect(afterPack(loadConfig(), packed(unsigned))).rejects.toThrow('known publisher')
  })

  it('passes a signed Windows build and a Windows build without a feed', async () => {
    await expect(afterPack(loadConfig(feed), packed(signed))).resolves.toBeUndefined()
    await expect(
      afterPack(loadConfig(feed), packed(`${unsigned}publisherName: Qivo AB\n`)),
    ).resolves.toBeUndefined()
    await expect(afterPack(loadConfig(), packed())).resolves.toBeUndefined()
    // a Windows target that writes no app-update.yml never checks for updates
    await expect(afterPack(loadConfig(feed), packed())).resolves.toBeUndefined()
  })

  it('fails a macOS build with a feed, even a signed one', async () => {
    await expect(afterPack(loadConfig(feed), packed(signed, 'darwin'))).rejects.toThrow(
      'A darwin build cannot have an update feed',
    )
  })
})

describe('desktop builds through electron-builder', () => {
  // electron-builder searches upward for node_modules, so the project lives
  // outside this checkout.
  let project = ''
  // Holds a stand-in for the 7-Zip that electron-builder would otherwise
  // download, and an empty download cache. The stand-in writes an empty
  // archive at the path ending in .zip. electron-builder keeps the first 7-Zip
  // path it finds for the whole process, so the stand-in lives as long as this
  // file's tests. It is a shell script, so the one build that runs 7-Zip skips
  // on Windows.
  let tools = ''
  let restoreEnv = () => {}
  beforeAll(async () => {
    tools = fs.mkdtempSync(path.join(os.tmpdir(), 'qivo-desktop-tools-'))
    const stub = path.join(tools, '7za')
    fs.writeFileSync(
      stub,
      '#!/bin/sh\nfor arg; do case "$arg" in *.zip) : > "$arg" ;; esac; done\n',
    )
    fs.chmodSync(stub, 0o755)
    // Every mirror electron-builder downloads its tools and Electron from, and
    // the proxies it sends requests through, point at a closed local port, and
    // its cache starts empty. A build that tries to download anything then
    // fails at once without reaching the network.
    const closed = `http://127.0.0.1:${await closedPort()}/`
    const downloads = [
      'ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL',
      'NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR',
      'npm_config_electron_builder_binaries_mirror',
      'npm_package_config_electron_builder_binaries_mirror',
      'ELECTRON_BUILDER_BINARIES_MIRROR',
      'npm_config_electron_mirror',
      'NPM_CONFIG_ELECTRON_MIRROR',
      'npm_package_config_electron_mirror',
      'ELECTRON_MIRROR',
      'HTTPS_PROXY',
      'https_proxy',
      'HTTP_PROXY',
      'http_proxy',
    ]
    restoreEnv = setEnv({
      ...Object.fromEntries(downloads.map((name) => [name, closed])),
      ELECTRON_BUILDER_CACHE: path.join(tools, 'cache'),
      ELECTRON_BUILDER_7ZIP_PATH: stub,
    })
  })
  afterAll(() => {
    restoreEnv()
    fs.rmSync(tools, { recursive: true, force: true })
  })
  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'qivo-desktop-build-'))
    fs.writeFileSync(path.join(project, 'package.json'), '{"name":"qivo","version":"0.1.0"}')
    write('app/package.json', '{"name":"qivo-desktop","main":"dist/main.js","author":"Qivo"}')
    write('app/dist/main.js', '// app')
    // A stand-in for the unpacked Electron that electron-builder copies.
    write('electron/electron', '')
    fs.mkdirSync(path.join(project, 'electron/resources'))
  })
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }))

  function write(file: string, content: string) {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true })
    fs.writeFileSync(path.join(project, file), content)
  }

  /** Extends desktop/electron-builder.cjs the way `-c.` options on the command line do. */
  function configuration(overrides: Configuration = {}): Configuration {
    return {
      extends: configPath,
      directories: { app: path.join(project, 'app'), output: path.join(project, 'out') },
      electronDist: path.join(project, 'electron'),
      electronVersion: require('electron/package.json').version,
      // The stand-in executable has no fuses to flip.
      electronFuses: null,
      // The app has no dependencies to install or rebuild.
      npmRebuild: false,
      ...overrides,
    }
  }

  /** Runs a build with this build-time feed, or none, and lists the files it wrote. */
  async function run(
    updateUrl: string | undefined,
    start: () => Promise<unknown>,
  ): Promise<{ error?: string; files: string[] }> {
    let error: string | undefined
    const restore = setFeed(updateUrl)
    try {
      await start()
    } catch (cause) {
      error = (cause as Error).message
    } finally {
      restore()
    }
    const out = path.join(project, 'out')
    return { error, files: fs.existsSync(out) ? fs.readdirSync(out) : [] }
  }

  const linuxPackages = Platform.LINUX.createTarget(['deb', 'rpm', 'AppImage'], Arch.x64)

  it.skipIf(process.platform === 'win32')(
    'builds a Linux package without a feed',
    async () => {
      const result = await run(undefined, () =>
        build({
          projectDir: project,
          config: configuration(),
          targets: Platform.LINUX.createTarget('zip', Arch.x64),
          publish: 'never',
        }),
      )
      // electron-builder names the package after the root package version
      const { version } = require('../package.json')
      expect(result).toEqual({
        error: undefined,
        files: expect.arrayContaining([`Qivo-${version}-x64.zip`]),
      })
    },
    60_000,
  )

  const options = { targets: linuxPackages, publish: 'never' } as const
  it.each([
    {
      name: 'the build-time feed',
      updateUrl: feed,
      start: () => build({ ...options, projectDir: project, config: configuration() }),
    },
    {
      name: 'a feed in the Linux publish setting',
      start: () =>
        build({
          ...options,
          projectDir: project,
          config: configuration({ linux: { publish: { provider: 'generic', url: feed } } }),
        }),
    },
    {
      name: 'a feed in the deb publish setting',
      start: () =>
        build({
          ...options,
          projectDir: project,
          config: configuration({ deb: { publish: { provider: 'generic', url: feed } } }),
        }),
    },
    {
      // a build without the publish step, where only the targets write the feed
      name: 'the build-time feed and no publish step',
      updateUrl: feed,
      start: () =>
        new Packager({ ...options, projectDir: project, config: configuration() }).build(),
    },
    {
      // an app-update.yml that no publish setting names
      name: 'a feed file in the Electron folder',
      start: () => {
        write('electron/resources/app-update.yml', `provider: generic\nurl: ${feed}\n`)
        return build({ ...options, projectDir: project, config: configuration() })
      },
    },
  ])(
    'refuses a Linux build with $name before it writes a package',
    async ({ updateUrl, start }) => {
      const result = await run(updateUrl, start)
      expect(result.error).toContain('A Linux build cannot have an update feed')
      expect(result.files.filter((file) => /\.(deb|rpm|AppImage)$/.test(file))).toEqual([])
    },
    60_000,
  )

  it('refuses to package a prepackaged app before it writes an installer', async () => {
    // A Windows app from a build that failed the publisher check.
    write('win-unpacked/Qivo.exe', '')
    write('win-unpacked/resources/app-update.yml', `provider: generic\nurl: ${feed}\n`)
    write('linux-unpacked/qivo-desktop', '')
    const refused = 'without --prepackaged'
    for (const [prepackaged, targets, updateUrl] of [
      ['win-unpacked', Platform.WINDOWS.createTarget('nsis', Arch.x64), feed],
      // refused without a feed too, since the prepackaged app may hold one
      ['linux-unpacked', linuxPackages, undefined],
    ] as const) {
      const result = await run(updateUrl, () =>
        build({
          projectDir: project,
          config: configuration(),
          prepackaged: path.join(project, prepackaged),
          targets,
          publish: 'never',
        }),
      )
      expect(result, prepackaged).toEqual({ error: expect.stringContaining(refused), files: [] })
    }
  }, 60_000)

  it('refuses to write a package when another afterPack hook replaces the check', async () => {
    // as `-c.afterPack=<file>` on the command line does
    write('hook.cjs', 'module.exports = () => {}')
    for (const afterPack of [path.join(project, 'hook.cjs'), null]) {
      const result = await run(feed, () =>
        build({ ...options, projectDir: project, config: configuration({ afterPack }) }),
      )
      expect(result.error, String(afterPack)).toContain(
        'without --prepackaged and keep the afterPack hook of desktop/electron-builder.cjs',
      )
      expect(result.files.filter((file) => /\.(deb|rpm|AppImage)$/.test(file))).toEqual([])
    }
  }, 60_000)
})
