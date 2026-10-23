import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { builtInUpdateConfig, useBuiltInFeed } from './updates.js'

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

  it("points the updater at the built-in feed and drops the environment's updater overrides", () => {
    const configPath = path.join(resources, 'app-update.yml')
    fs.writeFileSync(configPath, 'provider: generic\n')
    const updater = { updateConfigPath: null as string | null }
    const env = {
      ...runTimeFeed,
      ELECTRON_BUILDER_LINUX_PACKAGE_MANAGER: 'apt',
      TEST_UPDATER_ARCH: 'arm64',
      APPIMAGE: '/home/user/Applications/Editor.AppImage',
      HOME: '/home/user',
    }
    const inputs = {
      packaged: true,
      env,
      resourcesPath: resources,
      executablePath: '/opt/Qivo/qivo',
    }
    expect(useBuiltInFeed(updater, inputs)).toBe(true)
    expect(updater.updateConfigPath).toBe(configPath)
    expect(env).toEqual({ ...runTimeFeed, HOME: '/home/user' })
  })

  it('keeps the APPIMAGE an AppImage launcher set', () => {
    fs.writeFileSync(path.join(resources, 'app-update.yml'), 'provider: generic\n')
    const env = { APPIMAGE: '/home/user/Applications/Qivo.AppImage' }
    const inputs = {
      packaged: true,
      env,
      resourcesPath: resources,
      executablePath: '/tmp/.mount_QivoAbC123/qivo',
    }
    expect(useBuiltInFeed({ updateConfigPath: null }, inputs)).toBe(true)
    expect(env).toEqual({ APPIMAGE: '/home/user/Applications/Qivo.AppImage' })
  })

  it('leaves the updater alone in a build that never checks', () => {
    const updater = { updateConfigPath: null as string | null }
    const env = { ...runTimeFeed, TEST_UPDATER_ARCH: 'arm64' }
    const inputs = {
      packaged: true,
      env,
      resourcesPath: resources,
      executablePath: '/opt/Qivo/qivo',
    }
    expect(useBuiltInFeed(updater, inputs)).toBe(false)
    expect(updater.updateConfigPath).toBeNull()
  })
})
