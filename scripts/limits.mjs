/* The limits registry (convex/lib/limits.ts) for Node scripts.
 *
 * Node loads a TypeScript file only from the version package.json `engines`
 * names, and only in a build that strips types. A static import of a .ts file
 * fails while Node links the modules, before any line of the script runs,
 * with ERR_UNKNOWN_FILE_EXTENSION and no word of the version. So scripts
 * import the registry from here: this module checks the Node first and then
 * loads the registry with a dynamic import, and an older Node stops with a
 * sentence that names the version to use. */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

/** Why this Node cannot run Qivo's scripts, or null when it can. `script`
 * names the script started. */
export function nodeProblem(
  script,
  version = process.version,
  typescript = process.features.typescript,
) {
  const { engines } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const needed = Number(/\d+/.exec(engines.node)?.[0])
  const major = Number(/\d+/.exec(version)?.[0])
  if (major < needed)
    return `${script} needs Node ${needed} (package.json engines). This is Node ${version}. Switch to Node ${needed} and run it again.`
  if (!typescript)
    return `${script} needs Node ${needed} with TypeScript support. This Node ${version} cannot load TypeScript files. Use the official Node ${needed} build from nodejs.org, without --no-experimental-strip-types, and run it again.`
  return null
}

const problem = nodeProblem(process.argv[1] ? basename(process.argv[1]) : 'This script')
if (problem) {
  console.error(problem)
  process.exit(1)
}

export const { DEFAULT_PAGE_SIZE, grouped, LIMIT_GROUPS, LIMITS, MIB } = await import(
  '../convex/lib/limits.ts'
)
