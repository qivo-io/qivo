#!/usr/bin/env node
/* Prepare a draft GitHub Release for exactly what preview.qivo.io serves.
 *
 * The draft targets the current main commit, which must have passed Deploy staging.
 * Publishing the draft is the separate, manual production step. With --dry-run the
 * script only reads and prints the plan, so it is safe to run locally with any token
 * that can read the repository. */
import { appendFileSync } from 'node:fs'
import {
  apiClient,
  compareVersions,
  findStagingReceipt,
  listReleases,
  stableTags,
} from './deploy-environment.mjs'

const REPOSITORY = 'qivo-io/qivo'
const SITE_REPOSITORY = 'qivo-io/qivo-internal'
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const ACTIONS_BOT = 'github-actions[bot]'
const prefix = `/repos/${REPOSITORY}`
const short = (sha) => sha.slice(0, 7)

/** Returns the requested version, or the next patch after the newest version tag. */
export function nextVersion(requested, newestTag) {
  const version = requested?.trim() || ''
  if (version) {
    if (!STABLE_TAG.test(version))
      throw new Error(`${version} is not a stable version. Use the form v1.2.3.`)
    if (newestTag && compareVersions(version, newestTag) <= 0)
      throw new Error(`${version} must be newer than the latest version ${newestTag}.`)
    return version
  }
  if (!newestTag) return 'v0.1.0'
  const [major, minor, patch] = STABLE_TAG.exec(newestTag).slice(1).map(Number)
  return `v${major}.${minor}.${patch + 1}`
}

/**
 * The app and website commits qivo.io serves now, read from its public manifests. Used
 * only to link the changes a release ships. Each is null when its manifest is unavailable.
 */
async function liveCommits(fetchImpl) {
  const read = async (path, pick) => {
    try {
      const response = await fetchImpl(`https://qivo.io${path}`, {
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) return null
      const commit = pick(await response.json())
      return /^[0-9a-f]{40}$/.test(commit || '') ? commit : null
    } catch {
      return null
    }
  }
  const [app, site] = await Promise.all([
    read('/version.json', (manifest) => manifest.commit),
    read('/site-version.json', (manifest) => manifest.website?.commit),
  ])
  return { app, site }
}

/**
 * The newest version tag on the app commit production serves, so the generated notes
 * include releases that were published but never deployed. Falls back to the newest tag.
 */
async function notesBase(github, tags, productionApp) {
  if (productionApp)
    for (const tag of tags.toReversed())
      if ((await github(`${prefix}/commits/${tag}`)).sha === productionApp) return tag
  return tags.at(-1)
}

/**
 * Staging runs of the main commit that are unfinished, or that started after the
 * recorded pair was verified, including re-runs of older runs. A failed or running
 * restage may already have replaced the website preview shows. A restage that passed
 * would have recorded a newer pair instead.
 */
async function unsettledStagingRuns(github, main, receipt) {
  const { workflow_runs: runs = [] } = await github(
    `${prefix}/actions/workflows/staging.yml/runs?head_sha=${main}&per_page=50`,
  )
  return runs.filter(
    (run) =>
      run.conclusion !== 'skipped' &&
      (run.status !== 'completed' || Date.parse(run.run_started_at) > receipt.succeededAt),
  )
}

/** A link to the changes between two commits, followed by `note`, or why there is none. */
function changes(repository, from, to, note = '') {
  if (!from) return 'Not recorded'
  if (from === to) return 'Unchanged'
  return `[Compare](https://github.com/${repository}/compare/${from}...${to})${note}`
}

/**
 * The explanation at the top of the draft. It must stay accurate for the owner. Changes are
 * linked from the commits production serves. If qivo.io does not report its app commit,
 * the app link starts at the previous version tag instead.
 */
export function releaseHeader({
  appSha,
  siteSha,
  stagedAt,
  stagingRunId,
  previousTag,
  productionApp,
  productionSite,
}) {
  const appLink = `[\`${short(appSha)}\`](https://github.com/${REPOSITORY}/commit/${appSha})`
  const siteLink = `[\`${short(siteSha)}\`](https://github.com/${SITE_REPOSITORY}/commit/${siteSha})`
  const appChanges = productionApp
    ? changes(REPOSITORY, productionApp, appSha)
    : previousTag
      ? changes(REPOSITORY, previousTag, appSha, ` (since ${previousTag})`)
      : 'First release'
  const siteChanges = changes(SITE_REPOSITORY, productionSite, siteSha, ' (private repository)')
  return [
    '## What publishing ships',
    '',
    'Publishing this release deploys these commits to https://qivo.io and https://demo.qivo.io.',
    '',
    '| Part | Commit | Changes since production |',
    '| --- | --- | --- |',
    `| App, docs and demo | ${appLink} | ${appChanges} |`,
    `| Website | ${siteLink} | ${siteChanges} |`,
    '',
    `Deploy staging verified this pair on https://preview.qivo.io at ${new Date(stagedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC ` +
      `([staging run](https://github.com/${REPOSITORY}/actions/runs/${stagingRunId})). ` +
      'Review it there before you publish. If the website is staged again for this app commit ' +
      'before you publish, the newer website ships instead. If a later Deploy staging run fails, ' +
      'preview may show a website that will not ship, so run Prepare release again.',
    '',
    "Do not change this draft's tag or target. To ship something else, delete this draft and run Prepare release again.",
  ].join('\n')
}

/**
 * Create (or with dryRun, describe) the draft. Throws with an explanation when staging has
 * not verified main or the version is unusable. Then deletes the older drafts this workflow
 * created, because each targets an older commit and publishing it later would deploy that
 * commit. They are kept if the new draft cannot be created.
 */
export async function prepareRelease({
  github,
  requestedVersion,
  dryRun = false,
  log = console.log,
  fetchImpl = fetch,
}) {
  const main = (await github(`${prefix}/commits/main`)).sha
  const receipt = await findStagingReceipt(github, { sha: main })
  if (!receipt)
    throw new Error(
      `preview.qivo.io does not serve main ${short(main)} yet. Wait until Deploy staging passes ` +
        'for it, or fix the failure, then run Prepare release again.',
    )
  const unsettled = await unsettledStagingRuns(github, main, receipt)
  if (unsettled.length)
    throw new Error(
      `A newer Deploy staging run for main ${short(main)} is still running or did not pass ` +
        `(${unsettled[0].html_url}), so preview.qivo.io may show a website that staging has not ` +
        'verified. Wait for it, or run Deploy staging again, then run Prepare release again.',
    )
  const tags = (await stableTags(github)).sort(compareVersions)
  const newestTag = tags.at(-1)
  const version = nextVersion(requestedVersion, newestTag)
  if (await github(`${prefix}/git/ref/tags/${version}`, 'GET', undefined, { allowMissing: true }))
    throw new Error(`The tag ${version} already exists. Choose a newer version.`)
  const releases = await listReleases(github)
  const sameVersion = releases.filter((item) => item.tag_name === version)
  if (sameVersion.some((item) => !item.draft))
    throw new Error(`A published release ${version} already exists. Choose a newer version.`)
  if (sameVersion.some((item) => item.author?.login !== ACTIONS_BOT))
    throw new Error(
      `A draft ${version} made by a person exists. Delete it or choose another version.`,
    )
  const staleDrafts = releases.filter((item) => item.draft && item.author?.login === ACTIONS_BOT)
  const otherDrafts = releases.filter((item) => item.draft && item.author?.login !== ACTIONS_BOT)
  for (const draft of otherDrafts)
    log(
      `Warning: draft ${draft.tag_name} made by a person also exists. Publishing it deploys ` +
        'its own commit. Delete drafts you will not publish.',
    )

  const production = await liveCommits(fetchImpl)
  const previousTag = await notesBase(github, tags, production.app)
  const body = releaseHeader({
    appSha: main,
    siteSha: receipt.siteSha,
    stagedAt: receipt.succeededAt,
    stagingRunId: receipt.runId,
    previousTag,
    productionApp: production.app,
    productionSite: production.site,
  })
  const plan = { version, appSha: main, siteSha: receipt.siteSha, previousTag }
  if (dryRun) {
    log(
      `Dry run. Would prepare ${version}${staleDrafts.length ? ` and delete ${staleDrafts.length} older draft(s)` : ''}.`,
    )
    log(body)
    return plan
  }

  const notes = await github(`${prefix}/releases/generate-notes`, 'POST', {
    tag_name: version,
    target_commitish: main,
    ...(previousTag ? { previous_tag_name: previousTag } : {}),
  })
  // GitHub allows several drafts with one tag name, so the new draft can exist before the
  // older ones are removed.
  const draft = await github(`${prefix}/releases`, 'POST', {
    tag_name: version,
    target_commitish: main,
    name: version,
    body: `${body}\n\n${notes.body}`,
    draft: true,
    prerelease: false,
  })
  log(`Prepared draft ${version}: ${draft.html_url}`)
  for (const stale of staleDrafts) {
    await github(`${prefix}/releases/${stale.id}`, 'DELETE')
    log(`Deleted the older draft ${stale.tag_name} (${stale.id}).`)
  }
  return { ...plan, url: draft.html_url, body }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN is required.')
  const plan = await prepareRelease({
    github: apiClient('https://api.github.com', process.env.GH_TOKEN),
    requestedVersion: process.env.QIVO_RELEASE_VERSION,
    dryRun: process.argv.includes('--dry-run'),
  })
  if (process.env.GITHUB_STEP_SUMMARY && plan.url)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Draft release [${plan.version}](${plan.url}) is ready. Open it, check preview.qivo.io, then publish.\n\n${plan.body}\n`,
    )
}
