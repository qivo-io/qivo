import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConvexHttpClient } from 'convex/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectBrowserDemo, loadBrowserDemo, signInBrowser } from './browser-demo.mjs'
import { loadCredentials, resolveTarget } from './marketing-demo.mjs'

const env = { CONVEX_DEPLOY_KEY: 'dev:tidy-otter-12|test-key' }
const folders = []
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'qivo-browser-demo-'))
  folders.push(cwd)
  const target = resolveTarget({ target: 'dev' }, env)
  loadCredentials(cwd, target, { create: true })
  return { cwd, env }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

describe('Northstar browser fixture', () => {
  it('loads Nora and Leo from the private development credential file', () => {
    const options = fixture()
    const first = loadBrowserDemo('http://localhost:5199', options)
    const second = loadBrowserDemo('http://127.0.0.1:5199/', options)
    expect(first.orgSlug).toBe('northstar-labs')
    expect(first.account('nora').email).toBe('nora@demo.qivo.io')
    expect(first.account('leo').email).toBe('leo@demo.qivo.io')
    expect(first.account('nora').password).toBe(second.account('nora').password)
    expect(first.account('nora').password).not.toBe(first.account('leo').password)
  })

  it('refuses production, remote origins and embedded URL credentials before browser work', () => {
    for (const base of [
      'https://qivo.io',
      'https://qivo.io/app',
      'http://other.example',
      'http://user:secret@localhost:5199',
      'http://localhost:5199/?secret=value',
    ]) {
      expect(() => loadBrowserDemo(base, { cwd: '/unused', env })).toThrow(
        /localhost development server/,
      )
    }
    expect(() =>
      loadBrowserDemo('http://localhost:5199', {
        cwd: '/unused',
        env: { CONVEX_DEPLOY_KEY: 'prod:happy-wolf-34|test-key' },
      }),
    ).toThrow(/does not match/)
  })

  it('requires existing credentials instead of generating another password set', () => {
    const { cwd } = fixture()
    expect(() =>
      loadBrowserDemo('http://localhost:5199', {
        cwd,
        env: { CONVEX_DEPLOY_KEY: 'dev:other-otter-13|test-key' },
      }),
    ).toThrow(/credentials are missing/)
  })

  it('refuses a local app configured for a different backend than its dev credentials', () => {
    const options = fixture()
    expect(() =>
      loadBrowserDemo('http://localhost:5199', {
        ...options,
        env: { ...env, VITE_CONVEX_URL: 'https://happy-wolf-34.convex.cloud' },
      }),
    ).toThrow(/does not match the development credential deployment/)
  })

  it('checks readiness and the credential receipt without writing or resetting the demo', async () => {
    const demo = loadBrowserDemo('http://localhost:5199', fixture())
    const query = vi.spyOn(ConvexHttpClient.prototype, 'query')
    const mutation = vi.spyOn(ConvexHttpClient.prototype, 'mutation')
    query.mockResolvedValueOnce({ state: 'absent' })
    await expect(inspectBrowserDemo(demo)).rejects.toThrow(/not ready/)
    query.mockResolvedValueOnce({ state: 'ready', credential_set_id: 'different' })
    await expect(inspectBrowserDemo(demo)).rejects.toThrow(/ownership receipt/)
    const state = {
      state: 'ready',
      credential_set_id: demo.credentials.value.credential_set_id,
      anchor: '2026-09-07',
      counts: { tasks: 90, users: 8 },
    }
    query.mockResolvedValueOnce(state)
    await expect(inspectBrowserDemo(demo)).resolves.toEqual({
      anchor: state.anchor,
      counts: state.counts,
    })
    expect(mutation).not.toHaveBeenCalled()
  })

  it('keeps Playwright password fill errors out of failure logs', async () => {
    const password = 'private-fixture-password'
    const page = {
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      fill: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error(`fill ${password}`)),
      click: vi.fn(),
    }
    try {
      await signInBrowser(page, { email: 'nora@demo.qivo.io', password })
      expect.fail('Expected the fill error to be refused')
    } catch (error) {
      expect(error.message).toBe('Browser sign-in failed while filling or submitting the form.')
      expect(String(error)).not.toContain(password)
      expect(error.cause).toBeUndefined()
    }
    expect(page.click).not.toHaveBeenCalled()
  })
})
