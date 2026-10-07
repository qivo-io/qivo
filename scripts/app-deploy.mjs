#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { isPreviewDeployKey } from './vercel-build.mjs'

/** Refuse ambiguous credentials before the CLI can write to a backend. */
export function assertAppTarget(env) {
  const key = env.CONVEX_DEPLOY_KEY || ''
  const parts = key.split('|')
  if (parts.length !== 2 || !parts[1] || /\s/.test(key))
    throw new Error('A valid scoped Convex deployment key is required.')
  if (isPreviewDeployKey(key)) {
    if (env.QIVO_ENVIRONMENT !== 'preview')
      throw new Error('Preview keys require QIVO_ENVIRONMENT=preview.')
    return
  }
  if (!['production', 'staging'].includes(env.QIVO_ENVIRONMENT))
    throw new Error('Stable deployments require an explicit production or staging environment.')
  if (!env.QIVO_CONVEX_DEPLOYMENT || parts[0] !== `prod:${env.QIVO_CONVEX_DEPLOYMENT}`)
    throw new Error('The deployment key does not match QIVO_CONVEX_DEPLOYMENT.')
  const origin = env.QIVO_APP_ORIGIN
  if (!origin?.startsWith('https://') || new URL(origin).origin !== origin)
    throw new Error('QIVO_APP_ORIGIN must be an exact HTTPS origin.')
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  assertAppTarget(process.env)
  // Deployment never creates users, seeds data or resets a workspace.
  execFileSync('npx', ['convex', 'deploy', '--cmd', 'node scripts/vercel-build.mjs'], {
    stdio: 'inherit',
  })
}
