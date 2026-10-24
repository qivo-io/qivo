#!/usr/bin/env node
/* Fails when this Node is older than the minimum package.json `engines`
 * names, or outside its major. Every workflow job runs it after setup-node,
 * so a runner with an older Node 24 stops the job instead of building or
 * deploying with it. setup-node's `check-latest` picks the newest Node 24 on
 * each run, so the minimum moves only when a security release must be the
 * floor. With `--warn` it reports the same problem and exits 0: the Vercel
 * build command runs it that way, because Vercel picks the patch itself and
 * a failure would stop every deploy until Vercel rolls out a newer one.
 *
 * It checks whenever it runs, with no test for being the entry module, so
 * no way of starting it can skip the check. Import `node-engines.mjs` for the
 * logic instead. */
import { readFileSync } from 'node:fs'
import { nodeVersionProblem } from './node-engines.mjs'

const { engines } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const problem = nodeVersionProblem(process.version, engines.node)
if (!problem)
  console.log(`Node ${process.version} satisfies package.json engines.node ${engines.node}.`)
else if (process.argv.includes('--warn')) console.warn(`Warning: ${problem}`)
else {
  console.error(problem)
  process.exit(1)
}
