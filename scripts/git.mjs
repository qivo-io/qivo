/* Runs git in the checkout that its working directory names. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/* The variables that make git answer for another repository, tree or index
 * than the checkout at its working directory, as `git rev-parse
 * --local-env-vars` lists them (git 2.53). Git clears the same ones when it
 * moves into another repository, such as a submodule. A Git hook exports
 * GIT_DIR, and a caller can set any of them. */
const repositoryVariables = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
])

/**
 * Returns the caller's environment without the variables that select another
 * repository. The user's own config, such as GIT_CONFIG_GLOBAL or
 * GIT_CONFIG_NOSYSTEM, stays, so git reads the config the user's git reads.
 */
export function checkoutEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !repositoryVariables.has(name)))
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
