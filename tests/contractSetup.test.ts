import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { contractSetup } from './contract/global.setup.mts'

let parent: string
let root: string
let fixtures: string
let env: Record<string, string>
let calls: { fn: string; args: { id?: string; kind?: string } }[]

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  parent = mkdtempSync(join(tmpdir(), 'qivo-contract-setup-'))
  root = join(parent, 'checkout')
  fixtures = join(parent, 'fixtures')
  mkdirSync(join(root, 'tests', 'contract'), { recursive: true })
  mkdirSync(fixtures, { mode: 0o700 })
  env = {
    CONVEX_DEPLOY_KEY: 'dev:fine-goose-986|test-key',
    VITE_CONVEX_SITE_URL: 'https://fine-goose-986.eu-west-1.convex.site',
    QIVO_FIXTURE_CREDENTIALS_DIR: fixtures,
  }
  calls = []
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(parent, { recursive: true, force: true })
})

/** A fake `npx convex run` that records each call and throws on `fail`. */
const runner =
  (fail?: (fn: string, args: { kind?: string }) => boolean) => (fn: string, args?: unknown) => {
    const call = { fn, args: args as { id?: string; kind?: string } }
    calls.push(call)
    if (fail?.(fn, call.args)) throw new Error(`${fn} failed`)
    return { id: `id-${call.args.kind}` }
  }

const deleted = () =>
  calls.filter((call) => call.fn === 'machine/testing:deleteCredential').map((call) => call.args)
const stash = () => join(fixtures, 'contract.credentials.json')

describe('contract pass setup', () => {
  it('stashes the credentials privately outside the checkout and removes them at teardown', async () => {
    const legacy = join(root, 'tests', 'contract', '.credentials.json')
    writeFileSync(legacy, '{}')
    const teardown = await contractSetup({ env, run: runner(), reset: () => {} }, root)

    expect(existsSync(legacy)).toBe(false)
    expect(statSync(stash()).mode & 0o777).toBe(0o600)
    const saved = JSON.parse(readFileSync(stash(), 'utf8'))
    expect(saved).toMatchObject({
      siteUrl: env.VITE_CONVEX_SITE_URL,
      qvaId: 'id-agent_key',
      qvtId: 'id-mcp_token',
    })
    expect(saved.qva).toMatch(/^qva_[0-9a-f]{48}$/)
    expect(saved.qvt).toMatch(/^qvt_[0-9a-f]{48}$/)

    teardown()
    expect(existsSync(stash())).toBe(false)
    expect(deleted()).toEqual([
      { id: 'id-mcp_token', kind: 'mcp_token' },
      { id: 'id-agent_key', kind: 'agent_key' },
    ])
  })

  it('refuses before the reset without a private fixture directory outside the checkout', async () => {
    const reset = vi.fn()
    const inside = join(root, 'secrets')
    mkdirSync(inside, { mode: 0o700 })
    const shared = join(parent, 'shared')
    mkdirSync(shared, { mode: 0o755 })
    for (const directory of [undefined, 'relative', inside, shared]) {
      const without = { ...env, QIVO_FIXTURE_CREDENTIALS_DIR: directory }
      await expect(contractSetup({ env: without, run: runner(), reset }, root)).rejects.toThrow(
        /QIVO_FIXTURE_CREDENTIALS_DIR|outside the application checkout|private/,
      )
    }
    expect(reset).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it('deletes what it minted and leaves no stash when the setup fails', async () => {
    const run = runner(
      (fn, args) => fn === 'machine/testing:mintCredential' && args.kind === 'agent_key',
    )
    await expect(contractSetup({ env, run, reset: () => {} }, root)).rejects.toThrow(
      'machine/testing:mintCredential failed',
    )
    expect(existsSync(stash())).toBe(false)
    expect(deleted()).toEqual([{ id: 'id-mcp_token', kind: 'mcp_token' }])
  })

  it('removes the stash and tries every delete when one delete fails', async () => {
    const run = runner(
      (fn, args) => fn === 'machine/testing:deleteCredential' && args.kind === 'mcp_token',
    )
    const teardown = await contractSetup({ env, run, reset: () => {} }, root)
    expect(() => teardown()).toThrow(AggregateError)
    expect(existsSync(stash())).toBe(false)
    expect(deleted().map((args) => args.kind)).toEqual(['mcp_token', 'agent_key'])
  })
})
