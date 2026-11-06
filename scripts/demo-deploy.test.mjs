import { writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { deploy } from './demo-deploy.mjs'

const demo = {
  QIVO_ENVIRONMENT: 'demo',
  VITE_APP_MODE: 'demo',
  DEMO_CONVEX_DEPLOYMENT: 'demo-fixture-123',
  CONVEX_DEPLOY_KEY: 'prod:demo-fixture-123|test-only',
}
const SITE = 'https://demo-fixture-123.convex.site'

/* A `convex deploy` stand-in that records each step in `steps` and, as its
 * build command (demo-build.mjs) does, records `site` for the probe, or
 * nothing when it is null. */
const convexDeploy = (steps, site = SITE) =>
  vi.fn((_command, _args, options) => {
    steps.push('convex deploy')
    if (site !== null) writeFileSync(options.env.QIVO_SITE_URL_FILE, `${site}\n`)
  })

describe('the demo deploy', () => {
  it('pushes with demo-build.mjs as the build command, then probes the sign-in route alone', async () => {
    const steps = []
    const run = convexDeploy(steps)
    const fetch = vi.fn(async (url) => {
      steps.push(`probe ${url}`)
      return new Response('null', { headers: { 'Content-Type': 'application/json' } })
    })
    await deploy(demo, run, { fetch, sleep: async () => {}, log: () => {} })
    expect(run.mock.calls[0].slice(0, 2)).toEqual([
      'npx',
      ['convex', 'deploy', '--cmd', 'node scripts/demo-build.mjs'],
    ])
    expect(steps).toEqual(['convex deploy', `probe ${SITE}/api/auth/get-session`])
  })

  it('fails the build when the sign-in route does not answer as expected', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 500 }))
    await expect(
      deploy(demo, convexDeploy([]), { fetch, sleep: async () => {}, log: () => {} }),
    ).rejects.toThrow(/GET \/api\/auth\/get-session answered 500/)
  })

  it('fails the build when the build command recorded no site URL', async () => {
    const probe = vi.fn()
    await expect(deploy(demo, convexDeploy([], null), { probe })).rejects.toThrow(
      /recorded no Convex site URL/,
    )
    expect(probe).not.toHaveBeenCalled()
  })

  it('neither pushes nor probes for a target it refuses', () => {
    const run = vi.fn()
    const probe = vi.fn()
    for (const target of [
      { ...demo, VITE_APP_MODE: 'normal' },
      { ...demo, CONVEX_DEPLOY_KEY: 'prod:other-fixture-123|test-only' },
    ])
      expect(() => deploy(target, run, { probe })).toThrow()
    expect(run).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })
})
