/* Compares the packages installed under a directory with its lockfile. An
 * install left from another lockfile, as after a pull or a branch switch
 * without `npm ci`, runs builds and tests against other versions than CI
 * installs. `scripts/check-dependencies.mjs` is the command that runs the
 * check; this module has no side effects, so tests can import it. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Lists how the packages installed under `directory` of `root` differ from
 * its `package-lock.json`: each locked package that is not installed and each
 * one installed at another version, named by its path from `root`. A missing
 * optional package passes, because npm installs only the native builds that
 * fit the platform. Throws for a lockfile without a `packages` map, so the
 * check cannot pass on a format it does not read.
 */
export function dependencyDrift(root, directory = '.') {
  const lockfilePath = join(directory, 'package-lock.json')
  const lockfile = JSON.parse(readFileSync(join(root, lockfilePath), 'utf8'))
  if (!lockfile.packages)
    throw new Error(`${lockfilePath} has no packages map (lockfileVersion 2 or 3).`)
  const problems = []
  for (const [path, locked] of Object.entries(lockfile.packages)) {
    // The empty path is the project itself.
    if (!path) continue
    const name = join(directory, path)
    const manifest = join(root, name, 'package.json')
    if (!existsSync(manifest)) {
      if (!locked.optional) problems.push(`${name} is not installed (locked ${locked.version})`)
      continue
    }
    const { version } = JSON.parse(readFileSync(manifest, 'utf8'))
    if (version !== locked.version)
      problems.push(`${name} is ${version}, but the lockfile has ${locked.version}`)
  }
  return problems
}
