#!/usr/bin/env node
/* The Vercel build, one level in from vercel.json's buildCommand:
 *
 *   npx convex deploy --cmd 'node scripts/vercel-build.mjs' --preview-run '…'
 *
 * Both production and previews run `npm run build`, including its check that
 * the three public agent guides are present in the deployment output root.
 * On a PREVIEW it first
 * gives the freshly claimed Convex preview deployment the one value nothing
 * else can know: the Vercel origin the browser will actually load.
 *
 * Why here, and not in the Convex dashboard's preview defaults. A default is
 * a constant, and the app origin is not — it is minted by Vercel per branch.
 * `convex deploy` runs its `--cmd` in the single window where that can be
 * fixed: the preview deployment has been claimed (so it can be addressed by
 * name) but the functions have not been pushed and `--preview-run` has not
 * seeded yet, so nothing has read SITE_URL. The order inside convex 1.45.0's
 * deployToNewPreviewDeployment is claim → --cmd → push → --preview-run.
 *
 * SITE_URL is load-bearing on four paths, which is why a placeholder like
 * https://preview.invalid satisfies the seed guard and still leaves the
 * deployment unusable: Better Auth's trustedOrigins and the crossDomain
 * plugin's return leg (convex/auth.ts), the CORS origin echo on the file
 * gateway (convex/http.ts), the password-reset redirect (convex/adminAuth.ts),
 * and the refuse-production marker (convex/lib/deployment.ts).
 *
 * The client half needs nothing from us: `convex deploy --cmd` already runs
 * the build with VITE_CONVEX_URL and VITE_CONVEX_SITE_URL set to the target
 * deployment's canonical URLs, and Vite's loadEnv lets process.env outrank
 * any .env file, so the preview bundle points at the preview backend.
 */
import { execFileSync } from 'node:child_process'

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
  if (isPreviewDeployKey(env.CONVEX_DEPLOY_KEY)) setPreviewSiteUrl(env)
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' })
}

// import for the tests, run only as the build command
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.env)
}
