/** The page a packaged build always loads. */
export const productionAppURL = 'https://qivo.io/app'

/** The page a run from source loads without QIVO_DESKTOP_URL: `npm run desktop:dev`'s Vite server. */
const developmentAppURL = 'http://localhost:5199/app'

const trustedHosts = new Set(['qivo.io', 'www.qivo.io', 'localhost'])
const trustedSuffixes = ['.qivo.io']

function isTrustedHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return trustedHosts.has(host) || trustedSuffixes.some((suffix) => host.endsWith(suffix))
}

/**
 * Chooses the page the window loads, whose origin the shell trusts with its
 * IPC and permissions. A packaged build always loads production and ignores
 * the environment, so no setting can make a local page the trusted origin.
 * A run from source loads `QIVO_DESKTOP_URL`, or the local Vite server, and
 * throws for anything but a Qivo HTTPS origin or localhost over HTTP.
 */
export function resolveAppURL(packaged: boolean, env: NodeJS.ProcessEnv): URL {
  if (packaged) return new URL(productionAppURL)
  const appURL = new URL(env.QIVO_DESKTOP_URL?.trim() || developmentAppURL)
  if (!['http:', 'https:'].includes(appURL.protocol)) {
    throw new Error('QIVO_DESKTOP_URL must use http or https')
  }
  if (
    appURL.username ||
    appURL.password ||
    appURL.search ||
    appURL.hash ||
    !isTrustedHost(appURL.hostname) ||
    (appURL.protocol === 'http:' && appURL.hostname !== 'localhost')
  ) {
    throw new Error('QIVO_DESKTOP_URL must be a trusted Qivo HTTPS origin or localhost HTTP origin')
  }
  return appURL
}
