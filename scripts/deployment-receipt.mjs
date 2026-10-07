import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Add nonsecret source identity to the uncached client version manifest. */
export function writeDeploymentReceipt(env, directory = 'dist') {
  if (!/^[0-9a-f]{40}$/.test(env.VERCEL_GIT_COMMIT_SHA || ''))
    throw new Error('Hosted builds require an exact Git commit identity.')
  if (!['production', 'staging', 'preview', 'demo'].includes(env.QIVO_ENVIRONMENT))
    throw new Error('Hosted builds require an explicit environment identity.')
  const file = join(directory, 'version.json')
  const version = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(
    file,
    JSON.stringify({
      ...version,
      commit: env.VERCEL_GIT_COMMIT_SHA,
      environment: env.QIVO_ENVIRONMENT,
    }),
  )
}
