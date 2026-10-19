// Hermetic Convex snapshot/activity comparison against a committed revision.
//
//   node scripts/benchmark-backend.mjs [revision] [--guards-only] [--current-only]
//
// `revision` is the commit the working tree's snapshot.forMe and logActivity
// are compared with. It defaults to the merge base of HEAD and origin/main,
// so a branch is measured against the commit it started from, and to HEAD in
// a checkout without origin/main. --current-only measures the working tree
// alone and needs no revision.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))

/** A baseline that cannot be used, with a sentence that says what to do. */
export class BaselineError extends Error {}

/** Runs git in the checkout and resolves its trimmed output. A failure
    carries git's exit status as `code`, or a string such as ENOENT when git
    could not run. */
async function runGit(args) {
  const { stdout } = await promisify(execFile)('git', args, { cwd: root, encoding: 'utf8' })
  return stdout.trim()
}

/** `run`'s output, or '' when git exits with one of `statuses`. Any other
    failure, such as git missing or a checkout that is not a repository,
    rejects as it was. */
const unlessStatus = (run, statuses) =>
  run.catch((error) => {
    if (statuses.includes(error?.code)) return ''
    throw error
  })

/** The commit to compare with, and how it was chosen. The first argument
    that is not a flag names it, and it must resolve to a commit in this
    checkout. Without one, it is the merge base of HEAD and origin/main, or
    HEAD when there is no origin/main. `git` runs a git command and resolves
    its trimmed output, rejecting with git's exit status as `code` when git
    fails. Rejects with a BaselineError for a revision that does not
    resolve, and for an origin/main that shares no history with HEAD, as in
    a shallow clone. */
export async function resolveBaseline(args, git = runGit) {
  const named = args.find((arg) => !arg.startsWith('--'))
  // --verify --quiet exits 1 for a revision that is not a commit
  const commitOf = (revision) =>
    unlessStatus(git(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]), [1])
  if (named !== undefined) {
    const commit = await commitOf(named)
    if (!commit)
      throw new BaselineError(
        `The baseline revision "${named}" is not a commit in this checkout. Pass a commit, branch or tag that exists here, for example origin/main.`,
      )
    return { commit, chosen: named }
  }
  // merge-base exits 1 without shared history and 128 without origin/main
  const base = await unlessStatus(git(['merge-base', 'HEAD', 'origin/main']), [1, 128])
  if (base) return { commit: base, chosen: 'merge base of HEAD and origin/main' }
  if (await commitOf('origin/main'))
    throw new BaselineError(
      'HEAD shares no history with origin/main in this checkout, for example in a shallow clone. Pass the revision to compare with.',
    )
  return { commit: await commitOf('HEAD'), chosen: 'HEAD, since there is no origin/main' }
}

async function main(args) {
  const currentOnly = args.includes('--current-only')
  let baseline = null
  if (!currentOnly) {
    try {
      baseline = await resolveBaseline(args)
    } catch (error) {
      if (!(error instanceof BaselineError)) throw error
      console.error(error.message)
      process.exitCode = 1
      return
    }
  }
  const { createServer } = await import('vite')
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
    /* `path` as the baseline commit has it, loaded with its imports pointed
       at the working tree. */
    const oldModule = async (path) => {
      const stdout = await runGit(['show', `${baseline.commit}:${path}`])
      const source = stdout.replace(
        /from '([^']+)'/g,
        (_, relative) =>
          `from '${relative.startsWith('.') ? fileURLToPath(new URL(relative, new URL(path, `file://${root}`))) : fileURLToPath(import.meta.resolve(relative))}'`,
      )
      const target = join(temporary, path.split('/').at(-1))
      await writeFile(target, source)
      return server.ssrLoadModule(target)
    }
    const harness = await server.ssrLoadModule('/convex/tests/backendPerformance.setup.ts')
    const options = {
      guardsOnly: args.includes('--guards-only'),
      assertEqual: assert.deepStrictEqual,
      report: (row) => console.log(JSON.stringify(row)),
    }
    let compared = { currentOnly: true }
    if (baseline !== null) {
      const [oldSnapshot, oldActivity] = await Promise.all([
        oldModule('convex/snapshot.ts'),
        oldModule('convex/model/activity.ts'),
      ])
      compared = { snapshot: oldSnapshot.forMe, activity: oldActivity.logActivity }
    }
    const results = await harness.benchmarkBackend({ ...options, ...compared })
    console.log(
      baseline === null
        ? `Working tree only; Node ${process.version}; convex-test, no deployment or network.`
        : `Baseline ${baseline.commit.slice(0, 12)} (${baseline.chosen}); Node ${process.version}; convex-test, no deployment or network.`,
    )
    console.log(
      'Timings include the in-memory emulator; query/document counts are transaction metrics.',
    )
    console.table(results)
  } finally {
    await server?.close()
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2))
  // A baseline from before per-task activity retention schedules a trim
  // minutes ahead on a real timer, which would keep the process alive and then
  // fail against the closed Vite runner.
  // process.exit drops output still queued for a pipe, so that goes out first.
  await Promise.all(
    [process.stdout, process.stderr].map((stream) => new Promise((done) => stream.write('', done))),
  )
  process.exit()
}
