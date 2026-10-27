/* Compares the packages installed under a directory with its lockfile. An
 * install left from another lockfile, as after a pull or a branch switch
 * without `npm ci`, runs builds and tests against other versions than CI
 * installs. `scripts/check-dependencies.mjs` is the command that runs the
 * check; this module has no side effects, so tests can import it. */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'

/**
 * Lists how the packages installed under `directory` of `root` differ from
 * its `package-lock.json`: each locked package that is not installed, each
 * one installed at another version and each installed package the lockfile
 * does not name, such as a nested copy left from an older lockfile, which
 * would shadow the hoisted one. Names each by its path from `root`. A
 * missing optional package passes, because npm installs only the native
 * builds that fit the platform. Throws, naming the file, for a lockfile
 * that is not JSON or has no `packages` map, so the check cannot pass on a
 * file it does not read.
 */
export function dependencyDrift(root, directory = '.') {
  const lockfilePath = posix.join(directory, 'package-lock.json')
  const lockfile = readJson(root, lockfilePath)
  if (lockfile === undefined) throw new Error(`${lockfilePath} is not valid JSON.`)
  if (!lockfile.packages)
    throw new Error(`${lockfilePath} has no packages map (lockfileVersion 2 or 3).`)
  const problems = []
  for (const [path, locked] of Object.entries(lockfile.packages)) {
    // The empty path is the project itself.
    if (!path) continue
    // Lockfile paths use `/` on every platform.
    const name = posix.join(directory, path)
    const manifest = posix.join(name, 'package.json')
    if (!existsSync(join(root, manifest))) {
      if (!locked.optional) problems.push(`${name} is not installed (locked ${locked.version})`)
      continue
    }
    const installed = readJson(root, manifest)
    if (installed === undefined) problems.push(`${manifest} is not valid JSON`)
    else if (installed.version !== locked.version)
      problems.push(`${name} is ${installed.version}, but the lockfile has ${locked.version}`)
  }
  for (const path of installedPackages(join(root, directory)))
    if (!(path in lockfile.packages))
      problems.push(
        `${posix.join(directory, path)} is installed, but the lockfile does not name it`,
      )
  return problems
}

/** The parsed JSON file at `path` from `root`, or undefined if it is not JSON. */
function readJson(root, path) {
  try {
    return JSON.parse(readFileSync(join(root, path), 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

/**
 * The lockfile path of every folder under `project`'s node_modules, nested
 * ones too, that holds a package.json, in sorted order. Skips dot entries
 * such as `.bin` and npm's hidden lockfile, and does not follow a linked
 * package into its own folder.
 */
function installedPackages(project) {
  const paths = []
  const walk = (parent) => {
    const folder = join(project, parent)
    if (!existsSync(folder)) return
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const packages = entry.name.startsWith('@')
        ? readdirSync(join(folder, entry.name), { withFileTypes: true }).map((scoped) => ({
            path: `${parent}/${entry.name}/${scoped.name}`,
            link: scoped.isSymbolicLink(),
          }))
        : [{ path: `${parent}/${entry.name}`, link: entry.isSymbolicLink() }]
      for (const { path, link } of packages) {
        if (existsSync(join(project, path, 'package.json'))) paths.push(path)
        if (!link) walk(`${path}/node_modules`)
      }
    }
  }
  walk('node_modules')
  return paths.sort()
}
