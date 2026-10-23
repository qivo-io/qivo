import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { builtInUpdateConfig, ignoreUpdaterTestHooks } from './updates'

let resources: string

beforeEach(() => {
  const parent = path.resolve('dev-temp/desktop-updates-tests')
  fs.mkdirSync(parent, { recursive: true })
  resources = fs.mkdtempSync(path.join(parent, 'run-'))
})

afterEach(() => fs.rmSync(resources, { recursive: true, force: true }))

const runTimeFeed = { QIVO_DESKTOP_UPDATE_URL: 'https://updates.example/qivo' }

describe('desktop update feed', () => {
  it('never checks from a packaged build without a built-in feed, whatever the environment says', () => {
    expect(builtInUpdateConfig(true, {}, resources)).toBeNull()
    expect(builtInUpdateConfig(true, runTimeFeed, resources)).toBeNull()
  })

  it('checks only the built-in feed when the environment names another', () => {
    const configPath = path.join(resources, 'app-update.yml')
    fs.writeFileSync(configPath, 'provider: generic\nurl: https://downloads.qivo.io/desktop\n')
    expect(builtInUpdateConfig(true, {}, resources)).toBe(configPath)
    expect(builtInUpdateConfig(true, runTimeFeed, resources)).toBe(configPath)
  })

  it('lets the environment only turn checks off', () => {
    fs.writeFileSync(path.join(resources, 'app-update.yml'), 'provider: generic\n')
    expect(builtInUpdateConfig(true, { QIVO_DISABLE_UPDATES: '1' }, resources)).toBeNull()
    expect(builtInUpdateConfig(false, runTimeFeed, resources)).toBeNull()
  })

  it("drops electron-updater's test hooks and keeps everything else", () => {
    const env = {
      ELECTRON_BUILDER_LINUX_PACKAGE_MANAGER: 'apt',
      TEST_UPDATER_ARCH: 'arm64',
      HOME: '/home/user',
    }
    ignoreUpdaterTestHooks(env)
    expect(env).toEqual({ HOME: '/home/user' })
  })
})
