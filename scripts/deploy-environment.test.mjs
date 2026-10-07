import { describe, expect, it } from 'vitest'
import {
  assertTrigger,
  configuration,
  deployEnvironment,
  deploymentRequest,
  preflightProjects,
  verifyCommit,
  verifyPublicBuild,
} from './deploy-environment.mjs'

const SHA = 'a'.repeat(40)
const SITE_SHA = 'b'.repeat(40)
const config = {
  environment: 'production',
  sha: SHA,
  siteSha: SITE_SHA,
  origin: 'https://qivo.io',
  app: { id: 'app-id', token: 'app-test-token' },
  site: { id: 'site-id', token: 'site-test-token' },
  demo: { id: 'demo-id', token: 'demo-test-token' },
  team: 'team-id',
  githubToken: 'github-test-token',
  runId: '300',
  eventName: 'release',
  ref: 'refs/tags/v1.0.0',
}
const event = {
  action: 'published',
  sender: { type: 'User' },
  release: {
    id: 10,
    tag_name: 'v1.0.0',
    draft: false,
    prerelease: false,
    author: { type: 'Bot' },
  },
}
const successfulRun = {
  id: 1,
  head_sha: SHA,
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
  event: 'push',
  repository: { full_name: 'qivo-io/qivo' },
}

function githubFixture(change = {}) {
  return async (path) => {
    if (path.includes('/compare/'))
      return { merge_base_commit: { sha: SHA }, status: 'identical', ...change.compare }
    if (path.includes('/actions/workflows/'))
      return { workflow_runs: [{ ...successfulRun, ...change.ci }] }
    if (path.includes('/releases/')) return { ...event.release, ...change.release }
    if (path.includes('/commits/')) return { sha: SHA, ...change.commit }
    if (path.includes('/statuses'))
      return change.statuses || [{ state: 'success', ...change.status }]
    if (path.includes('/actions/runs/'))
      return {
        conclusion: 'success',
        path: '.github/workflows/staging.yml',
        head_sha: SHA,
        head_branch: 'main',
        event: 'workflow_run',
        repository: { full_name: 'qivo-io/qivo' },
        ...change.stagingRun,
      }
    if (path.includes('/deployments?'))
      return [
        {
          id: 20,
          sha: SHA,
          environment: 'staging',
          creator: { login: 'github-actions[bot]' },
          payload: {
            kind: 'qivo-staging-v1',
            app_revision: SHA,
            site_revision: SITE_SHA,
            workflow_run_id: 100,
          },
          ...change.deployment,
        },
      ]
    throw new Error(`Unexpected test request ${path}`)
  }
}

describe('production authorization', () => {
  it('accepts a person publishing a prepared bot-authored draft', async () => {
    await expect(verifyCommit(config, event, githubFixture())).resolves.toBe(1)
  })
  it('preserves successful staging evidence after automatic inactivation without masking failures', async () => {
    await expect(
      verifyCommit(
        config,
        event,
        githubFixture({
          statuses: [{ state: 'inactive' }, { state: 'inactive' }, { state: 'success' }],
        }),
      ),
    ).resolves.toBe(1)
    for (const statuses of [
      [{ state: 'inactive' }, { state: 'failure' }, { state: 'success' }],
      [{ state: 'inactive' }, { state: 'error' }, { state: 'success' }],
      [{ state: 'inactive' }],
    ])
      await expect(verifyCommit(config, event, githubFixture({ statuses }))).rejects.toThrow(
        /no successful verified staging/,
      )
  })
  it('rejects draft, prerelease, bot publication, invalid tag and unrelated event', () => {
    for (const change of [
      { action: 'created' },
      { sender: { type: 'Bot' } },
      { release: { ...event.release, draft: true } },
      { release: { ...event.release, prerelease: true } },
      { release: { ...event.release, tag_name: 'v1.0.0-rc.1' } },
    ])
      expect(() => assertTrigger(config, { ...event, ...change })).toThrow()
  })
  it('rejects changed tags, commits outside main, failed checks and unverified staging', async () => {
    for (const change of [
      { commit: { sha: 'c'.repeat(40) } },
      { compare: { merge_base_commit: { sha: 'c'.repeat(40) } } },
      { ci: { conclusion: 'failure' } },
      { ci: { head_branch: 'feature' } },
      { status: { state: 'failure' } },
      { stagingRun: { conclusion: 'in_progress' } },
      { deployment: { creator: { login: 'someone-else' } } },
      {
        deployment: {
          payload: { kind: 'qivo-staging-v1', app_revision: SHA, site_revision: 'c'.repeat(40) },
        },
      },
    ])
      await expect(verifyCommit(config, event, githubFixture(change))).rejects.toThrow()
  })
  it('does not perform any provider writes when release verification fails', async () => {
    const calls = []
    await expect(
      deployEnvironment(config, event, {
        fetchImpl: async (url, request) => {
          calls.push({ url: String(url), request })
          return Response.json({ merge_base_commit: { sha: 'c'.repeat(40) } })
        },
      }),
    ).rejects.toThrow(/main history/)
    expect(calls).toHaveLength(1)
    expect(calls[0].request.method).toBe('GET')
    expect(calls[0].url).toContain('api.github.com')
  })
})

describe('staging authorization', () => {
  const staging = { ...config, environment: 'staging', eventName: 'workflow_run' }
  const completed = {
    action: 'completed',
    workflow_run: { ...successfulRun, head_repository: { full_name: 'qivo-io/qivo' } },
  }
  it('requires successful upstream main CI for the exact SHA', async () => {
    await expect(verifyCommit(staging, completed, githubFixture())).resolves.toBe(1)
    for (const change of [
      { event: 'pull_request' },
      { head_branch: 'feature' },
      { head_sha: 'c'.repeat(40) },
      { head_repository: { full_name: 'fork/qivo' } },
    ])
      expect(() =>
        assertTrigger(staging, {
          ...completed,
          workflow_run: { ...completed.workflow_run, ...change },
        }),
      ).toThrow()
  })
  it('allows a private website update only against the current main SHA', async () => {
    const manual = { ...staging, eventName: 'workflow_dispatch', ref: 'refs/heads/main' }
    const request = { inputs: { app_revision: SHA } }
    await expect(verifyCommit(manual, request, githubFixture())).resolves.toBe(1)
    await expect(
      verifyCommit(manual, request, githubFixture({ compare: { status: 'ahead' } })),
    ).rejects.toThrow(/current main/)
    expect(() => assertTrigger({ ...manual, ref: 'refs/heads/feature' }, request)).toThrow()
  })
})

describe('deployment identity', () => {
  it('pins both Git ref and SHA with no environment secrets in the request', () => {
    expect(
      deploymentRequest({ id: 'app-id', name: 'app', link: { type: 'github', repoId: 123 } }, SHA),
    ).toEqual({
      name: 'app',
      project: 'app-id',
      target: 'production',
      gitSource: { type: 'github', repoId: 123, ref: SHA, sha: SHA },
      meta: { qivoCommit: SHA },
    })
    expect(() => deploymentRequest({ link: { type: 'github', repoId: 123 } }, 'main')).toThrow()
  })
  it('refuses wrong environment origins and shared project IDs', () => {
    const env = {
      QIVO_ENVIRONMENT: 'production',
      QIVO_COMMIT: SHA,
      QIVO_SITE_REVISION: SITE_SHA,
      QIVO_APP_ORIGIN: 'https://qivo.io',
      GITHUB_REPOSITORY: 'qivo-io/qivo',
      VERCEL_TEAM_ID: 'team-id',
      VERCEL_APP_PROJECT_ID: 'app-id',
      VERCEL_SITE_PROJECT_ID: 'site-id',
      VERCEL_DEMO_PROJECT_ID: 'demo-id',
      VERCEL_APP_TOKEN: 'app-test-token',
      VERCEL_SITE_TOKEN: 'site-test-token',
      VERCEL_DEMO_TOKEN: 'demo-test-token',
      GH_TOKEN: 'github-test-token',
      GITHUB_RUN_ID: '300',
      GITHUB_EVENT_NAME: 'release',
      GITHUB_REF: 'refs/tags/v1.0.0',
    }
    expect(configuration(env).siteSha).toBe(SITE_SHA)
    for (const change of [
      { QIVO_SITE_REVISION: 'main' },
      { QIVO_APP_ORIGIN: 'https://preview.qivo.io' },
      { VERCEL_SITE_PROJECT_ID: 'app-id' },
      { VERCEL_APP_TOKEN: '' },
    ])
      expect(() => configuration({ ...env, ...change })).toThrow()
  })
  it('checks the live manifest pair and required routes, including application assets', async () => {
    const calls = []
    const fetchImpl = async (url) => {
      calls.push(url)
      if (url.endsWith('/version.json'))
        return Response.json({
          commit: SHA,
          environment: url.includes('demo.qivo.io') ? 'demo' : 'production',
        })
      if (url.endsWith('/site-version.json'))
        return Response.json({
          docs: { commit: SHA },
          website: { commit: SITE_SHA },
          environment: 'production',
        })
      return new Response('<html><script src="/assets/app.js"></script></html>')
    }
    await verifyPublicBuild(config, fetchImpl)
    expect(calls).toContain('https://qivo.io/assets/app.js')
    await expect(
      verifyPublicBuild({ ...config, siteSha: 'c'.repeat(40) }, fetchImpl),
    ).rejects.toThrow(/proxied website/)
  })
  it('preflights every project and refuses a staging binding to production before any write', async () => {
    const calls = []
    const staging = {
      ...config,
      environment: 'staging',
      origin: 'https://preview.qivo.io',
      demo: null,
    }
    const fetchImpl = async (url, request) => {
      calls.push(request.method)
      const path = url.pathname
      if (path.endsWith('/domains')) return Response.json({ domains: [{ name: 'qivo.io' }] })
      return Response.json({ id: 'app-id', link: { org: 'qivo-io', repo: 'qivo' } })
    }
    await expect(preflightProjects(staging, fetchImpl)).rejects.toThrow(/isolated custom domain/)
    expect(calls.every((method) => method === 'GET')).toBe(true)
  })
  it('deploys exact sources only after all checks and records success after public verification', async () => {
    const calls = []
    const deployed = new Map()
    const github = githubFixture()
    const fetchImpl = async (url, request = {}) => {
      const parsed = new URL(url)
      const body = request.body ? JSON.parse(request.body) : undefined
      calls.push({
        host: parsed.host,
        path: parsed.pathname,
        method: request.method || 'GET',
        body,
        authorization: request.headers?.Authorization,
      })
      if (parsed.host === 'api.github.com') {
        if (request.method === 'POST') return Response.json({ id: 30 })
        return Response.json(await github(`${parsed.pathname}${parsed.search}`))
      }
      if (parsed.host === 'api.vercel.com') {
        if (parsed.pathname === '/v13/deployments') {
          deployed.set(`deployment-${body.project}`, body.gitSource.sha)
          return Response.json({ id: `deployment-${body.project}` })
        }
        if (parsed.pathname.startsWith('/v13/deployments/'))
          return Response.json({
            id: parsed.pathname.split('/').at(-1),
            readyState: 'READY',
            gitSource: { sha: deployed.get(parsed.pathname.split('/').at(-1)) },
          })
        const id = parsed.pathname.split('/')[3]
        const role = id.split('-')[0]
        if (request.method === 'POST') return Response.json({})
        if (parsed.pathname.endsWith('/domains'))
          return Response.json({
            domains: [
              {
                name: {
                  app: 'qivo.io',
                  site: 'site-origin.qivo.io',
                  demo: 'demo.qivo.io',
                }[role],
              },
            ],
          })
        if (parsed.pathname.endsWith('/env'))
          return Response.json({
            envs: [{ key: 'QIVO_ENVIRONMENT', id: 'marker', target: ['production'] }],
          })
        if (parsed.pathname.endsWith('/marker'))
          return Response.json({ value: role === 'demo' ? 'demo' : 'production' })
        return Response.json({
          id,
          name: role,
          rootDirectory: role === 'site' ? 'website' : null,
          sourceFilesOutsideRootDirectory: false,
          link: {
            org: 'qivo-io',
            repo: role === 'site' ? 'qivo-internal' : 'qivo',
            type: 'github',
            repoId: role === 'site' ? 2 : 1,
          },
        })
      }
      if (parsed.pathname === '/version.json')
        return Response.json({
          commit: SHA,
          environment: parsed.hostname === 'demo.qivo.io' ? 'demo' : 'production',
        })
      if (parsed.pathname === '/site-version.json')
        return Response.json({
          docs: { commit: SHA },
          website: { commit: SITE_SHA },
          environment: 'production',
        })
      return new Response('<html>Qivo</html>')
    }
    await deployEnvironment(config, event, { fetchImpl, pause: async () => {}, log: () => {} })
    expect(deployed.size).toBe(3)
    const pins = calls.find((call) => call.path.endsWith('/env') && call.method === 'POST')
    expect(pins.authorization).toBe('Bearer site-test-token')
    expect(pins.body).toEqual([
      { key: 'QIVO_SOURCE_REVISION', value: SHA, type: 'plain', target: ['production'] },
      { key: 'QIVO_SITE_REVISION', value: SITE_SHA, type: 'plain', target: ['production'] },
      { key: 'SITE_ORIGIN', value: 'https://qivo.io', type: 'plain', target: ['production'] },
    ])
    expect(calls.at(-1).body.state).toBe('success')
    for (const call of calls.filter((item) => item.path === '/v13/deployments'))
      expect(call.authorization).toBe(`Bearer ${call.body.project.split('-')[0]}-test-token`)
  })
})
