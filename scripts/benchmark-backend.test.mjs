import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { BaselineError, resolveBaseline } from './benchmark-backend.mjs'

/** A git double. `answers` maps a joined command to its output, and any
    other command fails as git does. It records the commands it ran. */
function fakeGit(answers) {
  const ran = []
  const git = async (args) => {
    const command = args.join(' ')
    ran.push(command)
    if (command in answers) return answers[command]
    throw new Error(`git ${command} failed`)
  }
  return { git, ran }
}

describe('the backend benchmark baseline', () => {
  it('uses the named revision, skipping flags, once it resolves to a commit', async () => {
    const { git } = fakeGit({ 'rev-parse --verify --quiet v0.1.5^{commit}': 'e758e51' })
    await expect(resolveBaseline(['--guards-only', 'v0.1.5'], git)).resolves.toEqual({
      commit: 'e758e51',
      chosen: 'v0.1.5',
    })
  })

  it('refuses a named revision that is not a commit here, without trying another', async () => {
    const { git, ran } = fakeGit({ 'merge-base HEAD origin/main': 'a387612' })
    const refused = resolveBaseline(['no-such-revision'], git)
    await expect(refused).rejects.toThrow(BaselineError)
    await expect(refused).rejects.toThrow(
      'The baseline revision "no-such-revision" is not a commit in this checkout.',
    )
    expect(ran).toEqual(['rev-parse --verify --quiet no-such-revision^{commit}'])
  })

  it('defaults to the merge base of HEAD and origin/main', async () => {
    const { git } = fakeGit({ 'merge-base HEAD origin/main': 'a387612' })
    await expect(resolveBaseline(['--guards-only'], git)).resolves.toEqual({
      commit: 'a387612',
      chosen: 'merge base of HEAD and origin/main',
    })
  })

  it('falls back to HEAD in a checkout without origin/main', async () => {
    const { git } = fakeGit({ 'rev-parse --verify --quiet HEAD^{commit}': '31e3096' })
    await expect(resolveBaseline([], git)).resolves.toEqual({
      commit: '31e3096',
      chosen: 'HEAD, since there is no origin/main',
    })
  })

  it('asks for a revision when origin/main shares no history with HEAD', async () => {
    // a shallow clone: origin/main resolves, but git finds no merge base
    const { git } = fakeGit({
      'rev-parse --verify --quiet origin/main^{commit}': 'a387612',
      'rev-parse --verify --quiet HEAD^{commit}': '31e3096',
    })
    await expect(resolveBaseline([], git)).rejects.toThrow(
      'HEAD shares no history with origin/main in this checkout',
    )
  })

  it('resolves commits, and refuses what is not one, with real git', async () => {
    const head = (await promisify(execFile)('git', ['rev-parse', 'HEAD'])).stdout.trim()
    await expect(resolveBaseline(['HEAD'])).resolves.toEqual({ commit: head, chosen: 'HEAD' })
    for (const other of ['HEAD^{tree}', 'HEAD:package.json', '0'.repeat(40)])
      await expect(resolveBaseline([other])).rejects.toThrow('is not a commit in this checkout')
  })
})
