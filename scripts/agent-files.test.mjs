import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { trackedAgentFiles } from './agent-files.mjs'
import { checkoutEnvironment } from './git.mjs'

let directory = ''
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})

/** Makes a repository that commits `tracked` and also holds the ignored `AGENTS.md`. */
function repository(tracked) {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-files-'))
  const env = {
    ...checkoutEnvironment(),
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: directory,
      env,
    })
  git('init', '-q')
  fs.writeFileSync(path.join(directory, '.gitignore'), '/AGENTS.md\n')
  fs.writeFileSync(path.join(directory, 'AGENTS.md'), 'private copy\n')
  fs.mkdirSync(path.join(directory, 'docs'))
  for (const file of tracked) fs.writeFileSync(path.join(directory, file), 'tracked\n')
  git('add', '-f', '.gitignore', ...tracked)
  git('commit', '-q', '--allow-empty', '-m', 'files')
  return directory
}

describe('tracked agent instruction files', () => {
  it('finds none when the private copy is only ignored', async () => {
    expect(await trackedAgentFiles(repository(['docs/AGENTS.md']))).toEqual([])
  })

  it('finds a tracked AGENTS.md or CLAUDE.md at the root, also from a subdirectory', async () => {
    const root = repository(['AGENTS.md', 'CLAUDE.md'])
    expect(await trackedAgentFiles(root)).toEqual(['AGENTS.md', 'CLAUDE.md'])
    expect(await trackedAgentFiles(path.join(root, 'docs'))).toEqual(['AGENTS.md', 'CLAUDE.md'])
  })
})
