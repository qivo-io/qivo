/** Deployment permissions come from an explicit server setting, never a hostname. */
export function deploymentEnvironment() {
  const value = process.env.QIVO_ENVIRONMENT
  if (
    value !== 'development' &&
    value !== 'preview' &&
    value !== 'staging' &&
    value !== 'production' &&
    value !== 'demo'
  ) {
    throw new Error(
      'QIVO_ENVIRONMENT must explicitly name development, preview, staging, production or demo',
    )
  }
  return value
}

/** Require an exact origin without credentials, paths, query strings or fragments. */
export function deploymentOrigin(): string {
  const site = process.env.SITE_URL
  if (!site) throw new Error('SITE_URL is not set')
  let url: URL
  try {
    url = new URL(site)
  } catch {
    throw new Error('SITE_URL must be an exact http(s) origin')
  }
  if (!/^https?:\/\//.test(site) || url.origin !== site) {
    throw new Error('SITE_URL must be an exact http(s) origin')
  }
  return site
}

export function isLocalDevelopment(): boolean {
  return (
    deploymentEnvironment() === 'development' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(deploymentOrigin()).hostname)
  )
}

/** Internal fixture commands still need a deploy key and an isolated target. */
export function refuseProduction(scope: string): void {
  const environment = deploymentEnvironment()
  const site = deploymentOrigin()
  const hostname = new URL(site).hostname
  if (
    !['development', 'preview', 'staging'].includes(environment) ||
    process.env.APP_MODE === 'demo' ||
    ['qivo.io', 'www.qivo.io', 'demo.qivo.io'].includes(hostname)
  ) {
    throw new Error(`${scope} cannot run on a production or public demo deployment`)
  }
  if (!site.startsWith('https://') && !isLocalDevelopment()) {
    throw new Error(`${scope} requires HTTPS outside local development`)
  }
}
