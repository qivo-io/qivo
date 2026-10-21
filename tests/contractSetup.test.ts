import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
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
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { marketingId } from '../convex/internal/marketingDemoData'
import { contractSetup } from './contract/global.setup.mts'

let parent: string
let root: string
let fixtures: string
let env: Record<string, string>
type Args = {
  id?: string
  kind?: string
  profile_id?: string
  name?: string
  name_prefix?: string
  created_before?: string
  pending?: boolean
}
let calls: { fn: string; args: Args }[]
/** A credential row on the fake deployment. A pending row is not usable. */
type Row = Required<Pick<Args, 'id' | 'kind' | 'profile_id' | 'name'>> & {
  pending?: boolean
  created_at?: string
}
let rows: Row[]
let logged: string[]
let exitCode: typeof process.exitCode

beforeEach(() => {
  logged = []
  vi.spyOn(console, 'log').mockImplementation((line: string) => {
    logged.push(line)
  })
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
  rows = []
  exitCode = process.exitCode
})

afterEach(() => {
  chmodSync(fixtures, 0o700)
  // a failed teardown marks the process as failed on purpose
  process.exitCode = exitCode
  vi.restoreAllMocks()
  rmSync(parent, { recursive: true, force: true })
})

/**
 * A fake `npx convex run` over `rows` that records each call. It throws
 * before a call on `fail`, and after it on `unreadable`, like a call that
 * succeeded but whose output could not be parsed.
 */
const runner =
  (fail?: (fn: string, args: Args) => boolean, unreadable?: (fn: string, args: Args) => boolean) =>
  (fn: string, args?: unknown) => {
    const call = { fn, args: args as Args }
    calls.push(call)
    if (fail?.(fn, call.args)) throw new Error(`${fn} failed`)
    const { id, kind, profile_id, name } = call.args
    let out: Record<string, unknown> = {}
    if (fn === 'machine/testing:mintCredential') {
      rows.push({
        id: `id-${kind}`,
        kind: kind!,
        profile_id: profile_id!,
        name: name!,
        pending: true,
        created_at: new Date().toISOString(),
      })
      out = { id: `id-${kind}` }
    } else if (fn === 'machine/testing:activateNamedCredentials') {
      const pending = rows.filter(
        (row) => row.profile_id === profile_id && row.name === name && row.pending,
      )
      for (const row of pending) delete row.pending
      out = { activated: pending.length }
    } else if (fn === 'machine/testing:deleteOldCredentials') {
      const before = rows.length
      const { name_prefix, created_before } = call.args
      rows = rows.filter(
        (row) =>
          !(
            row.profile_id === profile_id &&
            row.name.startsWith(name_prefix!) &&
            (row.created_at ?? '') < created_before!
          ),
      )
      out = { deleted: before - rows.length }
    } else if (fn === 'machine/testing:deleteCredential') {
      const before = rows.length
      rows = rows.filter((row) => !(row.id === id && row.kind === kind))
      out = { deleted: rows.length < before }
    } else if (fn === 'machine/testing:deleteNamedCredentials') {
      const before = rows.length
      rows = rows.filter((row) => !(row.profile_id === profile_id && row.name === name))
      out = { deleted: before - rows.length }
    }
    if (unreadable?.(fn, call.args)) throw new Error(`convex run ${fn}: no JSON on stdout`)
    return out
  }

const named = () =>
  calls
    .filter((call) => call.fn === 'machine/testing:deleteNamedCredentials')
    .map((call) => call.args.name)
const minted = () =>
  calls.filter((call) => call.fn === 'machine/testing:mintCredential').map((call) => call.args)
/** The calls before the reset, other than the sweep of old credentials. */
const beforeReset = () =>
  calls
    .slice(
      0,
      calls.findIndex((call) => call.fn === 'reset'),
    )
    .filter((call) => call.fn !== 'machine/testing:deleteOldCredentials')
const stash = () => join(fixtures, 'contract-fine-goose-986.credentials.json')
const next = () => join(fixtures, 'contract-fine-goose-986.new.credentials.json')
const legacy = () => join(root, 'tests', 'contract', '.credentials.json')
const resetMarker = () => calls.push({ fn: 'reset', args: {} })
/** The lease module, for a pass in another process. */
const leaseModule = pathToFileURL(join(import.meta.dirname, 'contract', 'stash.mts')).href
/** Whether a pass in another process can take the lease now. Throws when
 * the other process fails for another reason than the lease. */
const takenElsewhere = () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { takeLease } from ${JSON.stringify(leaseModule)}
try {
  takeLease(${JSON.stringify(stash())}, 'fine-goose-986')
  console.log('taken')
} catch (error) {
  if (!/another contract pass/.test(error.message)) throw error
  console.log('refused')
}`,
    ],
    { encoding: 'utf8' },
  )
  const answer = child.stdout.trim()
  if (child.status !== 0 || !['taken', 'refused'].includes(answer))
    throw new Error(`the other process failed (${child.status}): ${child.stderr}`)
  return answer === 'taken'
}

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
    // every credential is named after the pass
    expect(saved.pass).toMatch(/^[0-9a-f]{16}$/)
    expect(minted().map((args) => args.name)).toEqual([
      `contract pass token ${saved.pass}`,
      `contract pass key ${saved.pass}`,
    ])
    // each mint asks for a credential that stays unusable until activated
    expect(minted().map((args) => args.pending)).toEqual([true, true])

    // both credentials are usable, and were activated only after both mints
    expect(rows.map((row) => [row.kind, row.pending])).toEqual([
      ['mcp_token', undefined],
      ['agent_key', undefined],
    ])
    expect(
      calls.slice(-4).map((call) => [call.fn.replace('machine/testing:', ''), call.args.name]),
    ).toEqual([
      ['mintCredential', `contract pass token ${saved.pass}`],
      ['mintCredential', `contract pass key ${saved.pass}`],
      ['activateNamedCredentials', `contract pass token ${saved.pass}`],
      ['activateNamedCredentials', `contract pass key ${saved.pass}`],
    ])

    teardown()
    expect(existsSync(stash())).toBe(false)
    expect(named()).toEqual(minted().map((args) => args.name))
    expect(rows).toEqual([])
    expect(logged.at(-1)).toBe('[contract] deleted 2 of the 2 credentials the pass tried to mint')
  })

  it('names each pass differently', async () => {
    ;(await contractSetup({ env, run: runner(), reset: () => {} }, root))()
    ;(await contractSetup({ env, run: runner(), reset: () => {} }, root))()
    const names = minted().map((args) => args.name)
    expect(new Set(names).size).toBe(4)
  })

  it('refuses to start while another pass on the deployment runs, and starts after it ends', async () => {
    const teardown = await contractSetup({ env, run: runner(), reset: () => {} }, root)
    const running = readFileSync(stash(), 'utf8')
    const before = calls.length
    const reset = vi.fn()
    await expect(contractSetup({ env, run: runner(), reset }, root)).rejects.toThrow(
      `contract setup: another contract pass (process ${process.pid}, started ${new Date(performance.timeOrigin).toISOString()}) is running against fine-goose-986. Let it finish or stop it, then start this pass again.`,
    )
    // the running pass keeps its stash and its credentials
    expect([calls.length - before, readFileSync(stash(), 'utf8'), rows.length]).toEqual([
      0,
      running,
      2,
    ])
    expect(reset).not.toHaveBeenCalled()
    // the refusal leaves the running pass holding the lease
    expect(takenElsewhere()).toBe(false)
    teardown()
    expect(takenElsewhere()).toBe(true)
    ;(await contractSetup({ env, run: runner(), reset }, root))()
    expect(reset).toHaveBeenCalledOnce()
  })

  it("revokes a pass's stash once its process is gone, and not before", async () => {
    // a pass in another process, killed after it minted and stashed its token
    const nora = await marketingId('northstar-labs', 'person:nora')
    const pass = '0123456789abcdef'
    const left = JSON.stringify({ siteUrl: env.VITE_CONVEX_SITE_URL, orgId: 'org', pass })
    writeFileSync(stash(), left)
    rows = [{ id: 'old', kind: 'mcp_token', profile_id: nora, name: `contract pass token ${pass}` }]
    const holder = spawn(
      process.execPath,
      [
        // drops the function that gives the lease back, and collects it
        '--expose-gc',
        '--input-type=module',
        '-e',
        `import { takeLease } from ${JSON.stringify(leaseModule)}
takeLease(${JSON.stringify(stash())}, 'fine-goose-986')
globalThis.gc()
console.log('held')
setInterval(() => {}, 1 << 30)`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    // also when the test times out
    onTestFinished(() => {
      holder.kill('SIGKILL')
    })
    try {
      await new Promise((done, fail) => {
        holder.stdout.once('data', done)
        holder.once('exit', fail)
      })
      await expect(contractSetup({ env, run: runner(), reset: resetMarker }, root)).rejects.toThrow(
        `another contract pass (process ${holder.pid}, started `,
      )
      expect([calls, readFileSync(stash(), 'utf8'), rows.length]).toEqual([[], left, 1])
    } finally {
      holder.kill('SIGKILL')
    }
    await once(holder, 'exit')
    const teardown = await contractSetup({ env, run: runner(), reset: resetMarker }, root)
    expect(beforeReset().map((call) => call.args.name)).toEqual([
      `contract pass token ${pass}`,
      `contract pass key ${pass}`,
    ])
    expect(rows.map((row) => row.id)).toEqual(['id-mcp_token', 'id-agent_key'])
    teardown()
    expect(rows).toEqual([])
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
    expect(rows).toEqual([])
    expect(logged.at(-1)).toMatch(/deleted 1 of the 2 credentials the pass tried to mint/)
  })

  it('reports what it deleted when the first mint fails', async () => {
    const run = runner((fn) => fn === 'machine/testing:mintCredential')
    await expect(contractSetup({ env, run, reset: () => {} }, root)).rejects.toThrow(
      'machine/testing:mintCredential failed',
    )
    expect(logged.at(-1)).toBe(
      '[contract] deleted 0 of the 1 credentials the pass tried to mint; the rest were never created or already deleted',
    )
  })

  it('deletes a credential whose mint succeeded but whose output could not be read', async () => {
    for (const kind of ['mcp_token', 'agent_key']) {
      rows = []
      const run = runner(
        undefined,
        (fn, args) => fn === 'machine/testing:mintCredential' && args.kind === kind,
      )
      await expect(contractSetup({ env, run, reset: () => {} }, root)).rejects.toThrow(
        'no JSON on stdout',
      )
      expect([kind, rows]).toEqual([kind, []])
      expect(existsSync(stash())).toBe(false)
    }
  })

  it('removes a replacement stash that a failed write left behind', async () => {
    const run = runner((fn, args) => {
      if (fn === 'machine/testing:mintCredential' && args.kind === 'agent_key')
        mkdirSync(join(next(), 'blocked'), { recursive: true })
      return false
    })
    await expect(contractSetup({ env, run, reset: () => {} }, root)).rejects.toThrow()
    expect([existsSync(stash()), existsSync(next()), rows]).toEqual([false, false, []])
  })

  it('deletes a credential whose mint output names no id', async () => {
    const fake = runner()
    const run = (fn: string, args?: unknown) => {
      const out = fake(fn, args)
      return fn === 'machine/testing:mintCredential' ? {} : out
    }
    await expect(contractSetup({ env, run, reset: () => {} }, root)).rejects.toThrow(
      'no credential id',
    )
    expect(rows).toEqual([])
  })

  it('resets and mints nothing on a deployment that does not mint pending credentials', async () => {
    const run = runner((fn) => fn === 'machine/testing:deleteOldCredentials')
    await expect(contractSetup({ env, run, reset: resetMarker }, root)).rejects.toThrow(
      'machine/testing:deleteOldCredentials failed',
    )
    expect(calls.map((call) => call.fn)).toEqual(['machine/testing:deleteOldCredentials'])
    expect(existsSync(stash())).toBe(false)
  })

  it('deletes what it minted when a credential is not pending to activate', async () => {
    const fake = runner()
    const run = (fn: string, args?: unknown) =>
      fn === 'machine/testing:activateNamedCredentials' ? { activated: 0 } : fake(fn, args)
    await expect(contractSetup({ env, run, reset: () => {} }, root)).rejects.toThrow(
      /activateNamedCredentials: activated 0 credentials of contract pass token [0-9a-f]{16}, not 1/,
    )
    expect([rows, existsSync(stash())]).toEqual([[], false])
  })

  it('deletes the pass credentials older than an hour before the reset, and no others', async () => {
    const nora = await marketingId('northstar-labs', 'person:nora')
    const atlas = await marketingId('northstar-labs', 'person:atlas')
    const hour = 60 * 60 * 1000
    const at = (ago: number) => new Date(Date.now() - ago).toISOString()
    const row = (id: string, profile_id: string, name: string, created_at: string): Row => ({
      id,
      kind: profile_id === nora ? 'mcp_token' : 'agent_key',
      profile_id,
      name,
      created_at,
    })
    rows = [
      // a late mint's pending row, and a credential from before the pass id
      {
        ...row('late', nora, 'contract pass token 0123456789abcdef', at(hour + 1000)),
        pending: true,
      },
      row('fixed', atlas, 'contract pass key', at(2 * hour)),
      // a pass that may still run elsewhere, and credentials of people
      row('recent', atlas, 'contract pass key fedcba9876543210', at(hour - 60_000)),
      row('laptop', nora, 'Nora laptop', at(2 * hour)),
      row('elsewhere', atlas, 'contract pass token 0123456789abcdef', at(2 * hour)),
    ]
    const teardown = await contractSetup({ env, run: runner(), reset: resetMarker }, root)
    const sweeps = calls.slice(
      0,
      calls.findIndex((call) => call.fn === 'reset'),
    )
    expect(sweeps.map((call) => [call.fn, call.args.profile_id, call.args.name_prefix])).toEqual([
      ['machine/testing:deleteOldCredentials', nora, 'contract pass token'],
      ['machine/testing:deleteOldCredentials', atlas, 'contract pass key'],
    ])
    expect(rows.map((left) => left.id)).toEqual([
      'recent',
      'laptop',
      'elsewhere',
      'id-mcp_token',
      'id-agent_key',
    ])
    expect(logged).toContain('[contract] deleted 2 pass credentials older than an hour')
    teardown()
  })

  it('still deletes what it minted when the stash cannot be written or removed', async () => {
    // the path turns into a directory once both credentials exist
    const run = runner((_fn, args) => {
      if (args.kind === 'agent_key') {
        rmSync(stash(), { force: true })
        mkdirSync(join(stash(), 'blocked'), { recursive: true })
      }
      return false
    })
    await expect(contractSetup({ env, run, reset: () => {} }, root)).rejects.toThrow(AggregateError)
    expect(named()).toHaveLength(2)
    expect(rows).toEqual([])
  })

  it('keeps the pass id stashed when the full stash cannot replace it', async () => {
    // the full stash cannot be written, and the cleanup that follows fails
    let minting = false
    const run = runner((fn, args) => {
      if (fn === 'machine/testing:mintCredential') minting = true
      if (fn === 'machine/testing:mintCredential' && args.kind === 'agent_key')
        mkdirSync(join(next(), 'blocked'), { recursive: true })
      return minting && fn === 'machine/testing:deleteNamedCredentials'
    })
    await expect(contractSetup({ env, run, reset: () => {} }, root)).rejects.toThrow(AggregateError)
    expect(existsSync(next())).toBe(true)
    const left = JSON.parse(readFileSync(stash(), 'utf8'))
    expect(left.pass).toMatch(/^[0-9a-f]{16}$/)
    expect(minted().map((args) => args.name)).toEqual([
      `contract pass token ${left.pass}`,
      `contract pass key ${left.pass}`,
    ])
  })

  it('keeps one stash per deployment', async () => {
    const other = {
      ...env,
      CONVEX_DEPLOY_KEY: 'dev:brave-otter-123|test-key',
      VITE_CONVEX_SITE_URL: 'https://brave-otter-123.convex.site',
    }
    // passes on different deployments run side by side
    const running = await contractSetup({ env, run: runner(), reset: () => {} }, root)
    const teardown = await contractSetup({ env: other, run: runner(), reset: () => {} }, root)
    teardown()
    expect(existsSync(stash())).toBe(true)
    expect(existsSync(join(fixtures, 'contract-brave-otter-123.credentials.json'))).toBe(false)
    running()
  })

  it('tries every delete and keeps the stash for the next pass when one fails', async () => {
    let tearingDown = false
    const run = runner(
      (fn, args) =>
        tearingDown &&
        fn === 'machine/testing:deleteNamedCredentials' &&
        /token/.test(args.name ?? ''),
    )
    const teardown = await contractSetup({ env, run, reset: () => {} }, root)
    tearingDown = true
    expect(() => teardown()).toThrow(AggregateError)
    // a failed teardown still gives the lease back
    expect(takenElsewhere()).toBe(true)
    expect(process.exitCode).toBe(1)
    expect(named()).toHaveLength(2)
    expect(rows.map((row) => row.kind)).toEqual(['mcp_token'])
    expect(JSON.parse(readFileSync(stash(), 'utf8')).qvtId).toBe('id-mcp_token')
  })

  it('revokes by name what an interrupted pass left before the reset, and removes its stash', async () => {
    // a pass killed after its first mint, before it saved the id
    const nora = await marketingId('northstar-labs', 'person:nora')
    const atlas = await marketingId('northstar-labs', 'person:atlas')
    const pass = '0123456789abcdef'
    const left = { siteUrl: env.VITE_CONVEX_SITE_URL, orgId: 'org', pass }
    writeFileSync(stash(), JSON.stringify(left))
    const own = { id: 'own', kind: 'mcp_token', profile_id: nora, name: 'Nora laptop' }
    rows = [{ id: 'old', kind: 'mcp_token', profile_id: nora, name: `contract pass token ${pass}` }]
    rows.push(own)

    const teardown = await contractSetup({ env, run: runner(), reset: resetMarker }, root)
    expect(beforeReset()).toEqual([
      {
        fn: 'machine/testing:deleteNamedCredentials',
        args: { profile_id: nora, name: `contract pass token ${pass}` },
      },
      {
        fn: 'machine/testing:deleteNamedCredentials',
        args: { profile_id: atlas, name: `contract pass key ${pass}` },
      },
    ])
    expect(rows.filter((row) => row.id !== 'id-mcp_token' && row.id !== 'id-agent_key')).toEqual([
      own,
    ])
    expect(JSON.parse(readFileSync(stash(), 'utf8')).pass).not.toBe(pass)

    teardown()
  })

  it('revokes by id what an older pass left, and removes its stash', async () => {
    // the same deployment, saved under its other accepted site form
    const site = 'https://fine-goose-986.convex.site'
    writeFileSync(stash(), JSON.stringify({ siteUrl: site, qvaId: 'old-qva', qvtId: 'old-qvt' }))
    writeFileSync(legacy(), JSON.stringify({ siteUrl: 'https://other-1.convex.site', qvaId: 'x' }))
    const teardown = await contractSetup({ env, run: runner(), reset: resetMarker }, root)
    expect(existsSync(legacy())).toBe(false)
    expect(beforeReset()).toEqual([
      { fn: 'machine/testing:deleteCredential', args: { id: 'old-qva', kind: 'agent_key' } },
      { fn: 'machine/testing:deleteCredential', args: { id: 'old-qvt', kind: 'mcp_token' } },
    ])
    expect(JSON.parse(readFileSync(stash(), 'utf8')).qvaId).toBe('id-agent_key')

    teardown()
  })

  it('keeps a leftover stash and stops before the reset when revoking it fails', async () => {
    const left = JSON.stringify({ siteUrl: env.VITE_CONVEX_SITE_URL, pass: '0123456789abcdef' })
    writeFileSync(stash(), left)
    const run = runner((fn) => fn === 'machine/testing:deleteNamedCredentials')
    await expect(contractSetup({ env, run, reset: resetMarker }, root)).rejects.toThrow(
      'machine/testing:deleteNamedCredentials failed',
    )
    expect(readFileSync(stash(), 'utf8')).toBe(left)
    expect(calls.map((call) => call.fn)).toEqual(['machine/testing:deleteNamedCredentials'])
  })

  it('keeps an older stash and stops before the reset when revoking an id fails', async () => {
    const left = JSON.stringify({ siteUrl: env.VITE_CONVEX_SITE_URL, qvaId: 'old-qva' })
    writeFileSync(stash(), left)
    const run = runner((fn) => fn === 'machine/testing:deleteCredential')
    await expect(contractSetup({ env, run, reset: resetMarker }, root)).rejects.toThrow(
      'machine/testing:deleteCredential failed',
    )
    expect(readFileSync(stash(), 'utf8')).toBe(left)
    expect(calls.map((call) => call.fn)).toEqual(['machine/testing:deleteCredential'])
  })

  it('revokes every id a stash holds, and by name only for a well-formed pass id', async () => {
    for (const pass of ['', 'not-a-pass', '0123456789abcdef']) {
      calls = []
      const left = { siteUrl: env.VITE_CONVEX_SITE_URL, pass, qvaId: 'old-qva', qvtId: 'old-qvt' }
      writeFileSync(stash(), JSON.stringify(left))
      writeFileSync(next(), 'a replacement a failed write left')
      ;(await contractSetup({ env, run: runner(), reset: resetMarker }, root))()
      expect([pass, beforeReset().map((call) => call.args.name ?? call.args.id)]).toEqual([
        pass,
        pass === '0123456789abcdef'
          ? [`contract pass token ${pass}`, `contract pass key ${pass}`, 'old-qva', 'old-qvt']
          : ['old-qva', 'old-qvt'],
      ])
      expect(existsSync(next())).toBe(false)
    }
  })

  it('reads the fixture directory from .env.local when the environment has none', async () => {
    writeFileSync(join(root, '.env.local'), `QIVO_FIXTURE_CREDENTIALS_DIR=${fixtures}\n`)
    const { QIVO_FIXTURE_CREDENTIALS_DIR: _, ...exported } = env
    const teardown = await contractSetup({ env: exported, run: runner(), reset: () => {} }, root)
    expect(existsSync(stash())).toBe(true)
    teardown()
  })
})
