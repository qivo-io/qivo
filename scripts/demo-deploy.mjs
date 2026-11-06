#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { pushThenProbe } from './auth-probe.mjs'
import { isPreviewDeployKey } from './vercel-build.mjs'

export function assertDemoTarget(env) {
  if (env.VITE_APP_MODE !== 'demo') throw new Error('The demo project requires VITE_APP_MODE=demo.')
  const key = env.CONVEX_DEPLOY_KEY || ''
  const parts = key.split('|')
  if (parts.length !== 2 || !parts[1] || /\s/.test(key))
    throw new Error('A valid dedicated demo deploy key is required.')
  const prefix = parts[0]
  if (isPreviewDeployKey(key)) {
    if (env.QIVO_ENVIRONMENT !== 'preview')
      throw new Error('Demo previews require QIVO_ENVIRONMENT=preview.')
    const expected = env.DEMO_CONVEX_PROJECT
    if (!expected || prefix !== `preview:${expected}`)
      throw new Error(
        'The preview key must belong to the configured DEMO_CONVEX_PROJECT (team:project).',
      )
  } else {
    if (env.QIVO_ENVIRONMENT !== 'demo')
      throw new Error('The public demo requires QIVO_ENVIRONMENT=demo.')
    if (
      !env.DEMO_CONVEX_DEPLOYMENT ||
      prefix !== `prod:${env.DEMO_CONVEX_DEPLOYMENT}` ||
      !key.includes('|')
    )
      throw new Error('Use the dedicated production key matching DEMO_CONVEX_DEPLOYMENT.')
  }
}

/** Checks the target, then pushes the dedicated demo backend with
 * demo-build.mjs as the build command, and then calls the deployment's
 * sign-in route (auth-probe.mjs), failing the Vercel build when it does not
 * answer as expected. The demo serves no OAuth routes, so the probe calls
 * only that one. Intentionally no shared --preview-run seed: anonymous
 * provisioning is the only way a demo organization is created on these
 * deployments. A refused target throws before anything runs; the rest
 * settles the promise this returns. `run` is execFileSync, and `check`
 * (probe, fetch, sleep, log) reaches the probe; the tests pass their own. */
export function deploy(env, run = execFileSync, check = {}) {
  assertDemoTarget(env)
  return pushThenProbe(env, { run, command: 'node scripts/demo-build.mjs', demo: true, ...check })
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  /* the probe's requests go through HTTPS_PROXY or HTTP_PROXY when one is
     set, as vercel-build.mjs's do. Node 24.14 added this. */
  http.setGlobalProxyFromEnv?.()
  await deploy(process.env)
}
