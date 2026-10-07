#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
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

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  assertDemoTarget(process.env)
  // Intentionally no shared --preview-run seed. Anonymous provisioning is
  // the only way a demo organization is created on these deployments.
  execFileSync('npx', ['convex', 'deploy', '--cmd', 'node scripts/demo-build.mjs'], {
    stdio: 'inherit',
  })
}
