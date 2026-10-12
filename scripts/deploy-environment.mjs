#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const COMMIT = /^[0-9a-f]{40}$/
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const REPOSITORY = 'qivo-io/qivo'
const ACTIONS_BOT = 'github-actions[bot]'
const STAGING_RECEIPT = 'qivo-staging-v1'
const RUN_ID = /^[1-9]\d*$/
// Commits without this file predate the website moving into this repository. Their
// vercel.json proxies the website to a separate project that releases no longer deploy.
const WEBSITE_ENTRY = 'website/index.html'

const required = (env, key) => {
  if (!env[key]) throw new Error(`${key} must be configured for this GitHub environment.`)
  return env[key]
}

/** Order stable release tags such as v1.10.0 after v1.9.2. */
export function compareVersions(left, right) {
  const parse = (tag) => {
    const match = STABLE_TAG.exec(tag)
    if (!match) throw new Error(`${tag} is not a stable vMAJOR.MINOR.PATCH tag.`)
    return match.slice(1).map(Number)
  }
  const [a, b] = [parse(left), parse(right)]
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/**
 * Configuration contains identifiers and project-scoped tokens, never backend credentials.
 * The website is part of the application build. Older deploy.yml files still pass
 * QIVO_SITE_REVISION and the separate website project's VERCEL_SITE_* values, so those
 * are ignored rather than rejected.
 */
export function configuration(env) {
  const environment = required(env, 'QIVO_ENVIRONMENT')
  if (!['staging', 'production'].includes(environment))
    throw new Error('Invalid deployment environment.')
  if (env.GITHUB_REPOSITORY !== REPOSITORY)
    throw new Error('Only the upstream repository may deploy.')
  const sha = required(env, 'QIVO_COMMIT')
  if (!COMMIT.test(sha)) throw new Error('The application revision must be a full commit SHA.')
  const origin = required(env, 'QIVO_APP_ORIGIN')
  if (origin !== (environment === 'production' ? 'https://qivo.io' : 'https://preview.qivo.io'))
    throw new Error('The app origin does not match the deployment environment.')
  const app = {
    id: required(env, 'VERCEL_APP_PROJECT_ID'),
    token: required(env, 'VERCEL_APP_TOKEN'),
  }
  const demo =
    environment === 'production'
      ? { id: required(env, 'VERCEL_DEMO_PROJECT_ID'), token: required(env, 'VERCEL_DEMO_TOKEN') }
      : null
  if (demo && demo.id === app.id) throw new Error('Application and demo projects must be separate.')
  return {
    environment,
    sha,
    origin,
    app,
    demo,
    team: required(env, 'VERCEL_TEAM_ID'),
    githubToken: required(env, 'GH_TOKEN'),
    appBypass: env.VERCEL_APP_PROTECTION_BYPASS,
    runId: required(env, 'GITHUB_RUN_ID'),
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT || 1),
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
      !release.published_at ||
      event.sender?.type !== 'User'
    )
      throw new Error('Production requires a manually published stable release.')
  } else {
    // A manual run restages current main, for example after a provider failure.
    if (config.eventName === 'workflow_dispatch') {
      if (config.ref !== 'refs/heads/main')
        throw new Error('Manual staging runs must use the main workflow.')
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

/**
 * A JSON client for one provider. `allowMissing` turns a 404 on a GET into null for
 * existence checks; every other failure throws.
 */
export function apiClient(base, token, fetchImpl = fetch) {
  return async (path, method = 'GET', body, { allowMissing = false } = {}) => {
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
    if (allowMissing && method === 'GET' && response.status === 404) return null
    // Provider errors can contain environment values. Keep error output to status and endpoint.
    if (!response.ok) throw new Error(`${method} ${url.pathname} returned HTTP ${response.status}.`)
    return response.status === 204 ? null : response.json()
  }
}

/** Every stable version tag. Unlike releases, these tags cannot be moved or deleted. */
export async function stableTags(github) {
  // This endpoint returns every match at once and ignores paging parameters.
  const refs = await github(`/repos/${REPOSITORY}/git/matching-refs/tags/v`)
  return refs
    .map(({ ref }) => ref.replace(/^refs\/tags\//, ''))
    .filter((tag) => STABLE_TAG.test(tag))
}

/** Every release this token can see. Drafts are visible only to tokens with write access. */
export async function listReleases(github) {
  const releases = []
  for (let page = 1; page <= 10; page++) {
    const batch = await github(`/repos/${REPOSITORY}/releases?per_page=100&page=${page}`)
    releases.push(...batch)
    if (batch.length < 100) break
  }
  return releases
}

/**
 * The run and attempt a record names, as plain positive numbers, or null. GitHub also
 * accepts forms such as "01", so only the canonical form is looked up. Records written
 * before attempts were recorded all came from first attempts.
 */
function namedAttempt(payload) {
  const run = String(payload?.workflow_run_id ?? '')
  const attempt = payload?.workflow_run_attempt ?? 1
  if (!RUN_ID.test(run) || !Number.isSafeInteger(attempt) || attempt < 1) return null
  return { run: Number(run), attempt }
}

/**
 * The newest successful staging record for one commit, which proves staging served it on
 * preview.qivo.io. Only records this workflow wrote during a successful main staging run
 * attempt count, and a later failure or error status on the same record withdraws it.
 * `before` limits the search to records that succeeded before a release was published.
 * `ciRunId` ties the record to the verified CI run.
 *
 * Anyone who can write to the repository can create deployment records. A record and its
 * success status must therefore fall inside the run attempt it names. A record whose run
 * was deleted cannot be checked and is skipped.
 */
export async function findStagingReceipt(github, { sha, before, ciRunId }) {
  const prefix = `/repos/${REPOSITORY}`
  const receipts = (
    await github(`${prefix}/deployments?sha=${sha}&environment=staging&per_page=100`)
  ).filter(
    (deployment) =>
      deployment.sha === sha &&
      deployment.environment === 'staging' &&
      deployment.creator?.login === ACTIONS_BOT &&
      deployment.payload?.kind === STAGING_RECEIPT,
  )
  const candidates = []
  for (const deployment of receipts) {
    const payload = deployment.payload
    const attempt = namedAttempt(payload)
    if (
      !attempt ||
      payload.app_revision !== sha ||
      (ciRunId !== undefined && Number(payload.ci_run_id) !== Number(ciRunId))
    )
      continue
    const statuses = await github(`${prefix}/deployments/${deployment.id}/statuses?per_page=100`)
    // Actions and later staging runs can inactivate a successful receipt.
    // Ignore that bookkeeping, but never revive success beneath a later failure.
    const latest = statuses
      .filter((status) => status.state !== 'inactive')
      .sort((a, b) => b.id - a.id)[0]
    if (latest?.state !== 'success' || latest.creator?.login !== ACTIONS_BOT) continue
    const succeededAt = Date.parse(latest.created_at)
    if (!Number.isFinite(succeededAt)) continue
    if (before !== undefined && succeededAt > Date.parse(before)) continue
    candidates.push({ deployment, attempt, succeededAt })
  }
  candidates.sort((a, b) => b.succeededAt - a.succeededAt)
  for (const { deployment, attempt, succeededAt } of candidates) {
    // A later re-run of the run does not change a recorded attempt's result.
    const run = await github(
      `${prefix}/actions/runs/${attempt.run}/attempts/${attempt.attempt}`,
      'GET',
      undefined,
      { allowMissing: true },
    )
    if (!run) continue
    const opened = Date.parse(run.run_started_at)
    const closed = Date.parse(run.updated_at)
    const created = Date.parse(deployment.created_at)
    if (
      run.run_attempt === attempt.attempt &&
      run.conclusion === 'success' &&
      run.path === '.github/workflows/staging.yml' &&
      run.head_sha === sha &&
      run.head_branch === 'main' &&
      ['workflow_run', 'workflow_dispatch'].includes(run.event) &&
      run.repository?.full_name === REPOSITORY &&
      created >= opened &&
      created <= closed &&
      succeededAt >= opened &&
      succeededAt <= closed
    )
      return {
        id: deployment.id,
        runId: attempt.run,
        runAttempt: attempt.attempt,
        succeededAt,
      }
  }
  return null
}

/**
 * Check CI, the trigger and, for production, the release and its staging record. Returns
 * the verified CI run and, for production, the staging record.
 */
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
    return { ciId: ci.id }
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
  const website = await github(
    `${prefix}/contents/${WEBSITE_ENTRY}?ref=${config.sha}`,
    'GET',
    undefined,
    { allowMissing: true },
  )
  if (!website)
    throw new Error(
      'This commit is from before the website moved into this repository. Its website comes ' +
        'from the separate qivo-site project, which releases no longer deploy or verify. ' +
        'Publish a version that targets a newer commit.',
    )
  // Re-running an old release, or republishing one, must not roll production back.
  // Version tags are compared because, unlike releases, they cannot be deleted.
  const newest = (await stableTags(github)).concat(release.tag_name).sort(compareVersions).at(-1)
  if (newest !== release.tag_name)
    throw new Error(
      `${newest} is newer than ${release.tag_name}. Only the newest version can deploy ` +
        'production. To roll back, publish a new, higher version that targets the older commit.',
    )
  const receipt = await findStagingReceipt(github, {
    sha: config.sha,
    before: event.release.published_at,
    ciRunId: ci.id,
  })
  if (!receipt) {
    const later = await findStagingReceipt(github, { sha: config.sha, ciRunId: ci.id })
    throw new Error(
      (later
        ? 'Staging passed for this commit only after the release was published.'
        : 'This commit has no successful staging deployment.') +
        ' Re-running this release cannot change that. After Deploy staging passes, publish a ' +
        'new, higher version. Prepare release does this for the current main commit.',
    )
  }
  return { ciId: ci.id, stagingReceiptId: receipt.id }
}

function linkedRepository(project) {
  if (project.link?.type !== 'github' || !project.link.repoId)
    throw new Error('The deployment project must have its GitHub repository connected.')
  return project.link.repoId
}

/** A deployment of one exact commit. Production always uses this form. */
export function deploymentRequest(project, sha) {
  if (!COMMIT.test(sha)) throw new Error('An exact source commit is required.')
  return {
    name: project.name,
    project: project.id,
    target: 'production',
    gitSource: { type: 'github', repoId: linkedRepository(project), ref: sha, sha },
    meta: { qivoCommit: sha },
  }
}

/** The one exact commit a Vercel deployment built. */
export function builtCommit(deployment) {
  const commits = [deployment.gitSource?.sha, deployment.meta?.githubCommitSha].filter(Boolean)
  if (!commits.length || !COMMIT.test(commits[0]) || commits.some((item) => item !== commits[0]))
    throw new Error('Vercel did not report one exact built commit.')
  return commits[0]
}

/**
 * Vercel's deployment policy is what stops Git pushes from deploying. Every enabled rule
 * for the production target must allow only REST API deployments.
 */
export function restApiOnly(project) {
  const rules = (project.deploymentPolicy?.deploymentSources || []).filter(
    (rule) =>
      rule.enabled &&
      rule.environments?.some(
        (environment) => environment.type === 'system' && environment.target === 'production',
      ),
  )
  return (
    rules.length > 0 &&
    rules.every((rule) => rule.sources?.length === 1 && rule.sources[0] === 'rest-api')
  )
}

/** Inspect every binding before any write, including nonsecret environment identity. */
export async function preflightProjects(config, fetchImpl = fetch) {
  const roles = [
    ['app', config.app, config.environment, new URL(config.origin).hostname],
    ...(config.demo ? [['demo', config.demo, 'demo', 'demo.qivo.io']] : []),
  ]
  const prepared = {}
  for (const [role, project, identity, hostname] of roles) {
    const vercel = apiClient('https://api.vercel.com', project.token, fetchImpl)
    const scope = `teamId=${encodeURIComponent(config.team)}`
    const details = await vercel(`/v9/projects/${encodeURIComponent(project.id)}?${scope}`)
    if (
      details.id !== project.id ||
      details.link?.org !== 'qivo-io' ||
      details.link?.repo !== 'qivo'
    )
      throw new Error('The Vercel project is connected to an unexpected source repository.')
    if (!restApiOnly(details))
      throw new Error('The Vercel project must accept production deployments only through the API.')
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

/** Deploy one project at the exact commit and wait until it serves. */
async function deployProject(project, prepared, revision, config, { pause, log }) {
  const { vercel, details } = prepared
  const scope = `teamId=${encodeURIComponent(config.team)}`
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
      if (builtCommit(result) !== revision)
        throw new Error('The deployed source does not match the requested commit.')
      return
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
  for (const path of ['/', '/app', '/admin', '/docs/', '/pricing/']) {
    const html = await (await read(path)).text()
    if (!/<(?:html|!doctype)/i.test(html))
      throw new Error(`Deployment health check ${path} did not return HTML.`)
    // The website must have been built for this environment's origin.
    if (path === '/' && !html.includes(`<link rel="canonical" href="${config.origin}/"`))
      throw new Error('The website was not built for this environment.')
    for (const match of html.matchAll(/(?:src|href)="(\/(?:assets|marketing)\/[^"#]+)"/g))
      await read(match[1])
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

/** A GitHub deployment record ("receipt") naming the exact commit. */
async function createReceipt(github, config, payload) {
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
      workflow_run_id: config.runId,
      workflow_run_attempt: config.runAttempt,
      ...payload,
    },
  })
  return (state, description) =>
    github(`${prefix}/deployments/${deployment.id}/statuses`, 'POST', {
      state,
      description,
      environment_url: config.origin,
      log_url: `https://github.com/${REPOSITORY}/actions/runs/${config.runId}`,
      // Preserve successful revision receipts when a later staging build replaces its domain.
      auto_inactive: false,
    })
}

/**
 * Staging deploys current main and records it only after it serves correctly. Production
 * deploys a release commit that staging recorded. Neither path seeds, resets or migrates
 * data.
 */
export async function deployEnvironment(config, event, options = {}) {
  const optionsWithDefaults = { fetchImpl: fetch, pause: sleep, log: console.log, ...options }
  const { log } = optionsWithDefaults
  const github = apiClient(
    'https://api.github.com',
    config.githubToken,
    optionsWithDefaults.fetchImpl,
  )
  const verified = await verifyCommit(config, event, github, optionsWithDefaults.pause)
  const prepared = await preflightProjects(config, optionsWithDefaults.fetchImpl)

  if (config.environment === 'staging') {
    // A failed run records nothing, so a release can never pick up an unverified commit.
    await deployProject(config.app, prepared.app, config.sha, config, optionsWithDefaults)
    await verifyPublicBuild(config, optionsWithDefaults.fetchImpl)
    const status = await createReceipt(github, config, { ci_run_id: verified.ciId })
    await status('success', 'App, website, revision and public routes verified.')
    log(`Staged ${config.sha} on ${config.origin}.`)
    return
  }

  const status = await createReceipt(github, config, {
    ci_run_id: verified.ciId,
    staging_receipt_id: verified.stagingReceiptId,
  })
  await status('in_progress', 'Deploying the exact revision.')
  try {
    await deployProject(config.app, prepared.app, config.sha, config, optionsWithDefaults)
    if (config.demo)
      await deployProject(config.demo, prepared.demo, config.sha, config, optionsWithDefaults)
    await verifyPublicBuild(config, optionsWithDefaults.fetchImpl)
    await status('success', 'App, website, revision and public routes verified.')
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
