import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkoutEnvironment, gitIn } from './git.mjs'

let directory = ''
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(directory, { recursive: true, force: true })
})

/** Makes a repository with one commit in a new folder and returns its path and commit. */
function repository(name) {
  const root = path.join(directory, name)
  fs.mkdirSync(root)
  const env = {
    ...checkoutEnvironment(),
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
    }).trim()
  git('init', '-q')
  git('commit', '-q', '--allow-empty', '-m', name)
  return { root, commit: git('rev-parse', 'HEAD') }
}

describe('git in a checkout', () => {
  it('drops the variables that select another repository and keeps the config ones', () => {
    expect(
      checkoutEnvironment({
        GIT_DIR: '/x/.git',
        GIT_WORK_TREE: '/x',
        GIT_INDEX_FILE: '/x/index',
        GIT_COMMON_DIR: '/x/.git',
        GIT_OBJECT_DIRECTORY: '/x/objects',
        GIT_CONFIG_GLOBAL: '/home/u/.gitconfig',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CEILING_DIRECTORIES: '/home',
        PATH: '/bin',
      }),
    ).toEqual({
      GIT_CONFIG_GLOBAL: '/home/u/.gitconfig',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CEILING_DIRECTORIES: '/home',
      PATH: '/bin',
    })
  })

  it('answers for the checkout at its working directory when GIT_DIR names another', async () => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qivo-git-')))
    const checkout = repository('checkout')
    const other = repository('other')
    vi.stubEnv('GIT_DIR', path.join(other.root, '.git'))
    vi.stubEnv('GIT_WORK_TREE', other.root)
    expect(await gitIn(checkout.root, ['rev-parse', 'HEAD'])).toBe(checkout.commit)
    expect(await gitIn(checkout.root, ['rev-parse', '--show-toplevel'])).toBe(checkout.root)
  })
})
