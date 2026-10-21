/* The site the live contract pass calls. CONVEX_DEPLOY_KEY chooses the
 * deployment that the reset and every `npx convex run` reach, so the suites
 * must call that deployment's convex.site and nothing else. Hermetic tests in
 * tests/contractSite.test.ts. */

const DEV_KEY = /^dev:([a-z][a-z0-9-]*-[0-9]+)\|[^|\s]+$/
const SITE_LINE = /^VITE_CONVEX_SITE_URL=(\S+)\s*$/m

/**
 * The development deployment CONVEX_DEPLOY_KEY names. Throws when the key is
 * missing or not a development key, without repeating it.
 */
export function contractDeployment(env: Record<string, string | undefined>): string {
  const deployment = DEV_KEY.exec(env.CONVEX_DEPLOY_KEY ?? '')?.[1]
  if (deployment === undefined)
    throw new Error(
      'contract setup: run the pass under the private with-dev helper, which sets a development CONVEX_DEPLOY_KEY',
    )
  return deployment
}

/**
 * The convex.site origin of the development deployment CONVEX_DEPLOY_KEY names.
 * Takes CONTRACT_BASE_URL when it is set, else an exported
 * VITE_CONVEX_SITE_URL, else the one in .env.local, and checks whichever it
 * takes. Throws when the key is missing or not a development key, or when the
 * site belongs to another deployment. Messages never repeat the key.
 */
export function contractSiteUrl(
  env: Record<string, string | undefined>,
  envLocal: string | undefined,
): string {
  const deployment = contractDeployment(env)
  const raw = env.CONTRACT_BASE_URL || env.VITE_CONVEX_SITE_URL || envLocal?.match(SITE_LINE)?.[1]
  if (!raw)
    throw new Error('contract setup: VITE_CONVEX_SITE_URL is neither exported nor in .env.local')
  const site = URL.canParse(raw) ? new URL(raw) : undefined
  const [label, ...rest] = site?.hostname.split('.') ?? []
  if (
    site === undefined ||
    site.protocol !== 'https:' ||
    site.origin !== raw.replace(/\/$/, '') ||
    label !== deployment ||
    rest.at(-2) !== 'convex' ||
    rest.at(-1) !== 'site'
  )
    throw new Error(
      `contract setup: ${raw} is not the convex.site of ${deployment}, the deployment the key reaches`,
    )
  return site.origin
}
