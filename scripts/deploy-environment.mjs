#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const COMMIT = /^[0-9a-f]{40}$/
const STABLE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const REPOSITORY = 'qivo-io/qivo'

const required = (env, key) => {
  if (!env[key]) throw new Error(`${key} must be configured for this GitHub environment.`)
  return env[key]
}

/** Configuration contains identifiers and project-scoped tokens, never backend credentials. */
export function configuration(env) {
  const environment = required(env, 'QIVO_ENVIRONMENT')
  if (!['staging', 'production'].includes(environment))
    throw new Error('Invalid deployment environment.')
  if (env.GITHUB_REPOSITORY !== REPOSITORY)
    throw new Error('Only the upstream repository may deploy.')
  const sha = required(env, 'QIVO_COMMIT')
  const siteSha = required(env, 'QIVO_SITE_REVISION')
  if (!COMMIT.test(sha) || !COMMIT.test(siteSha))
    throw new Error('Both source revisions must be full commit SHAs.')
  const origin = required(env, 'QIVO_APP_ORIGIN')
  if (origin !== (environment === 'production' ? 'https://qivo.io' : 'https://preview.qivo.io'))
    throw new Error('The app origin does not match the deployment environment.')
  const app = {
    id: required(env, 'VERCEL_APP_PROJECT_ID'),
    token: required(env, 'VERCEL_APP_TOKEN'),
  }
  const site = {
    id: required(env, 'VERCEL_SITE_PROJECT_ID'),
    token: required(env, 'VERCEL_SITE_TOKEN'),
  }
  const demo =
    environment === 'production'
      ? { id: required(env, 'VERCEL_DEMO_PROJECT_ID'), token: required(env, 'VERCEL_DEMO_TOKEN') }
      : null
  const ids = [app.id, site.id, ...(demo ? [demo.id] : [])]
  if (new Set(ids).size !== ids.length)
    throw new Error('Application, website and demo projects must be separate.')
  return {
    environment,
    sha,
    siteSha,
    origin,
    app,
    site,
    demo,
    team: required(env, 'VERCEL_TEAM_ID'),
    githubToken: required(env, 'GH_TOKEN'),
    appBypass: env.VERCEL_APP_PROTECTION_BYPASS,
    runId: required(env, 'GITHUB_RUN_ID'),
    eventName: required(env, 'GITHUB_EVENT_NAME'),
    ref: required(env, 'GITHUB_REF'),
  }
}

/** Reject an automatic, draft, prerelease or unrelated event before any provider write. */
export function assertTrigger(config, event) {
  if (config.environment === 'production') {
    const release = event.release
    if (
      event.action !== 'published' ||
      !release ||
      release.draft ||
      release.prerelease ||
      !STABLE_TAG.test(release.tag_name || '') ||
      event.sender?.type !== 'User'
    )
      throw new Error('Production requires a manually published stable release.')
  } else {
    if (config.eventName === 'workflow_dispatch') {
      if (config.ref !== 'refs/heads/main' || event.inputs?.app_revision !== config.sha)
        throw new Error('Manual staging runs must use the main workflow and an explicit commit.')
      return
    }
    const run = event.workflow_run
    if (
      event.action !== 'completed' ||
      run?.conclusion !== 'success' ||
      run.event !== 'push' ||
      run.head_branch !== 'main' ||
      run.head_sha !== config.sha ||
      run.head_repository?.full_name !== REPOSITORY
    )
      throw new Error('Staging requires successful upstream main CI for this exact commit.')
  }
}

export function apiClient(base, token, fetchImpl = fetch) {
  return async (path, method = 'GET', body) => {
    const url = new URL(path, base)
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    })
    // Provider errors can contain environment values. Keep error output to status and endpoint.
    if (!response.ok) throw new Error(`${method} ${url.pathname} returned HTTP ${response.status}.`)
    return response.status === 204 ? null : response.json()
  }
}

/** CI and the staging receipt must describe the release commit and approved website commit. */
export async function verifyCommit(config, event, github, pause = sleep) {
  assertTrigger(config, event)
  const prefix = `/repos/${REPOSITORY}`
  const comparison = await github(`${prefix}/compare/${config.sha}...main`)
  if (comparison.merge_base_commit?.sha !== config.sha)
    throw new Error('The deployment commit must belong to main history.')
  if (config.environment === 'staging' && comparison.status !== 'identical')
    throw new Error('Staging must deploy the current main commit.')
  const checks = []
  for (const workflow of ['ci.yml', 'secrets.yml']) {
    let verified
    for (let attempt = 0; attempt < 90; attempt++) {
      const runs = await github(
        `${prefix}/actions/workflows/${workflow}/runs?head_sha=${config.sha}&event=push&per_page=100`,
      )
      const run = runs.workflow_runs?.find(
        (candidate) =>
          candidate.head_sha === config.sha &&
          candidate.head_branch === 'main' &&
          candidate.event === 'push' &&
          candidate.repository?.full_name === REPOSITORY,
      )
      if (run?.status === 'completed' && run.conclusion === 'success') {
        verified = run
        break
      }
      if (!run || run.status === 'completed')
        throw new Error(`No successful ${workflow} run exists for this exact commit.`)
      await pause(10_000)
    }
    if (!verified) throw new Error(`Timed out waiting for ${workflow}.`)
    checks.push(verified)
  }
  const [ci] = checks
  if (config.environment === 'staging') {
    if (config.eventName !== 'workflow_dispatch' && ci.id !== event.workflow_run.id)
      throw new Error('The CI event does not match the verified run.')
    return ci.id
  }
  const release = await github(`${prefix}/releases/${event.release.id}`)
  if (
    release.draft ||
    release.prerelease ||
    release.tag_name !== event.release.tag_name ||
    !STABLE_TAG.test(release.tag_name || '')
  )
    throw new Error('The published release is no longer eligible for production.')
  const commit = await github(`${prefix}/commits/${encodeURIComponent(release.tag_name)}`)
  if (commit.sha !== config.sha)
    throw new Error('The release tag changed or does not identify this commit.')
  const deployments = await github(
    `${prefix}/deployments?sha=${config.sha}&environment=staging&per_page=100`,
  )
  for (const deployment of deployments) {
    const payload = deployment.payload
    if (
      deployment.sha !== config.sha ||
      deployment.environment !== 'staging' ||
      deployment.creator?.login !== 'github-actions[bot]' ||
      payload?.kind !== 'qivo-staging-v1' ||
      payload.site_revision !== config.siteSha ||
      payload.app_revision !== config.sha
    )
      continue
    const statuses = await github(`${prefix}/deployments/${deployment.id}/statuses?per_page=100`)
    // Actions and later staging runs can inactivate a successful receipt.
    // Ignore that bookkeeping, but never revive success beneath a later failure.
    if (statuses.find((status) => status.state !== 'inactive')?.state !== 'success') continue
    const run = await github(`${prefix}/actions/runs/${payload.workflow_run_id}`)
    if (
      run.conclusion === 'success' &&
      run.path === '.github/workflows/staging.yml' &&
      run.head_sha === config.sha &&
      run.head_branch === 'main' &&
      ['workflow_run', 'workflow_dispatch'].includes(run.event) &&
      run.repository?.full_name === REPOSITORY
    )
      return ci.id
  }
  throw new Error(
    'This app and website revision pair has no successful verified staging deployment.',
  )
}

export function deploymentRequest(project, sha) {
  if (!COMMIT.test(sha)) throw new Error('An exact source commit is required.')
  if (project.link?.type !== 'github' || !project.link.repoId)
    throw new Error('The deployment project must have its GitHub repository connected.')
  return {
    name: project.name,
    project: project.id,
    target: 'production',
    gitSource: { type: 'github', repoId: project.link.repoId, ref: sha, sha },
    meta: { qivoCommit: sha },
  }
}

/** Inspect every binding before any write, including nonsecret environment identity. */
export async function preflightProjects(config, fetchImpl = fetch) {
  const roles = [
    ['app', config.app, config.environment, new URL(config.origin).hostname],
    [
      'site',
      config.site,
      config.environment,
      config.environment === 'production' ? 'site-origin.qivo.io' : 'site-preview.qivo.io',
    ],
    ...(config.demo ? [['demo', config.demo, 'demo', 'demo.qivo.io']] : []),
  ]
  const prepared = {}
  for (const [role, project, identity, hostname] of roles) {
    const vercel = apiClient('https://api.vercel.com', project.token, fetchImpl)
    const scope = `teamId=${encodeURIComponent(config.team)}`
    const details = await vercel(`/v9/projects/${encodeURIComponent(project.id)}?${scope}`)
    const expectedRepo = role === 'site' ? 'qivo-internal' : 'qivo'
    if (
      details.id !== project.id ||
      details.link?.org !== 'qivo-io' ||
      details.link?.repo !== expectedRepo
    )
      throw new Error('The Vercel project is connected to an unexpected source repository.')
    if (
      role === 'site' &&
      (details.rootDirectory !== 'website' || details.sourceFilesOutsideRootDirectory !== false)
    )
      throw new Error('The website build must be confined to its website directory.')
    const domains = await vercel(`/v9/projects/${project.id}/domains?${scope}`)
    if (
      !domains.domains?.some(
        (domain) => domain.name === hostname && !domain.gitBranch && !domain.customEnvironmentId,
      ) ||
      domains.domains.some(
        (domain) =>
          domain.name.endsWith('qivo.io') &&
          domain.name !== hostname &&
          !(role === 'app' && identity === 'production' && domain.name === 'www.qivo.io'),
      )
    )
      throw new Error('The Vercel project does not have the expected isolated custom domain.')
    if (config.environment === 'staging' && details.ssoProtection?.deploymentType !== 'all')
      throw new Error('Staging must protect all deployments, including custom domains.')
    const variables = await vercel(`/v10/projects/${project.id}/env?${scope}&decrypt=false`)
    const matches =
      variables.envs?.filter(
        (variable) =>
          variable.key === 'QIVO_ENVIRONMENT' && variable.target?.includes('production'),
      ) || []
    if (matches.length !== 1)
      throw new Error('The project must have one explicit environment identity.')
    const marker = await vercel(`/v1/projects/${project.id}/env/${matches[0].id}?${scope}`)
    if (marker.value !== identity)
      throw new Error('The configured project belongs to another environment.')
    prepared[role] = { vercel, details }
  }
  return prepared
}

async function deployProject(project, prepared, revision, config, { pause, log }, pins) {
  const { vercel, details } = prepared
  const scope = `teamId=${encodeURIComponent(config.team)}`
  if (pins) {
    await vercel(
      `/v10/projects/${project.id}/env?${scope}&upsert=true`,
      'POST',
      Object.entries(pins).map(([key, value]) => ({
        key,
        value,
        type: 'plain',
        target: ['production'],
      })),
    )
  }
  const created = await vercel(
    `/v13/deployments?${scope}`,
    'POST',
    deploymentRequest(details, revision),
  )
  if (!created.id) throw new Error('Vercel did not return a deployment ID.')
  log(`Started ${details.name} deployment ${created.id}.`)
  for (let attempt = 0; attempt < 180; attempt++) {
    const result = await vercel(`/v13/deployments/${created.id}?${scope}`)
    if (['ERROR', 'CANCELED'].includes(result.readyState))
      throw new Error(`${details.name} deployment failed.`)
    if (result.readyState === 'READY') {
      if ((result.gitSource?.sha || result.meta?.githubCommitSha) !== revision)
        throw new Error('The deployed source does not match the requested commit.')
      return result.id
    }
    log(`${details.name} deployment is ${result.readyState || 'pending'}.`)
    await pause(10_000)
  }
  throw new Error(`${details.name} deployment timed out.`)
}

/** Health checks perform GET requests only and never log protection-bypass credentials. */
export async function verifyPublicBuild(config, fetchImpl = fetch) {
  const read = async (path) => {
    const response = await fetchImpl(`${config.origin}${path}`, {
      headers: config.appBypass ? { 'x-vercel-protection-bypass': config.appBypass } : {},
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok)
      throw new Error(`Deployment health check ${path} returned HTTP ${response.status}.`)
    return response
  }
  const app = await (await read('/version.json')).json()
  if (app.commit !== config.sha || app.environment !== config.environment)
    throw new Error('The public app manifest does not match the approved deployment.')
  const website = await (await read('/site-version.json')).json()
  if (
    website.docs?.commit !== config.sha ||
    website.website?.commit !== config.siteSha ||
    website.environment !== config.environment
  )
    throw new Error('The proxied website does not match the approved app and website commits.')
  for (const path of ['/', '/app', '/admin', '/docs/', '/pricing/']) {
    const html = await (await read(path)).text()
    if (!/<(?:html|!doctype)/i.test(html))
      throw new Error(`Deployment health check ${path} did not return HTML.`)
    for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"#]+)"/g)) await read(match[1])
  }
  if (config.demo) {
    const response = await fetchImpl('https://demo.qivo.io/version.json', {
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error('The public demo manifest is unavailable.')
    const demo = await response.json()
    if (demo.commit !== config.sha || demo.environment !== 'demo')
      throw new Error('The public demo does not match the release commit.')
  }
}

/** The same bounded workflow deploys staging and a previously verified release. */
export async function deployEnvironment(config, event, options = {}) {
  const optionsWithDefaults = { fetchImpl: fetch, pause: sleep, log: console.log, ...options }
  const github = apiClient(
    'https://api.github.com',
    config.githubToken,
    optionsWithDefaults.fetchImpl,
  )
  const ciId = await verifyCommit(config, event, github, optionsWithDefaults.pause)
  const prepared = await preflightProjects(config, optionsWithDefaults.fetchImpl)
  const prefix = `/repos/${REPOSITORY}`
  const deployment = await github(`${prefix}/deployments`, 'POST', {
    ref: config.sha,
    environment: config.environment,
    auto_merge: false,
    required_contexts: [],
    production_environment: config.environment === 'production',
    payload: {
      kind: `qivo-${config.environment}-v1`,
      app_revision: config.sha,
      site_revision: config.siteSha,
      ci_run_id: ciId,
      workflow_run_id: config.runId,
    },
  })
  const status = (state, description) =>
    github(`${prefix}/deployments/${deployment.id}/statuses`, 'POST', {
      state,
      description,
      environment_url: config.origin,
      log_url: `https://github.com/${REPOSITORY}/actions/runs/${config.runId}`,
      // Preserve successful revision receipts when a later staging build replaces its domain.
      auto_inactive: false,
    })
  await status('in_progress', 'Deploying the exact app and website revisions.')
  try {
    await deployProject(config.site, prepared.site, config.siteSha, config, optionsWithDefaults, {
      QIVO_SOURCE_REVISION: config.sha,
      QIVO_SITE_REVISION: config.siteSha,
      SITE_ORIGIN: config.origin,
    })
    await deployProject(config.app, prepared.app, config.sha, config, optionsWithDefaults)
    if (config.demo)
      await deployProject(config.demo, prepared.demo, config.sha, config, optionsWithDefaults)
    await verifyPublicBuild(config, optionsWithDefaults.fetchImpl)
    await status('success', 'App, website, revisions and public routes verified.')
  } catch (error) {
    await status('failure', 'Deployment or verification failed. Inspect the workflow log.')
    throw error
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const config = configuration(process.env)
  const event = JSON.parse(readFileSync(required(process.env, 'GITHUB_EVENT_PATH'), 'utf8'))
  await deployEnvironment(config, event)
}
