#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { pushThenProbe } from './auth-probe.mjs'
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

/** Checks the target, then pushes the backend with vercel-build.mjs as the
 * build command, which refuses a production backend without its mail
 * settings, and then calls the deployment's sign-in, OAuth token and
 * metadata routes (auth-probe.mjs), failing the Vercel build when one does
 * not answer as expected. Deployment never creates users, seeds data or
 * resets a workspace. A refused target throws before anything runs; the
 * rest settles the promise this returns. `run` is execFileSync, and
 * `check` (probe, fetch, sleep, log) reaches the probe; the tests pass
 * their own. */
export function deploy(env, run = execFileSync, check = {}) {
  assertAppTarget(env)
  return pushThenProbe(env, { run, command: 'node scripts/vercel-build.mjs', ...check })
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  /* the probe's requests go through HTTPS_PROXY or HTTP_PROXY when one is
     set, as vercel-build.mjs's do. Node 24.14 added this. */
  http.setGlobalProxyFromEnv?.()
  await deploy(process.env)
}
