#!/usr/bin/env node
/* Configure each branch backend before pushing functions. Stable staging and
 * production already have their own explicit origins and environment identity.
 * No deployment path seeds users or resets workspace data. */
import { execFileSync } from 'node:child_process'
import { writeDeploymentReceipt } from './deployment-receipt.mjs'

/* The CLI takes its preview branch iff the deploy key is a preview key —
 * VERCEL_ENV is not what decides it — so this mirrors convex's own test
 * (isPreviewDeployKey) rather than guessing from the environment. */
export function isPreviewDeployKey(key) {
  if (typeof key !== 'string') return false
  const [prefix, ...rest] = key.split('|')
  if (rest.length === 0) return false
  const parts = prefix.split(':')
  return parts[0] === 'preview' && parts.length === 3
}

/* Which deployment to write to, named exactly. `--cmd` inherits the
 * PROJECT-scoped preview deploy key, never the claimed deployment's admin
 * key, so `convex env set` has to name its target — and convex has already
 * told us which one it claimed, in the canonical cloud URL it injected. A
 * deployment name is that URL's first label; this is the shape the CLI itself
 * matches. Reading it here beats reconstructing the branch slug: the name is
 * the deployment's own identity, with no guess about how Vercel spelled the
 * branch. Returns null when the URL is not one we recognise, so the caller
 * fails the build instead of passing nonsense to --deployment. */
export function deploymentName(env) {
  const url = env.VITE_CONVEX_URL
  if (typeof url !== 'string') return null
  const m = url.match(/^https:\/\/([a-z]+-[a-z]+-[0-9]+)\.(?:[^.]+\.)?convex\.cloud\/?$/)
  return m ? m[1] : null
}

/* The preview deployment is claimed per BRANCH, and Vercel's branch alias is
 * the matching per-branch host — one origin, one backend, stable across every
 * redeploy of the branch. VERCEL_URL is per-deployment and would be rewritten
 * by the next push, so it is only the fallback for a build with no git branch
 * behind it. Both are hosts, not URLs; Vercel serves previews over https. */
export function previewSiteUrl(env) {
  const host = env.VERCEL_BRANCH_URL || env.VERCEL_URL
  if (!host) {
    throw new Error(
      'vercel-build: preview deploy with neither VERCEL_BRANCH_URL nor VERCEL_URL — ' +
        'cannot tell the preview backend which origin to trust',
    )
  }
  if (host.includes('://')) {
    throw new Error(`vercel-build: expected a bare host, got "${host}"`)
  }
  return `https://${host}`
}

/* The CLI does not always REFUSE a target it will not honour — with a
 * deployment-scoped key it warns and carries on against the key's own
 * deployment. A preview key cannot reach that branch, but reading the warning
 * costs nothing and turns "wrote SITE_URL somewhere else" into a failed build
 * instead of a silently broken preview. */
export function ignoredTheTarget(output) {
  return /Ignoring `--prod`, `--preview-name`, or `--deployment-name` flags/.test(output)
}

function setPreviewSiteUrl(env) {
  const siteUrl = previewSiteUrl(env)
  const name = deploymentName(env)
  if (name === null) {
    throw new Error(
      `vercel-build: cannot read a deployment name out of VITE_CONVEX_URL ` +
        `("${env.VITE_CONVEX_URL ?? ''}") — refusing to ship a preview whose backend ` +
        `trusts the wrong origin`,
    )
  }
  console.log(`[vercel-build] SITE_URL ${siteUrl} → deployment ${name}`)
  /* execFile, never a shell: the origin and the deployment name are derived
     from build-time input and go straight into argv here. Output is captured
     rather than inherited so the ignore-warning can be read, then re-printed
     so the build log still shows everything. */
  const out = execFileSync(
    'npx',
    ['convex', 'env', 'set', 'SITE_URL', siteUrl, '--deployment', name],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  process.stdout.write(out)
  if (ignoredTheTarget(out)) {
    throw new Error(
      `vercel-build: convex ignored --deployment ${name} and wrote SITE_URL somewhere else`,
    )
  }
}

function main(env) {
  if (isPreviewDeployKey(env.CONVEX_DEPLOY_KEY)) {
    if (env.QIVO_ENVIRONMENT !== 'preview')
      throw new Error('Preview environment identity required.')
    setPreviewSiteUrl(env)
    execFileSync(
      'npx',
      ['convex', 'env', 'set', 'QIVO_ENVIRONMENT', 'preview', '--deployment', deploymentName(env)],
      { stdio: 'inherit' },
    )
  } else {
    if (deploymentName(env) !== env.QIVO_CONVEX_DEPLOYMENT)
      throw new Error('The injected Convex URL does not match the configured backend.')
    for (const [name, expected] of [
      ['QIVO_ENVIRONMENT', env.QIVO_ENVIRONMENT],
      ['SITE_URL', env.QIVO_APP_ORIGIN],
    ]) {
      const actual = execFileSync('npx', ['convex', 'env', 'get', name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
      if (!expected || actual !== expected)
        throw new Error(`Backend ${name} does not match the build.`)
    }
  }
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' })
  writeDeploymentReceipt(env)
}

// import for the tests, run only as the build command
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.env)
}
