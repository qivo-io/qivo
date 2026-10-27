#!/usr/bin/env node
/* Fails when node_modules/ or desktop/node_modules/ holds other packages than
 * package-lock.json and desktop/package-lock.json name, so that no build, test
 * or timing runs against an install that CI would not make. Run it after
 * installing. It stays apart from node-version.mjs, which every workflow job
 * runs before its install. The logic is in dependency-drift.mjs. */
import { fileURLToPath } from 'node:url'
import { dependencyDrift } from './dependency-drift.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const problems = ['.', 'desktop'].flatMap((directory) => dependencyDrift(root, directory))
const shown = 20
if (problems.length) {
  console.error(problems.slice(0, shown).join('\n'))
  if (problems.length > shown) console.error(`...and ${problems.length - shown} more.`)
  console.error(
    '\nThe installed dependencies do not match the lockfiles. Run `npm ci` and `npm run desktop:install`.',
  )
  process.exit(1)
}
console.log('The installed dependencies match package-lock.json and desktop/package-lock.json.')
