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
 * The commit qivo.io serves now, read from its public manifest. Used only to link the
 * changes a release ships. Returns null when the manifest is unavailable.
 */
async function liveCommit(fetchImpl) {
  try {
    const response = await fetchImpl('https://qivo.io/version.json', {
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) return null
    const { commit } = await response.json()
    return /^[0-9a-f]{40}$/.test(commit || '') ? commit : null
  } catch {
    return null
  }
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

/** A link to the changes between two commits, followed by `note`, or `Unchanged` if they are the same. */
function changes(from, to, note = '') {
  if (from === to) return 'Unchanged'
  return `[Compare](https://github.com/${REPOSITORY}/compare/${from}...${to})${note}`
}

/**
 * What the owner does with the draft. It goes to the Actions run summary and the dry-run
 * log, never into the release body, because publishing keeps the body and these steps
 * stop being true once the release is published.
 */
export const DRAFT_STEPS =
  "Review the draft's commit on https://preview.qivo.io, then publish the draft. " +
  "Do not change the draft's tag or target. To ship something else, run Prepare release " +
  'again. It replaces the draft.'

/**
 * The first section of the release body. Publishing keeps the body, so it holds only facts
 * that stay true afterwards; the steps for the draft are in DRAFT_STEPS. Changes are
 * linked from the commit production serves. If qivo.io does not report it, the link
 * starts at the previous version tag instead.
 */
export function releaseHeader({ appSha, stagedAt, stagingRunId, previousTag, productionApp }) {
  const commit = `[\`${short(appSha)}\`](https://github.com/${REPOSITORY}/commit/${appSha})`
  const changed = productionApp
    ? changes(productionApp, appSha)
    : previousTag
      ? changes(previousTag, appSha, ` (since ${previousTag})`)
      : 'First release'
  return [
    '## What publishing ships',
    '',
    `Publishing this release deploys commit ${commit} to https://qivo.io, including the ` +
      'website and docs, and to https://demo.qivo.io.',
    '',
    `Changes since production: ${changed}`,
    '',
    `Deploy staging verified this commit on https://preview.qivo.io at ${new Date(stagedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC ` +
      `([staging run](https://github.com/${REPOSITORY}/actions/runs/${stagingRunId})).`,
  ].join('\n')
}

/**
 * Create (or with dryRun, describe) the draft. Throws with an explanation when staging has
 * not verified main or the version is unusable. Then deletes the older drafts this workflow
 * created, because each targets an older commit and publishing it later would deploy that
 * commit. They are kept if the new draft cannot be created. With `summaryFile` (the Actions
 * run summary), it appends the draft link, DRAFT_STEPS and the header there as soon as the
 * draft exists, so the owner gets the steps even if removing an older draft then fails.
 */
export async function prepareRelease({
  github,
  requestedVersion,
  dryRun = false,
  log = console.log,
  fetchImpl = fetch,
  summaryFile,
}) {
  const main = (await github(`${prefix}/commits/main`)).sha
  const receipt = await findStagingReceipt(github, { sha: main })
  if (!receipt)
    throw new Error(
      `preview.qivo.io does not serve main ${short(main)} yet. Wait until Deploy staging passes ` +
        'for it, or fix the failure, then run Prepare release again.',
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

  const productionApp = await liveCommit(fetchImpl)
  const previousTag = await notesBase(github, tags, productionApp)
  const body = releaseHeader({
    appSha: main,
    stagedAt: receipt.succeededAt,
    stagingRunId: receipt.runId,
    previousTag,
    productionApp,
  })
  const plan = { version, appSha: main, previousTag }
  if (dryRun) {
    log(
      `Dry run. Would prepare ${version}${staleDrafts.length ? ` and delete ${staleDrafts.length} older draft(s)` : ''}.`,
    )
    log(body)
    log('The run summary would link the draft, give these steps and repeat the section above.')
    log(DRAFT_STEPS)
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
  if (summaryFile)
    appendFileSync(
      summaryFile,
      `Draft release [${version}](${draft.html_url}) is ready. ${DRAFT_STEPS}\n\n${body}\n`,
    )
  for (const stale of staleDrafts) {
    await github(`${prefix}/releases/${stale.id}`, 'DELETE')
    log(`Deleted the older draft ${stale.tag_name} (${stale.id}).`)
  }
  return { ...plan, url: draft.html_url }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN is required.')
  await prepareRelease({
    github: apiClient('https://api.github.com', process.env.GH_TOKEN),
    requestedVersion: process.env.QIVO_RELEASE_VERSION,
    dryRun: process.argv.includes('--dry-run'),
    summaryFile: process.env.GITHUB_STEP_SUMMARY,
  })
}
