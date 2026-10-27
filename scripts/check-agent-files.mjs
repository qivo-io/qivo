#!/usr/bin/env node
/* Fails when this checkout tracks AGENTS.md or CLAUDE.md at its root, because
 * the maintainers' agent instructions must stay out of this public repository
 * (agent-files.mjs). CI's quality job and verify:static run it. It checks
 * whenever it runs, with no test for being the entry module, so no way of
 * starting it can skip the check. */
import { trackedAgentFiles } from './agent-files.mjs'

const tracked = await trackedAgentFiles(process.cwd())
if (tracked.length === 0) console.log('No agent instruction file is tracked.')
else {
  console.error(
    `${tracked.join(' and ')} must not be tracked, because the maintainers' agent instructions are private. ` +
      `Remove it from Git with \`git rm --cached ${tracked.join(' ')}\`.`,
  )
  process.exit(1)
}
