import { describe, expect, it } from 'vitest'
import {
  assertTrigger,
  builtCommit,
  compareVersions,
  configuration,
  deployEnvironment,
  deploymentRequest,
  findStagingReceipt,
  preflightProjects,
  restApiOnly,
  verifyCommit,
  verifyPublicBuild,
} from './deploy-environment.mjs'

const SHA = 'a'.repeat(40)
const OTHER = 'c'.repeat(40)
const BOT = { login: 'github-actions[bot]' }
const config = {
  environment: 'production',
  sha: SHA,
  origin: 'https://qivo.io',
  app: { id: 'app-id', token: 'app-test-token' },
  demo: { id: 'demo-id', token: 'demo-test-token' },
  team: 'team-id',
  githubToken: 'github-test-token',
  runId: '300',
  runAttempt: 1,
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
    published_at: '2026-10-12T12:00:00Z',
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
const receipt = (id, change = {}) => ({
  id,
  sha: SHA,
  environment: 'staging',
  creator: BOT,
  created_at: '2026-10-12T10:59:00Z',
  ...change,
  payload: {
    kind: 'qivo-staging-v1',
    app_revision: SHA,
    ci_run_id: 1,
    workflow_run_id: '100',
    workflow_run_attempt: 1,
    ...change.payload,
  },
})
const POLICY = {
  deploymentSources: [
    {
      enabled: true,
      environments: [{ type: 'system', target: 'production' }],
      sources: ['rest-api'],
    },
  ],
}
const success = (id, createdAt = '2026-10-12T11:00:00Z', change = {}) => ({
  id,
  state: 'success',
  creator: BOT,
  created_at: createdAt,
  ...change,
})

/**
 * A read-only GitHub API double. `change` overrides one kind of response. `preMove`
 * makes the commit predate the website moving into this repository.
 */
function githubFixture(change = {}) {
  return async (path, _method, _body, options = {}) => {
    if (path.includes('/contents/website/index.html?ref=')) {
      expect(options.allowMissing).toBe(true)
      return change.preMove ? null : { type: 'file', path: 'website/index.html' }
    }
    if (path.includes('/git/matching-refs/tags/'))
      return (change.tags || ['v1.0.0']).map((tag) => ({ ref: `refs/tags/${tag}` }))
    if (path.includes('/compare/'))
      return { merge_base_commit: { sha: SHA }, status: 'identical', ...change.compare }
    if (path.includes('/actions/workflows/'))
      return { workflow_runs: [{ ...successfulRun, ...change.ci }] }
    if (path.includes('/releases?'))
      return change.releases || [{ tag_name: 'v1.0.0', draft: false, prerelease: false }]
    if (path.includes('/releases/')) return { ...event.release, ...change.release }
    if (path.includes('/commits/')) return { sha: SHA, ...change.commit }
    if (path.includes('/statuses')) {
      const id = Number(path.split('/deployments/')[1].split('/')[0])
      return change.statusesFor?.[id] || change.statuses || [success(1, undefined, change.status)]
    }
    if (path.includes('/actions/runs/')) {
      const [id, , attempt] = path.split('/actions/runs/')[1].split('/')
      if (change.missingRuns?.includes(id)) {
        expect(options.allowMissing).toBe(true)
        return null
      }
      return {
        id: Number(id),
        run_attempt: Number(attempt),
        conclusion: 'success',
        path: '.github/workflows/staging.yml',
        head_sha: SHA,
        head_branch: 'main',
        event: 'workflow_run',
        repository: { full_name: 'qivo-io/qivo' },
        run_started_at: '2026-10-12T00:00:00Z',
        updated_at: '2026-10-12T23:59:00Z',
        ...change.stagingRun,
        ...change.runsById?.[id],
      }
    }
    if (path.includes('/deployments?'))
      return change.deployments || [receipt(20, change.deployment)]
    throw new Error(`Unexpected test request ${path}`)
  }
}

describe('production authorization', () => {
  it('accepts a person publishing a prepared bot-authored draft of a staged commit', async () => {
    await expect(verifyCommit(config, event, githubFixture())).resolves.toEqual({
      ciId: 1,
      stagingReceiptId: 20,
    })
  })
  it('preserves successful staging evidence after automatic inactivation without masking failures', async () => {
    const inactive = (id) => ({
      id,
      state: 'inactive',
      creator: BOT,
      created_at: '2026-10-12T11:30:00Z',
    })
    await expect(
      verifyCommit(
        config,
        event,
        githubFixture({ statuses: [inactive(3), inactive(2), success(1)] }),
      ),
    ).resolves.toMatchObject({ stagingReceiptId: 20 })
    for (const statuses of [
      [inactive(3), { ...success(2), state: 'failure' }, success(1)],
      [inactive(3), { ...success(2), state: 'error' }, success(1)],
      // API order is not trusted. The newest status by id decides.
      [success(1), { ...success(2), state: 'failure' }],
      [inactive(1)],
    ])
      await expect(verifyCommit(config, event, githubFixture({ statuses }))).rejects.toThrow(
        /no successful staging deployment/,
      )
  })
  it('rejects draft, prerelease, bot publication, invalid tag and unrelated event', () => {
    for (const change of [
      { action: 'created' },
      { sender: { type: 'Bot' } },
      { release: { ...event.release, draft: true } },
      { release: { ...event.release, prerelease: true } },
      { release: { ...event.release, tag_name: 'v1.0.0-rc.1' } },
      { release: { ...event.release, published_at: undefined } },
    ])
      expect(() => assertTrigger(config, { ...event, ...change })).toThrow()
  })
  it('rejects changed tags, commits outside main, failed checks and unverified staging', async () => {
    for (const change of [
      { commit: { sha: OTHER } },
      { compare: { merge_base_commit: { sha: OTHER } } },
      { ci: { conclusion: 'failure' } },
      { ci: { head_branch: 'feature' } },
      { status: { state: 'failure' } },
      // Staged after the release was published, or recorded by someone else.
      { status: { created_at: '2026-10-12T12:00:01Z' } },
      { status: { creator: { login: 'someone-else' } } },
      { stagingRun: { conclusion: 'in_progress' } },
      { stagingRun: { path: '.github/workflows/other.yml' } },
      { deployment: { creator: { login: 'someone-else' } } },
      { deployment: { payload: { app_revision: OTHER } } },
      { deployment: { payload: { ci_run_id: 2 } } },
      { deployments: [] },
    ])
      await expect(verifyCommit(config, event, githubFixture(change))).rejects.toThrow()
  })
  it('uses the newest staging record from before publication, whatever the API order', async () => {
    const deployments = [
      receipt(21, { payload: { workflow_run_id: '101' } }),
      receipt(22, { payload: { workflow_run_id: '102' } }),
      receipt(23, { payload: { workflow_run_id: '103' } }),
      receipt(20),
    ]
    const statusesFor = {
      20: [success(2, '2026-10-12T11:50:00Z')],
      21: [success(1, '2026-10-12T10:00:00Z')],
      // Newer, but staged after publication.
      22: [success(3, '2026-10-12T12:30:00Z')],
      // Newer, but a later failure withdrew it.
      23: [
        { ...success(5, '2026-10-12T11:55:00Z'), state: 'failure' },
        success(4, '2026-10-12T11:54:00Z'),
      ],
    }
    await expect(
      verifyCommit(config, event, githubFixture({ deployments, statusesFor })),
    ).resolves.toEqual({ ciId: 1, stagingReceiptId: 20 })
  })
  it('refuses a release older than the newest version tag, even if that release was deleted', async () => {
    // Tags are compared, not releases. A newer release set back to draft keeps its tag.
    await expect(
      verifyCommit(config, event, githubFixture({ tags: ['v1.0.10', 'v1.0.0'] })),
    ).rejects.toThrow(/v1\.0\.10 is newer than v1\.0\.0/)
    for (const tags of [['v2.0.0-rc.1', 'v1.0.0'], ['v0.9.9'], [], ['main', 'v1.0.0']])
      await expect(verifyCommit(config, event, githubFixture({ tags }))).resolves.toMatchObject({
        stagingReceiptId: 20,
      })
  })
  it('explains that only a new, higher version helps when staging is missing or came later', async () => {
    await expect(verifyCommit(config, event, githubFixture({ deployments: [] }))).rejects.toThrow(
      /no successful staging deployment\. Re-running this release cannot change that/,
    )
    await expect(
      verifyCommit(
        config,
        event,
        githubFixture({ statuses: [success(1, '2026-10-12T12:03:00Z')] }),
      ),
    ).rejects.toThrow(/only after the release was published/)
  })
  it('refuses records that their staging run attempt cannot vouch for', async () => {
    const window = { run_started_at: '2026-10-12T10:57:00Z', updated_at: '2026-10-12T11:01:00Z' }
    await expect(
      verifyCommit(config, event, githubFixture({ stagingRun: window })),
    ).resolves.toMatchObject({ stagingReceiptId: 20 })
    for (const change of [
      // Created, or marked successful, outside the attempt that the record names.
      { deployment: { created_at: '2026-10-12T10:50:00Z' } },
      { deployment: { created_at: '2026-10-12T11:05:00Z' } },
      { status: { created_at: '2026-10-12T11:30:00Z' } },
      { status: { created_at: '2026-10-12T10:56:00Z' } },
      // The attempt itself did not succeed, or is another attempt.
      { stagingRun: { conclusion: 'failure' } },
      { stagingRun: { run_attempt: 2 } },
      // Run numbers must be plain positive numbers.
      { deployment: { payload: { workflow_run_attempt: '01' } } },
      { deployment: { payload: { workflow_run_id: '0100' } } },
      { deployment: { payload: { workflow_run_attempt: 0 } } },
    ])
      await expect(
        verifyCommit(
          config,
          event,
          githubFixture({ ...change, stagingRun: { ...window, ...change.stagingRun } }),
        ),
      ).rejects.toThrow(/no successful staging deployment/)
  })
  it('skips a record whose staging run was deleted, because it cannot be checked', async () => {
    const deployments = [receipt(20), receipt(21, { payload: { workflow_run_id: '200' } })]
    const statusesFor = {
      20: [success(1, '2026-10-12T11:00:00Z')],
      21: [success(2, '2026-10-12T11:30:00Z')],
    }
    await expect(
      verifyCommit(
        config,
        event,
        githubFixture({ deployments, statusesFor, missingRuns: ['200'] }),
      ),
    ).resolves.toMatchObject({ stagingReceiptId: 20 })
    await expect(
      verifyCommit(config, event, githubFixture({ missingRuns: ['100'] })),
    ).rejects.toThrow(/no successful staging deployment/)
  })
  it('checks the named attempt, which a later re-run cannot change', async () => {
    const calls = []
    const legacy = receipt(20, { payload: { workflow_run_attempt: undefined } })
    for (const deployments of [undefined, [legacy]]) {
      const fixture = githubFixture({ deployments })
      await verifyCommit(config, event, (path, ...rest) => {
        calls.push(path)
        return fixture(path, ...rest)
      })
    }
    expect(calls.filter((path) => path.includes('/actions/runs/100'))).toEqual([
      '/repos/qivo-io/qivo/actions/runs/100/attempts/1',
      '/repos/qivo-io/qivo/actions/runs/100/attempts/1',
    ])
  })
  it('refuses commits from before the website moved into this repository', async () => {
    await expect(verifyCommit(config, event, githubFixture({ preMove: true }))).rejects.toThrow(
      /from before the website moved into this repository/,
    )
  })
  it('does not perform any provider writes when release verification fails', async () => {
    const calls = []
    await expect(
      deployEnvironment(config, event, {
        fetchImpl: async (url, request) => {
          calls.push({ url: String(url), request })
          return Response.json({ merge_base_commit: { sha: OTHER } })
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
    await expect(verifyCommit(staging, completed, githubFixture())).resolves.toEqual({ ciId: 1 })
    for (const change of [
      { event: 'pull_request' },
      { head_branch: 'feature' },
      { head_sha: OTHER },
      { head_repository: { full_name: 'fork/qivo' } },
    ])
      expect(() =>
        assertTrigger(staging, {
          ...completed,
          workflow_run: { ...completed.workflow_run, ...change },
        }),
      ).toThrow()
  })
  it('restages current main by hand without inputs, from main only', async () => {
    const manual = { ...staging, eventName: 'workflow_dispatch', ref: 'refs/heads/main' }
    await expect(verifyCommit(manual, {}, githubFixture())).resolves.toEqual({ ciId: 1 })
    await expect(
      verifyCommit(manual, {}, githubFixture({ compare: { status: 'ahead' } })),
    ).rejects.toThrow(/current main/)
    expect(() => assertTrigger({ ...manual, ref: 'refs/heads/feature' }, {})).toThrow()
  })
})

describe('release ordering', () => {
  it('compares stable versions numerically', () => {
    expect(['v1.10.0', 'v1.9.2', 'v0.1.10', 'v0.1.9'].sort(compareVersions)).toEqual([
      'v0.1.9',
      'v0.1.10',
      'v1.9.2',
      'v1.10.0',
    ])
    expect(() => compareVersions('v1.0.0-rc.1', 'v1.0.0')).toThrow()
  })
  it('finds the newest staging record without a cutoff, for preparing a release', async () => {
    const statusesFor = {
      20: [success(1, '2026-10-12T11:00:00Z')],
      21: [success(2, '2026-10-12T13:00:00Z')],
    }
    const deployments = [receipt(20), receipt(21, { payload: { workflow_run_id: '101' } })]
    await expect(
      findStagingReceipt(githubFixture({ deployments, statusesFor }), { sha: SHA }),
    ).resolves.toMatchObject({ id: 21, runId: 101, runAttempt: 1 })
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
  it('reads back the one exact commit Vercel built', () => {
    expect(builtCommit({ gitSource: { ref: SHA, sha: SHA } })).toBe(SHA)
    expect(builtCommit({ gitSource: { sha: SHA }, meta: { githubCommitSha: SHA } })).toBe(SHA)
    for (const deployment of [
      { gitSource: { ref: 'main' } },
      { gitSource: { ref: 'main', sha: 'main' } },
      { gitSource: { sha: SHA }, meta: { githubCommitSha: OTHER } },
    ])
      expect(() => builtCommit(deployment)).toThrow()
  })
  it('accepts a valid configuration and refuses wrong identities', () => {
    const env = {
      QIVO_ENVIRONMENT: 'production',
      QIVO_COMMIT: SHA,
      QIVO_APP_ORIGIN: 'https://qivo.io',
      GITHUB_REPOSITORY: 'qivo-io/qivo',
      VERCEL_TEAM_ID: 'team-id',
      VERCEL_APP_PROJECT_ID: 'app-id',
      VERCEL_DEMO_PROJECT_ID: 'demo-id',
      VERCEL_APP_TOKEN: 'app-test-token',
      VERCEL_DEMO_TOKEN: 'demo-test-token',
      GH_TOKEN: 'github-test-token',
      GITHUB_RUN_ID: '300',
      GITHUB_EVENT_NAME: 'release',
      GITHUB_REF: 'refs/tags/v1.0.0',
    }
    expect(configuration(env).sha).toBe(SHA)
    for (const change of [
      { QIVO_COMMIT: 'main' },
      { QIVO_APP_ORIGIN: 'https://preview.qivo.io' },
      { VERCEL_DEMO_PROJECT_ID: 'app-id' },
      { VERCEL_APP_TOKEN: '' },
    ])
      expect(() => configuration({ ...env, ...change })).toThrow()
  })
  it('checks the manifest, the website origin and required routes, including their assets', async () => {
    const calls = []
    const page = (origin) => async (url) => {
      calls.push(url)
      if (url.endsWith('/version.json'))
        return Response.json({
          commit: SHA,
          environment: url.includes('demo.qivo.io') ? 'demo' : 'production',
        })
      return new Response(
        `<html><link rel="canonical" href="${origin}/" /><script src="/assets/app.js"></script>` +
          '<img src="/marketing/task.webp"></html>',
      )
    }
    await verifyPublicBuild(config, page('https://qivo.io'))
    expect(calls).toContain('https://qivo.io/assets/app.js')
    expect(calls).toContain('https://qivo.io/marketing/task.webp')
    for (const path of ['/', '/app', '/admin', '/docs/', '/pricing/'])
      expect(calls).toContain(`https://qivo.io${path}`)
    // A staging build served by production would claim the wrong origin.
    await expect(verifyPublicBuild(config, page('https://preview.qivo.io'))).rejects.toThrow(
      /not built for this environment/,
    )
  })
  it('sends the protection bypass only to staging, which must have one', async () => {
    const staging = {
      QIVO_ENVIRONMENT: 'staging',
      QIVO_COMMIT: SHA,
      QIVO_APP_ORIGIN: 'https://preview.qivo.io',
      GITHUB_REPOSITORY: 'qivo-io/qivo',
      VERCEL_TEAM_ID: 'team-id',
      VERCEL_APP_PROJECT_ID: 'app-id',
      VERCEL_APP_TOKEN: 'app-test-token',
      GH_TOKEN: 'github-test-token',
      GITHUB_RUN_ID: '300',
      GITHUB_EVENT_NAME: 'workflow_run',
      GITHUB_REF: 'refs/heads/main',
    }
    const production = {
      ...staging,
      QIVO_ENVIRONMENT: 'production',
      QIVO_APP_ORIGIN: 'https://qivo.io',
      VERCEL_DEMO_PROJECT_ID: 'demo-id',
      VERCEL_DEMO_TOKEN: 'demo-test-token',
    }
    // GitHub passes an empty string for a missing secret.
    expect(() => configuration({ ...staging, VERCEL_APP_PROTECTION_BYPASS: '' })).toThrow(
      /^VERCEL_APP_PROTECTION_BYPASS must be configured/,
    )
    expect(configuration({ ...production, VERCEL_APP_PROTECTION_BYPASS: '' }).appBypass).toBeNull()
    const sent = async (env) => {
      const target = configuration({ ...env, VERCEL_APP_PROTECTION_BYPASS: 'bypass-secret' })
      const { calls, fetchImpl } = providers(target.environment)
      await verifyPublicBuild(target, fetchImpl)
      return [...new Set(calls.map((call) => call.bypass))]
    }
    expect(await sent(staging)).toEqual(['bypass-secret'])
    // qivo.io and demo.qivo.io are public, so production ignores the secret.
    expect(await sent(production)).toEqual([undefined])
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
      return Response.json({
        id: 'app-id',
        link: { org: 'qivo-io', repo: 'qivo' },
        deploymentPolicy: POLICY,
      })
    }
    await expect(preflightProjects(staging, fetchImpl)).rejects.toThrow(/isolated custom domain/)
    expect(calls.every((method) => method === 'GET')).toBe(true)
  })
  it('requires Vercel to accept production deployments only through the API', async () => {
    expect(restApiOnly({ deploymentPolicy: POLICY })).toBe(true)
    const rule = POLICY.deploymentSources[0]
    for (const deploymentPolicy of [
      undefined,
      { deploymentSources: [] },
      { deploymentSources: [{ ...rule, enabled: false }] },
      { deploymentSources: [{ ...rule, sources: ['rest-api', 'git'] }] },
      { deploymentSources: [{ ...rule, environments: [{ type: 'system', target: 'preview' }] }] },
      { deploymentSources: [rule, { ...rule, sources: ['git'] }] },
    ])
      expect(restApiOnly({ deploymentPolicy })).toBe(false)
    const fetchImpl = async () =>
      Response.json({ id: 'app-id', link: { org: 'qivo-io', repo: 'qivo' } })
    await expect(
      preflightProjects({ ...config, origin: 'https://qivo.io' }, fetchImpl),
    ).rejects.toThrow(/only through the API/)
  })
})

/**
 * A provider double for complete runs. The public routes report what was deployed, and
 * `servedOrigin` is the origin the served website was built for.
 */
function providers(environment, { servedOrigin } = {}) {
  const calls = []
  const deployed = new Map()
  const github = githubFixture()
  const origin = environment === 'production' ? 'https://qivo.io' : 'https://preview.qivo.io'
  const hosts = {
    app: environment === 'production' ? 'qivo.io' : 'preview.qivo.io',
    demo: 'demo.qivo.io',
  }
  const fetchImpl = async (url, request = {}) => {
    const parsed = new URL(url)
    const body = request.body ? JSON.parse(request.body) : undefined
    calls.push({
      host: parsed.host,
      path: parsed.pathname,
      method: request.method || 'GET',
      body,
      authorization: request.headers?.Authorization,
      bypass: request.headers?.['x-vercel-protection-bypass'],
    })
    if (parsed.host === 'api.github.com') {
      if (request.method === 'POST') return Response.json({ id: 30 })
      // The real client turns a 404 into null; this double never answers 404.
      return Response.json(
        await github(`${parsed.pathname}${parsed.search}`, 'GET', undefined, {
          allowMissing: true,
        }),
      )
    }
    if (parsed.host === 'api.vercel.com') {
      if (parsed.pathname === '/v13/deployments') {
        deployed.set(`deployment-${body.project}`, body.gitSource)
        return Response.json({ id: `deployment-${body.project}` })
      }
      if (parsed.pathname.startsWith('/v13/deployments/')) {
        const id = parsed.pathname.split('/').at(-1)
        const { ref, sha } = deployed.get(id)
        return Response.json({ id, readyState: 'READY', gitSource: { ref, sha } })
      }
      const id = parsed.pathname.split('/')[3]
      const role = id.split('-')[0]
      if (parsed.pathname.endsWith('/domains'))
        return Response.json({ domains: [{ name: hosts[role] }] })
      if (parsed.pathname.endsWith('/env'))
        return Response.json({
          envs: [{ key: 'QIVO_ENVIRONMENT', id: 'marker', target: ['production'] }],
        })
      if (parsed.pathname.endsWith('/marker'))
        return Response.json({ value: role === 'demo' ? 'demo' : environment })
      return Response.json({
        id,
        name: role,
        ssoProtection: { deploymentType: 'all' },
        deploymentPolicy: POLICY,
        link: { org: 'qivo-io', repo: 'qivo', type: 'github', repoId: 1 },
      })
    }
    if (parsed.pathname === '/version.json')
      return Response.json({
        commit: SHA,
        environment: parsed.hostname === 'demo.qivo.io' ? 'demo' : environment,
      })
    return new Response(
      `<html><link rel="canonical" href="${servedOrigin || origin}/" />Qivo</html>`,
    )
  }
  return { calls, deployed, fetchImpl, origin }
}

describe('complete deployments', () => {
  const quiet = { pause: async () => {}, log: () => {} }
  const posted = (calls, suffix) =>
    calls.filter(
      (call) =>
        call.host === 'api.github.com' && call.method === 'POST' && call.path.endsWith(suffix),
    )

  it('releases the staged commit to the app and demo and records its staging run', async () => {
    const { calls, deployed, fetchImpl } = providers('production')
    await deployEnvironment(config, event, { fetchImpl, ...quiet })
    expect([...deployed.keys()]).toEqual(['deployment-app-id', 'deployment-demo-id'])
    for (const source of deployed.values()) expect(source).toMatchObject({ ref: SHA, sha: SHA })
    expect(
      calls.some(
        (call) =>
          call.host === 'api.vercel.com' && call.path.endsWith('/env') && call.method === 'POST',
      ),
    ).toBe(false)
    expect(posted(calls, '/deployments')[0].body.payload).toEqual({
      kind: 'qivo-production-v1',
      app_revision: SHA,
      ci_run_id: 1,
      staging_receipt_id: 20,
      workflow_run_id: '300',
      workflow_run_attempt: 1,
    })
    expect(calls.at(-1).body.state).toBe('success')
    for (const call of calls.filter((item) => item.path === '/v13/deployments'))
      expect(call.authorization).toBe(`Bearer ${call.body.project.split('-')[0]}-test-token`)
  })

  const staging = {
    ...config,
    environment: 'staging',
    origin: 'https://preview.qivo.io',
    demo: null,
    appBypass: 'bypass-secret',
    eventName: 'workflow_run',
    ref: 'refs/heads/main',
  }
  const completed = {
    action: 'completed',
    workflow_run: { ...successfulRun, head_repository: { full_name: 'qivo-io/qivo' } },
  }

  it('stages current main and records it only after it serves', async () => {
    const { calls, deployed, fetchImpl } = providers('staging')
    await deployEnvironment(staging, completed, { fetchImpl, ...quiet })
    expect([...deployed.keys()]).toEqual(['deployment-app-id'])
    const receipts = posted(calls, '/deployments')
    expect(receipts).toHaveLength(1)
    expect(receipts[0].body.payload).toEqual({
      kind: 'qivo-staging-v1',
      app_revision: SHA,
      ci_run_id: 1,
      workflow_run_id: '300',
      workflow_run_attempt: 1,
    })
    expect(posted(calls, '/statuses').map((call) => call.body.state)).toEqual(['success'])
    expect(
      calls.findIndex(
        (call) => call.path === '/repos/qivo-io/qivo/deployments' && call.method === 'POST',
      ),
    ).toBeGreaterThan(calls.findLastIndex((call) => call.host === 'preview.qivo.io'))
  })

  it('records nothing when staging serves a website built for another origin', async () => {
    const { calls, fetchImpl } = providers('staging', { servedOrigin: 'https://qivo.io' })
    await expect(deployEnvironment(staging, completed, { fetchImpl, ...quiet })).rejects.toThrow(
      /not built for this environment/,
    )
    expect(calls.some((call) => call.host === 'api.github.com' && call.method === 'POST')).toBe(
      false,
    )
  })
})
