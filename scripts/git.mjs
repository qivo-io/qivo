/* Runs git in the checkout that its working directory names. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Returns the caller's environment without its GIT_ variables. A Git hook
 * exports GIT_DIR, and a caller can set GIT_DIR, GIT_WORK_TREE or
 * GIT_INDEX_FILE, each of which makes git answer for another repository,
 * tree or index than the checkout at its working directory.
 */
export function checkoutEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_')))
}

/**
 * Runs git in the checkout at `cwd` and resolves its trimmed output. A
 * failure carries git's exit status as `code`, or a string such as ENOENT
 * when git could not run.
 */
export async function gitIn(cwd, args) {
  const { stdout } = await promisify(execFile)('git', args, {
    cwd,
    encoding: 'utf8',
    env: checkoutEnvironment(),
  })
  return stdout.trim()
}
