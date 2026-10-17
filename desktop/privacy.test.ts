import fs from 'node:fs'
import type { OutgoingHttpHeaders } from 'node:http'
import path from 'node:path'
import { NsisUpdater, Provider, type UpdateInfo } from 'electron-updater'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { disableStagingUserId, keepSpellcheckOffline, sharedStagingUserId } from './privacy'

type AppAdapter = NonNullable<ConstructorParameters<typeof NsisUpdater>[1]>
type ProviderRuntimeOptions = ConstructorParameters<typeof Provider>[0]

let directory: string
let sentHeaders: OutgoingHttpHeaders[]
let latest: UpdateInfo

beforeEach(() => {
  const parent = path.resolve('dev-temp/desktop-privacy-tests')
  fs.mkdirSync(parent, { recursive: true })
  directory = fs.mkdtempSync(path.join(parent, 'run-'))
  sentHeaders = []
  latest = { version: '1.0.0', files: [], path: '', sha512: '', releaseDate: '' }
})

afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

/** Serves `latest` and records the headers electron-updater sets for the feed request. */
class RecordingProvider extends Provider<UpdateInfo> {
  constructor(_options: unknown, _updater: unknown, runtimeOptions: ProviderRuntimeOptions) {
    super(runtimeOptions)
  }

  override setRequestHeaders(value: OutgoingHttpHeaders | null): void {
    if (value) sentHeaders.push({ ...value })
    super.setRequestHeaders(value)
  }

  async getLatestVersion(): Promise<UpdateInfo> {
    return latest
  }

  resolveFiles() {
    return []
  }
}

/** Builds the real updater around a packaged-app stand-in rooted in the test folder. */
function createUpdater() {
  const app: AppAdapter = {
    version: '1.0.0',
    name: 'Qivo',
    isPackaged: true,
    appUpdateConfigPath: path.join(directory, 'app-update.yml'),
    userDataPath: directory,
    baseCachePath: directory,
    whenReady: async () => {},
    relaunch: () => {},
    quit: () => {},
    onQuit: () => {},
  }
  const updater = new NsisUpdater({ provider: 'custom', updateProvider: RecordingProvider }, app)
  updater.autoDownload = false
  updater.logger = null
  return updater
}

const idFile = () => path.join(directory, '.updaterId')

describe('electron-updater staging ID', () => {
  it('sends the shared nil ID and never writes an ID file', async () => {
    const updater = createUpdater()
    disableStagingUserId(updater)

    await updater.checkForUpdates()
    await updater.checkForUpdates()
    expect(sentHeaders.map((headers) => headers['x-user-staging-id'])).toEqual([
      sharedStagingUserId,
      sharedStagingUserId,
    ])
    expect(fs.existsSync(idFile())).toBe(false)

    // A staged rollout still evaluates, and the shared ID falls inside any
    // positive percentage.
    latest = { ...latest, version: '1.1.0', stagingPercentage: 10 }
    const result = await updater.checkForUpdates()
    expect(result?.isUpdateAvailable).toBe(true)
    expect(fs.existsSync(idFile())).toBe(false)
  })

  it('otherwise stores and sends a random per-install ID', async () => {
    await createUpdater().checkForUpdates()

    const sent = sentHeaders[0]['x-user-staging-id']
    expect(sent).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(sent).not.toBe(sharedStagingUserId)
    expect(fs.readFileSync(idFile(), 'utf8')).toBe(sent)
  })
})

describe('spellcheck dictionary downloads', () => {
  function fakeSession() {
    return {
      setSpellCheckerLanguages: vi.fn(),
      setSpellCheckerDictionaryDownloadURL: vi.fn(),
    }
  }

  it('turns spellcheck off on Linux and other Hunspell-only platforms', () => {
    for (const platform of ['linux', 'freebsd'] as const) {
      const session = fakeSession()
      keepSpellcheckOffline(session, platform)
      expect(session.setSpellCheckerLanguages).toHaveBeenCalledWith([])
      expect(session.setSpellCheckerDictionaryDownloadURL).toHaveBeenCalledWith('data:,')
    }
  })

  it('keeps the Windows spellchecker and points Hunspell downloads at a data URL', () => {
    const session = fakeSession()
    keepSpellcheckOffline(session, 'win32')
    expect(session.setSpellCheckerDictionaryDownloadURL).toHaveBeenCalledWith('data:,')
    expect(session.setSpellCheckerLanguages).not.toHaveBeenCalled()
  })

  it('leaves the macOS system spellchecker alone', () => {
    const session = fakeSession()
    keepSpellcheckOffline(session, 'darwin')
    expect(session.setSpellCheckerLanguages).not.toHaveBeenCalled()
    expect(session.setSpellCheckerDictionaryDownloadURL).not.toHaveBeenCalled()
  })
})
