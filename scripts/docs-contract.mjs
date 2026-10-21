#!/usr/bin/env node
/* The quick check for docs/guide. It runs the documentation checks that
 * website/scripts/build.mjs applies before it publishes qivo.io/docs/, without
 * building anything, and reports every problem by file. The rules live in
 * website/site/docs.mjs and are described in docs/documentation.md. It also
 * fails while a limits table in the docs differs from the registry
 * (scripts/limits-docs.mjs). The build also rejects rendered pages that load
 * third-party resources or contain text that looks like a credential.
 */
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectDocs } from '../website/site/docs.mjs'
import { limitsDocsErrors } from './limits-docs.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))

/** Returns every documentation problem in a checkout, a limits table that
 * differs from convex/lib/limits.ts included; an empty array means the guide
 * is publishable. */
export function checkDocs(root = projectRoot) {
  return [
    ...inspectDocs({ contentDir: join(root, 'docs/guide'), publicDir: join(root, 'public') })
      .errors,
    ...limitsDocsErrors(root),
  ]
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkDocs()
  if (errors.length) {
    console.error(`[docs] Documentation errors:\n${errors.map((e) => `  ${e}`).join('\n')}`)
    process.exitCode = 1
  } else console.log('[docs] docs/guide and agent-guide documentation links are valid')
}
