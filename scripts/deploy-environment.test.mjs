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
  stagingWebsiteRequest,
  verifyCommit,
  verifyPublicBuild,
} from './deploy-environment.mjs'

const SHA = 'a'.repeat(40)
const SITE_SHA = 'b'.repeat(40)
const OTHER = 'c'.repeat(40)
const BOT = { login: 'github-actions[bot]' }
const config = {
  environment: 'production',
  sha: SHA,
  origin: 'https://qivo.io',
  app: { id: 'app-id', token: 'app-test-token' },
  site: { id: 'site-id', token: 'site-test-token' },
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
    site_revision: SITE_SHA,
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

/** A read-only GitHub API double. `change` overrides one kind of response. */
function githubFixture(change = {}) {
  return async (path, _method, _body, options = {}) => {
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
  it('accepts a person publishing a prepared bot-authored draft and reuses the staged website', async () => {
    await expect(verifyCommit(config, event, githubFixture())).resolves.toEqual({
      ciId: 1,
      siteSha: SITE_SHA,
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
    ).resolves.toMatchObject({ siteSha: SITE_SHA })
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
      { deployment: { payload: { site_revision: 'main' } } },
      { deployment: { payload: { app_revision: OTHER } } },
      { deployment: { payload: { ci_run_id: 2 } } },
      { deployments: [] },
    ])
      await expect(verifyCommit(config, event, githubFixture(change))).rejects.toThrow()
  })
  it('deploys the newest staged website from before publication, whatever the API order', async () => {
    const deployments = [
      receipt(21, { payload: { site_revision: 'd'.repeat(40), workflow_run_id: '101' } }),
      receipt(22, { payload: { site_revision: OTHER, workflow_run_id: '102' } }),
      receipt(23, { payload: { site_revision: 'e'.repeat(40), workflow_run_id: '103' } }),
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
    ).resolves.toEqual({ ciId: 1, siteSha: SITE_SHA, stagingReceiptId: 20 })
  })
  it('refuses a release older than the newest version tag, even if that release was deleted', async () => {
    // Tags are compared, not releases. A newer release set back to draft keeps its tag.
    await expect(
      verifyCommit(config, event, githubFixture({ tags: ['v1.0.10', 'v1.0.0'] })),
    ).rejects.toThrow(/v1\.0\.10 is newer than v1\.0\.0/)
    for (const tags of [['v2.0.0-rc.1', 'v1.0.0'], ['v0.9.9'], [], ['main', 'v1.0.0']])
      await expect(verifyCommit(config, event, githubFixture({ tags }))).resolves.toMatchObject({
        siteSha: SITE_SHA,
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
  it('refuses to choose when two records name the same staging run attempt', async () => {
    for (const second of [
      receipt(21, { payload: { site_revision: OTHER } }),
      // Records without an attempt name the first attempt.
      receipt(21, { payload: { site_revision: OTHER, workflow_run_attempt: undefined } }),
    ])
      await expect(
        verifyCommit(config, event, githubFixture({ deployments: [receipt(20), second] })),
      ).rejects.toThrow(/Several staging records name staging run 100/)
    // A malformed copy is ignored rather than counted, and cannot win.
    const forged = receipt(21, { payload: { site_revision: OTHER, workflow_run_attempt: '01' } })
    await expect(
      verifyCommit(
        config,
        event,
        githubFixture({
          deployments: [receipt(20), forged],
          statusesFor: { 20: [success(1)], 21: [success(2, '2026-10-12T11:30:00Z')] },
        }),
      ),
    ).resolves.toMatchObject({ siteSha: SITE_SHA })
  })
  it('stops instead of falling back when the run behind a newer record was deleted', async () => {
    const deployments = [
      receipt(20),
      receipt(21, { payload: { site_revision: OTHER, workflow_run_id: '200' } }),
    ]
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
    ).rejects.toThrow(
      /Staging run 200, which recorded a staging deployment of this commit, was deleted/,
    )
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
  it('refuses to re-run releases published before production used staging records', async () => {
    const early = { ...event, release: { ...event.release, published_at: '2026-10-11T11:16:54Z' } }
    await expect(verifyCommit(config, early, githubFixture())).rejects.toThrow(
      /published before production took its website from staging records/,
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
  it('finds the newest staged pair without a cutoff, for preparing a release', async () => {
    const statusesFor = {
      20: [success(1, '2026-10-12T11:00:00Z')],
      21: [success(2, '2026-10-12T13:00:00Z')],
    }
    const deployments = [
      receipt(20),
      receipt(21, { payload: { site_revision: OTHER, workflow_run_id: '101' } }),
    ]
    await expect(
      findStagingReceipt(githubFixture({ deployments, statusesFor }), { sha: SHA }),
    ).resolves.toMatchObject({ id: 21, siteSha: OTHER, runId: 101, runAttempt: 1 })
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
  it('builds the staging website from main and reads back the exact commit Vercel built', () => {
    expect(
      stagingWebsiteRequest({ id: 'site-id', name: 'site', link: { type: 'github', repoId: 2 } }),
    ).toEqual({
      name: 'site',
      project: 'site-id',
      target: 'production',
      gitSource: { type: 'github', repoId: 2, ref: 'main' },
      meta: { qivoSiteRef: 'main' },
    })
    const built = {
      gitSource: { ref: 'main', sha: SITE_SHA },
      meta: { githubCommitRef: 'main', githubCommitSha: SITE_SHA },
    }
    expect(builtCommit(built, 'main')).toBe(SITE_SHA)
    expect(builtCommit({ gitSource: { ref: SHA, sha: SHA } })).toBe(SHA)
    for (const deployment of [
      { gitSource: { ref: 'main' } },
      { gitSource: { ref: 'main', sha: 'main' } },
      { ...built, meta: { githubCommitRef: 'main', githubCommitSha: OTHER } },
      { gitSource: { ref: 'feature', sha: SITE_SHA } },
      { gitSource: { sha: SITE_SHA } },
    ])
      expect(() => builtCommit(deployment, 'main')).toThrow()
  })
  it('needs no website revision and refuses wrong environment origins and shared project IDs', () => {
    const env = {
      QIVO_ENVIRONMENT: 'production',
      QIVO_COMMIT: SHA,
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
    expect(configuration(env).sha).toBe(SHA)
    // Release tags made before this change still pass the retired pin.
    expect(configuration({ ...env, QIVO_SITE_REVISION: OTHER })).not.toHaveProperty('siteSha')
    for (const change of [
      { QIVO_COMMIT: 'main' },
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
    await verifyPublicBuild({ ...config, siteSha: SITE_SHA }, fetchImpl)
    expect(calls).toContain('https://qivo.io/assets/app.js')
    await expect(verifyPublicBuild({ ...config, siteSha: OTHER }, fetchImpl)).rejects.toThrow(
      /proxied website/,
    )
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
 * A provider double for complete runs. Vercel resolves a `main` request to
 * `privateMain`, and the public manifests report what was deployed.
 */
function providers(environment, { privateMain = SITE_SHA, builtRef, served = {} } = {}) {
  const calls = []
  const deployed = new Map()
  const github = githubFixture()
  const origin = environment === 'production' ? 'https://qivo.io' : 'https://preview.qivo.io'
  const hosts = {
    app: environment === 'production' ? 'qivo.io' : 'preview.qivo.io',
    site: environment === 'production' ? 'site-origin.qivo.io' : 'site-preview.qivo.io',
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
    })
    if (parsed.host === 'api.github.com') {
      if (request.method === 'POST') return Response.json({ id: 30 })
      return Response.json(await github(`${parsed.pathname}${parsed.search}`))
    }
    if (parsed.host === 'api.vercel.com') {
      if (parsed.pathname === '/v13/deployments') {
        const { ref, sha } = body.gitSource
        deployed.set(`deployment-${body.project}`, {
          ref: sha ? ref : builtRef || ref,
          sha: sha || privateMain,
        })
        return Response.json({ id: `deployment-${body.project}` })
      }
      if (parsed.pathname.startsWith('/v13/deployments/')) {
        const id = parsed.pathname.split('/').at(-1)
        return Response.json({ id, readyState: 'READY', gitSource: deployed.get(id) })
      }
      const id = parsed.pathname.split('/')[3]
      const role = id.split('-')[0]
      if (request.method === 'POST') return Response.json({})
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
        rootDirectory: role === 'site' ? 'website' : null,
        sourceFilesOutsideRootDirectory: false,
        ssoProtection: { deploymentType: 'all' },
        deploymentPolicy: POLICY,
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
        environment: parsed.hostname === 'demo.qivo.io' ? 'demo' : environment,
      })
    if (parsed.pathname === '/site-version.json')
      return Response.json({
        docs: { commit: SHA },
        website: { commit: served.site || deployed.get('deployment-site-id')?.sha },
        environment,
      })
    return new Response('<html>Qivo</html>')
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

  it('releases the staged pair and records which staging run it came from', async () => {
    const { calls, deployed, fetchImpl } = providers('production')
    await deployEnvironment(config, event, { fetchImpl, ...quiet })
    expect([...deployed.values()]).toEqual([
      { ref: SITE_SHA, sha: SITE_SHA },
      { ref: SHA, sha: SHA },
      { ref: SHA, sha: SHA },
    ])
    const pins = calls.find((call) => call.path.endsWith('/env') && call.method === 'POST')
    expect(pins.authorization).toBe('Bearer site-test-token')
    expect(pins.body).toEqual([
      { key: 'QIVO_SOURCE_REVISION', value: SHA, type: 'plain', target: ['production'] },
      { key: 'QIVO_SITE_REVISION', value: SITE_SHA, type: 'plain', target: ['production'] },
      { key: 'SITE_ORIGIN', value: 'https://qivo.io', type: 'plain', target: ['production'] },
    ])
    expect(posted(calls, '/deployments')[0].body.payload).toEqual({
      kind: 'qivo-production-v1',
      app_revision: SHA,
      site_revision: SITE_SHA,
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
    eventName: 'workflow_run',
    ref: 'refs/heads/main',
  }
  const completed = {
    action: 'completed',
    workflow_run: { ...successfulRun, head_repository: { full_name: 'qivo-io/qivo' } },
  }

  it('stages current private main and records the commit Vercel built only after it serves', async () => {
    const { calls, deployed, fetchImpl } = providers('staging', { privateMain: OTHER })
    await deployEnvironment(staging, completed, { fetchImpl, ...quiet })
    expect([...deployed.values()]).toEqual([
      { ref: 'main', sha: OTHER },
      { ref: SHA, sha: SHA },
    ])
    const pins = calls.find((call) => call.path.endsWith('/env') && call.method === 'POST')
    expect(pins.body.find((pin) => pin.key === 'QIVO_SITE_REVISION').value).toBe('main')
    const receipts = posted(calls, '/deployments')
    expect(receipts).toHaveLength(1)
    expect(receipts[0].body.payload).toEqual({
      kind: 'qivo-staging-v1',
      app_revision: SHA,
      site_revision: OTHER,
      ci_run_id: 1,
      workflow_run_id: '300',
      workflow_run_attempt: 1,
    })
    expect(posted(calls, '/statuses').map((call) => call.body.state)).toEqual(['success'])
    expect(
      calls.findIndex(
        (call) => call.path === '/repos/qivo-io/qivo/deployments' && call.method === 'POST',
      ),
    ).toBeGreaterThan(calls.findLastIndex((call) => call.path === '/site-version.json'))
  })

  it('fails without a record when Vercel builds another branch for the staging website', async () => {
    const { calls, fetchImpl } = providers('staging', { privateMain: OTHER, builtRef: 'feature' })
    await expect(deployEnvironment(staging, completed, { fetchImpl, ...quiet })).rejects.toThrow(
      /different Git reference/,
    )
    expect(calls.some((call) => call.host === 'api.github.com' && call.method === 'POST')).toBe(
      false,
    )
  })

  it('records nothing when the staged website does not serve the commit Vercel built', async () => {
    const { calls, fetchImpl } = providers('staging', {
      privateMain: OTHER,
      served: { site: SITE_SHA },
    })
    await expect(deployEnvironment(staging, completed, { fetchImpl, ...quiet })).rejects.toThrow(
      /proxied website/,
    )
    expect(calls.some((call) => call.host === 'api.github.com' && call.method === 'POST')).toBe(
      false,
    )
  })
})
