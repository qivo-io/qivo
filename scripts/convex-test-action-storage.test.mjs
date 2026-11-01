import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONVEX_TEST_VERSION,
  convexTestActionStorage,
  withActionStorage,
} from './convex-test-action-storage.mjs'

const file = fileURLToPath(new URL('../node_modules/convex-test/dist/index.js', import.meta.url))
const installed = readFileSync(file, 'utf8')
const { version } = JSON.parse(
  readFileSync(new URL('../node_modules/convex-test/package.json', import.meta.url), 'utf8'),
)

describe('withActionStorage', () => {
  it('applies its edit to the installed convex-test without moving a line', () => {
    expect(version).toBe(CONVEX_TEST_VERSION)
    const patched = withActionStorage(installed, version)
    expect(patched).toContain('if (nestedTxStorage.getStore() === undefined) {')
    expect(patched).not.toContain('if (!getTransactionManager().isInTransaction()) {')
    expect(patched.split('\n')).toHaveLength(installed.split('\n').length)
  })

  it('refuses another convex-test version', () => {
    expect(() => withActionStorage(installed, '0.0.59')).toThrow(
      'convex-test is 0.0.59, but scripts/convex-test-action-storage.mjs patches 0.0.58',
    )
  })

  it('refuses code where the edited line is missing or appears twice', () => {
    const line = 'if (!getTransactionManager().isInTransaction()) {'
    expect(() =>
      withActionStorage(installed.replace(line, 'if (!inTransaction()) {'), version),
    ).toThrow(`has 0 copies of \`${line}\``)
    expect(() => withActionStorage(`${installed}\n${line}\n`, version)).toThrow(
      `has 2 copies of \`${line}\``,
    )
  })
})

describe('convexTestActionStorage', () => {
  const { transform } = convexTestActionStorage()
  // Vite gives the plugin module IDs with forward slashes, on Windows too.
  const id = file.replaceAll('\\', '/')

  it('patches dist/index.js of convex-test and no other module', () => {
    expect(transform(installed, id).code).toBe(withActionStorage(installed, version))
    expect(transform(installed, `${id}?v=1`).code).toBe(withActionStorage(installed, version))
    const other = id.replace('/dist/index.js', '/dist/transactionMetrics.js')
    expect(transform(installed, other)).toBeNull()
  })
})

/* This suite's convex-test is the patched one, as vitest.config.mts loads
   it. Without the patch the first case fails with "Write outside of
   transaction". */
describe('a file write in the patched convex-test', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Holds every file hash convex-test takes until `release` is called. */
  function holdHashes() {
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    let release = () => {}
    const released = new Promise((resolve) => {
      release = resolve
    })
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
      await released
      return digest(...args)
    })
    return release
  }

  it("takes its own transaction in an action while another function's is open", async () => {
    const t = convexTest()
    const releaseHashes = holdHashes()
    let opened = () => {}
    let close = () => {}
    const open = new Promise((resolve) => {
      opened = resolve
    })
    const closing = new Promise((resolve) => {
      close = resolve
    })
    // another function holds a transaction open while the action starts its
    // write; one task later the action has reached it
    const other = t.run(async () => {
      opened()
      await closing
    })
    await open
    const stored = t.action(async (ctx) => ctx.storage.store(new Blob(['part'])))
    await new Promise((resolve) => setTimeout(resolve, 0))
    // that transaction ends before the write has its file's hash
    close()
    await other
    releaseHashes()
    const id = await stored
    expect(await t.run(async (ctx) => (await ctx.db.system.get(id))?.size)).toBe(4)
  })

  it('joins the transaction of the mutation it runs in', async () => {
    const t = convexTest()
    // a write of its own would wait for the lock this mutation holds
    const seen = await t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob(['part']))
      return (await ctx.db.system.get(id))?.size
    })
    expect(seen).toBe(4)
  })
})
