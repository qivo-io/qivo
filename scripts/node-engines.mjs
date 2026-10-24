/* Reads the Node range package.json `engines` names and judges a Node
 * version against it. `scripts/node-version.mjs` is the command that runs
 * the check; this module has no side effects, so tests can import it. */

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
