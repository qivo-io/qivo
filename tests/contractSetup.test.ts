import {
  chmodSync,
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
let exitCode: typeof process.exitCode

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  parent = mkdtempSync(join(tmpdir(), 'qivo-contract-setup-'))
  root = join(parent, 'checkout')
  fixtures = join(parent, 'fixtures')
  mkdirSync(join(root, 'tests', 'contract'), { recursive: true })
  mkdirSync(fixtures)
  chmodSync(fixtures, 0o700)
  env = {
    CONVEX_DEPLOY_KEY: 'dev:fine-goose-986|test-key',
    VITE_CONVEX_SITE_URL: 'https://fine-goose-986.eu-west-1.convex.site',
    QIVO_FIXTURE_CREDENTIALS_DIR: fixtures,
  }
  calls = []
  exitCode = process.exitCode
})

afterEach(() => {
  // a failed teardown marks the process as failed on purpose
  process.exitCode = exitCode
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
const stash = () => join(fixtures, 'contract-fine-goose-986.credentials.json')
const legacy = () => join(root, 'tests', 'contract', '.credentials.json')
const resetMarker = () => calls.push({ fn: 'reset', args: {} })

describe('contract pass setup', () => {
  it('stashes the credentials privately outside the checkout and removes them at teardown', async () => {
    const teardown = await contractSetup({ env, run: runner(), reset: () => {} }, root)

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
    mkdirSync(inside)
    chmodSync(inside, 0o700)
    const shared = join(parent, 'shared')
    mkdirSync(shared)
    chmodSync(shared, 0o755)
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

  it('still deletes what it minted when the stash cannot be written or removed', async () => {
    // the path turns into a directory once both credentials exist
    const run = runner((_fn, args) => {
      if (args.kind === 'agent_key' && !existsSync(stash()))
        mkdirSync(join(stash(), 'blocked'), { recursive: true })
      return false
    })
    await expect(contractSetup({ env, run, reset: () => {} }, root)).rejects.toThrow(AggregateError)
    expect(deleted().map((args) => args.kind)).toEqual(['mcp_token', 'agent_key'])
  })

  it('keeps one stash per deployment', async () => {
    const other = {
      ...env,
      CONVEX_DEPLOY_KEY: 'dev:brave-otter-123|test-key',
      VITE_CONVEX_SITE_URL: 'https://brave-otter-123.convex.site',
    }
    await contractSetup({ env, run: runner(), reset: () => {} }, root)
    const teardown = await contractSetup({ env: other, run: runner(), reset: () => {} }, root)
    teardown()
    expect(existsSync(stash())).toBe(true)
    expect(existsSync(join(fixtures, 'contract-brave-otter-123.credentials.json'))).toBe(false)
  })

  it('tries every delete and keeps the stash for the next pass when one fails', async () => {
    const run = runner(
      (fn, args) => fn === 'machine/testing:deleteCredential' && args.kind === 'mcp_token',
    )
    const teardown = await contractSetup({ env, run, reset: () => {} }, root)
    expect(() => teardown()).toThrow(AggregateError)
    expect(process.exitCode).toBe(1)
    expect(deleted().map((args) => args.kind)).toEqual(['mcp_token', 'agent_key'])
    expect(JSON.parse(readFileSync(stash(), 'utf8')).qvtId).toBe('id-mcp_token')
  })

  it('revokes what an interrupted pass left before the reset, and removes its stash', async () => {
    // the same deployment, saved under its other accepted site form
    const site = 'https://fine-goose-986.convex.site'
    writeFileSync(stash(), JSON.stringify({ siteUrl: site, qvaId: 'old-qva', qvtId: 'old-qvt' }))
    writeFileSync(legacy(), JSON.stringify({ siteUrl: 'https://other-1.convex.site', qvaId: 'x' }))
    await contractSetup({ env, run: runner(), reset: resetMarker }, root)
    expect(existsSync(legacy())).toBe(false)
    expect(calls.slice(0, 3)).toEqual([
      { fn: 'machine/testing:deleteCredential', args: { id: 'old-qva', kind: 'agent_key' } },
      { fn: 'machine/testing:deleteCredential', args: { id: 'old-qvt', kind: 'mcp_token' } },
      { fn: 'reset', args: {} },
    ])
    expect(JSON.parse(readFileSync(stash(), 'utf8')).qvaId).toBe('id-agent_key')
  })

  it('keeps a leftover stash and stops before the reset when revoking it fails', async () => {
    const left = JSON.stringify({ siteUrl: env.VITE_CONVEX_SITE_URL, qvaId: 'old-qva' })
    writeFileSync(stash(), left)
    const run = runner((fn) => fn === 'machine/testing:deleteCredential')
    await expect(contractSetup({ env, run, reset: resetMarker }, root)).rejects.toThrow(
      'machine/testing:deleteCredential failed',
    )
    expect(readFileSync(stash(), 'utf8')).toBe(left)
    expect(calls.map((call) => call.fn)).toEqual(['machine/testing:deleteCredential'])
  })

  it('reads the fixture directory from .env.local when the environment has none', async () => {
    writeFileSync(join(root, '.env.local'), `QIVO_FIXTURE_CREDENTIALS_DIR=${fixtures}\n`)
    const { QIVO_FIXTURE_CREDENTIALS_DIR: _, ...exported } = env
    const teardown = await contractSetup({ env: exported, run: runner(), reset: () => {} }, root)
    expect(existsSync(stash())).toBe(true)
    teardown()
  })
})
