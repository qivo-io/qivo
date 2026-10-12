#!/usr/bin/env node
/* The quick check for docs/guide. It runs the validation that
 * website/scripts/build.mjs applies before it publishes qivo.io/docs/, without
 * building anything, and reports every problem by file. The rules live in
 * website/site/docs.mjs and are described in docs/documentation.md.
 */
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectDocs } from '../website/site/docs.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))

/** Returns every documentation problem in a checkout; an empty array means the guide is publishable. */
export function checkDocs(root = projectRoot) {
  return inspectDocs({ contentDir: join(root, 'docs/guide'), publicDir: join(root, 'public') })
    .errors
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkDocs()
  if (errors.length) {
    console.error(`[docs] Documentation errors:\n${errors.map((e) => `  ${e}`).join('\n')}`)
    process.exitCode = 1
  } else console.log('[docs] docs/guide and agent-guide documentation links are valid')
}
