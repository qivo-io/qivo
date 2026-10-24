#!/usr/bin/env node
/* Fails when this Node is older than the minimum package.json `engines`
 * names, or outside its major. Every workflow job runs it after setup-node,
 * so a runner with an older Node 24 stops the job instead of building or
 * deploying with it. setup-node's `check-latest` picks the newest Node 24 on
 * each run, so the minimum moves only when a security release must be the
 * floor. With `--warn` it reports the same problem and exits 0: the Vercel
 * build command runs it that way, because Vercel picks the patch itself and
 * a failure would stop every deploy until Vercel rolls out a newer one. */
import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const RANGE = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/

/** The [major, minor, patch] floor of an engines range such as
 * `>=24.22.1 <25`. Throws for any other form, so the check cannot pass on a
 * range it does not understand. */
export function minimumNode(engines) {
  const match = RANGE.exec(engines ?? '')
  const [major, minor, patch, below] = (match?.slice(1) ?? []).map(Number)
  if (!match || below !== major + 1)
    throw new Error(
      `package.json engines.node must read ">=MAJOR.MINOR.PATCH <MAJOR+1", not ${JSON.stringify(engines)}.`,
    )
  return [major, minor, patch]
}

/** Why `version` (such as `v24.21.0`) does not satisfy `engines`, or null
 * when it does. */
export function nodeVersionProblem(version, engines) {
  const minimum = minimumNode(engines)
  const parts = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number)
  const order = parts && (parts[0] - minimum[0] || parts[1] - minimum[1] || parts[2] - minimum[2])
  if (parts && parts[0] === minimum[0] && order >= 0) return null
  return `Node ${version} does not satisfy package.json engines.node ${engines}. Use Node ${minimum.join('.')} or a later ${minimum[0]}.x release.`
}

// import.meta.main arrived in Node 24.2. On an older Node the fallback
// resolves the entry the way Node does, so a Windows path, a space or a
// symlink cannot make a direct run skip the check.
const isMain =
  import.meta.main ??
  (process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)

if (isMain) {
  const { engines } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const problem = nodeVersionProblem(process.version, engines.node)
  if (!problem)
    console.log(`Node ${process.version} satisfies package.json engines.node ${engines.node}.`)
  else if (process.argv.includes('--warn')) console.warn(`Warning: ${problem}`)
  else {
    console.error(problem)
    process.exit(1)
  }
}
