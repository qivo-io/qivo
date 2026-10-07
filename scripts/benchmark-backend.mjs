// Hermetic Convex snapshot/activity comparison against a committed revision.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const baseline =
  process.argv.slice(2).find((arg) => !arg.startsWith('--')) ||
  '78a287fa0988870821ffd9fcd15feb442a84bc30'
const temporary = await mkdtemp(join(tmpdir(), 'qivo-backend-benchmark-'))
let server
try {
  process.env.SITE_URL = 'http://localhost:5199'
  process.env.CONVEX_SITE_URL = 'https://hermetic.convex.site'
  server = await createServer({
    root,
    cacheDir: join(temporary, 'cache'),
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    ssr: { noExternal: ['convex-test'] },
    server: { middlewareMode: true, hmr: false, watch: null },
  })
  const oldModule = async (path) => {
    const { stdout } = await promisify(execFile)('git', ['show', `${baseline}:${path}`], {
      cwd: root,
      encoding: 'utf8',
    })
    const source = stdout.replace(
      /from '([^']+)'/g,
      (_, relative) =>
        `from '${relative.startsWith('.') ? fileURLToPath(new URL(relative, new URL(path, `file://${root}`))) : fileURLToPath(import.meta.resolve(relative))}'`,
    )
    const target = join(temporary, path.split('/').at(-1))
    await writeFile(target, source)
    return server.ssrLoadModule(target)
  }
  const [oldSnapshot, oldActivity, harness] = await Promise.all([
    oldModule('convex/snapshot.ts'),
    oldModule('convex/model/activity.ts'),
    server.ssrLoadModule('/convex/tests/backendPerformance.setup.ts'),
  ])
  const results = await harness.benchmarkBackend({
    snapshot: oldSnapshot.forMe,
    activity: oldActivity.logActivity,
    guardsOnly: process.argv.includes('--guards-only'),
    currentOnly: process.argv.includes('--current-only'),
    assertEqual: assert.deepStrictEqual,
    report: (row) => console.log(JSON.stringify(row)),
  })
  console.log(
    `Baseline ${baseline}; Node ${process.version}; convex-test, no deployment or network.`,
  )
  console.log(
    'Timings include the in-memory emulator; query/document counts are transaction metrics.',
  )
  console.table(results)
} finally {
  await server?.close()
  await rm(temporary, { recursive: true, force: true })
}
