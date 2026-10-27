/* The agent instruction files that this public repository must never track.
 * The maintainers' instructions are private, and a Git hook copies them into
 * each maintainer checkout as an ignored AGENTS.md. .gitignore does not stop
 * `git add -f`, or a merge that keeps an older branch's AGENTS.md, from
 * tracking the file again. */
import { gitIn } from './git.mjs'

/** AGENTS.md is the maintainers' private copy. A CLAUDE.md would stop Claude
 * Code from reading it. */
export const agentFiles = ['AGENTS.md', 'CLAUDE.md']

/** Resolves the agent instruction files that the checkout at `cwd` tracks at its root. */
export async function trackedAgentFiles(cwd) {
  const output = await gitIn(cwd, [
    'ls-files',
    '--full-name',
    '--',
    ...agentFiles.map((name) => `:(top,literal)${name}`),
  ])
  return output ? output.split('\n') : []
}
