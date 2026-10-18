#!/usr/bin/env node
/* Start CI (.github/workflows/reviewed-ci.yml) builds one pull request commit after its
 * reviews are finished, then publishes the `reviewed-ci` status that branch protection
 * requires. The workflow runs this file from main in two jobs that never run pull
 * request code:
 *
 * - `authorize` checks the caller, the commit, the reviews and the branch. It then marks
 *   the commit's status pending and lets the unprivileged build start.
 * - `report` checks that every required build job succeeded and checks everything again
 *   before it marks the status successful. Anything else ends as failure or error, so an
 *   interrupted run never leaves a success behind.
 *
 * `check` runs the same checks locally and read-only. A run dispatched from a branch other
 * than main publishes `reviewed-ci (rehearsal)`, which branch protection ignores, so a
 * changed workflow can be tested before it merges. Reviewer-specific parsing is in
 * review-evidence.mjs. */
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { apiClient } from './deploy-environment.mjs'
import { REVIEWERS } from './review-evidence.mjs'

const REPOSITORY = 'qivo-io/qivo'
const WORKFLOW = '.github/workflows/reviewed-ci.yml'
const ACTIONS_BOT = 'github-actions[bot]'
const COMMIT = /^[0-9a-f]{40}$/
const NUMBER = /^[1-9]\d{0,9}$/
const WRITERS = new Set(['admin', 'maintain', 'write'])
const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending'])
const prefix = `/repos/${REPOSITORY}`
const short = (sha) => sha.slice(0, 7)

/** The status context branch protection requires. Rehearsals use a context it ignores. */
export const CONTEXT = 'reviewed-ci'
export const REHEARSAL_CONTEXT = 'reviewed-ci (rehearsal)'

/**
 * Jobs of a Start CI run that must all succeed, named as the jobs API reports them. A
 * renamed, skipped, cancelled or missing job fails the run. Update this list together
 * with the workflow.
 */
export const REQUIRED_JOBS = ['Build and test / quality']

/** The run name the workflow gives every Start CI run. */
export const runName = (pr, sha) => `Start CI for #${pr} at ${sha}`

/** Settings from the Actions environment. Throws before any API call when one is wrong. */
export function configuration(env) {
  const need = (key) => {
    if (!env[key]) throw new Error(`${key} is required.`)
    return env[key]
  }
  if (need('GITHUB_REPOSITORY') !== REPOSITORY)
    throw new Error('Start CI runs only in the upstream repository.')
  if (need('GITHUB_EVENT_NAME') !== 'workflow_dispatch')
    throw new Error('Start CI runs only when dispatched.')
  const ref = need('GITHUB_REF')
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ''
  if (!branch) throw new Error('Dispatch Start CI from a branch.')
  if (need('GITHUB_WORKFLOW_REF') !== `${REPOSITORY}/${WORKFLOW}@${ref}`)
    throw new Error(`This script runs only inside ${WORKFLOW}.`)
  const pr = need('QIVO_PR')
  const sha = need('QIVO_SHA')
  if (!NUMBER.test(pr)) throw new Error('The pull request number must be a positive integer.')
  if (!COMMIT.test(sha)) throw new Error('The commit must be a full 40-character SHA.')
  const runId = need('GITHUB_RUN_ID')
  if (!NUMBER.test(runId)) throw new Error('GITHUB_RUN_ID is not a run ID.')
  return {
    pr: Number(pr),
    sha,
    branch,
    context: branch === 'main' ? CONTEXT : REHEARSAL_CONTEXT,
    actor: env.GITHUB_TRIGGERING_ACTOR || need('GITHUB_ACTOR'),
    runId: Number(runId),
    runAttempt: Number(need('GITHUB_RUN_ATTEMPT')),
    runUrl: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
    token: need('GH_TOKEN'),
  }
}

/** Every item of a REST list endpoint, read 100 at a time. `key` names a wrapped list. */
async function list(github, path, key) {
  const items = []
  for (let page = 1; page <= 20; page++) {
    const separator = path.includes('?') ? '&' : '?'
    const body = await github(`${path}${separator}per_page=100&page=${page}`)
    const batch = key ? body[key] : body
    items.push(...batch)
    if (batch.length < 100) return items
  }
  throw new Error(`${path} returned more than 2000 items.`)
}

/** A login in REST form, so GraphQL bots read `coderabbitai[bot]` as in REST. */
const login = (actor) =>
  actor ? (actor.__typename === 'Bot' ? `${actor.login}[bot]` : actor.login) : 'ghost'

const PULL_REQUEST = `query($owner: String!, $name: String!, $number: Int!, $comments: String, $threads: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state isDraft headRefOid baseRefName
      baseRepository { nameWithOwner }
      latestOpinionatedReviews(first: 100) { nodes { state author { login __typename } } }
      comments(first: 100, after: $comments) {
        pageInfo { hasNextPage endCursor }
        nodes { url body author { login __typename } editor { login __typename } }
      }
      reviewThreads(first: 100, after: $threads) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved path comments(first: 1) { nodes { url author { login __typename } } } }
      }
    }
  }
}`

/** The pull request's state, conversation comments, review threads and formal reviews. */
export async function pullRequest(github, number) {
  const [owner, name] = REPOSITORY.split('/')
  const comments = []
  const threads = []
  const cursors = { comments: null, threads: null }
  let pull
  for (let page = 0; page < 20; page++) {
    const response = await github('/graphql', 'POST', {
      query: PULL_REQUEST,
      variables: { owner, name, number, ...cursors },
    })
    if (response.errors?.length) throw new Error('GitHub could not read the pull request.')
    pull = response.data?.repository?.pullRequest
    if (!pull) return null
    comments.push(
      ...pull.comments.nodes.map((node) => ({
        url: node.url,
        body: node.body,
        author: login(node.author),
        editor: node.editor ? login(node.editor) : null,
      })),
    )
    threads.push(
      ...pull.reviewThreads.nodes.map((node) => ({
        resolved: node.isResolved,
        path: node.path,
        url: node.comments.nodes[0]?.url,
        author: login(node.comments.nodes[0]?.author),
      })),
    )
    const more = { comments: pull.comments.pageInfo, threads: pull.reviewThreads.pageInfo }
    if (!more.comments.hasNextPage && !more.threads.hasNextPage)
      return {
        state: pull.state,
        draft: pull.isDraft,
        head: pull.headRefOid,
        base: pull.baseRefName,
        baseRepository: pull.baseRepository?.nameWithOwner,
        opinions: pull.latestOpinionatedReviews.nodes.map((node) => ({
          state: node.state,
          author: login(node.author),
        })),
        comments,
        threads,
      }
    // Asking for more after a finished connection's last cursor returns nothing, and an
    // empty page has no cursor, so each connection keeps the last cursor it returned.
    cursors.comments = more.comments.endCursor ?? cursors.comments
    cursors.threads = more.threads.endCursor ?? cursors.threads
  }
  throw new Error('The pull request has too many comments or threads to check.')
}

/**
 * Whether `sha` may get CI now, and why not. Checks the caller's access, that `sha` is the
 * open pull request's head on main and contains main, that every required reviewer
 * finished reviewing `sha`, that every review thread is resolved and that no reviewer
 * requests changes. Returns `{ problems, reviews, pull }`; ready means no problems.
 */
export async function eligibility(github, { pr, sha, actor }) {
  const problems = []
  const permission = await github(
    `${prefix}/collaborators/${encodeURIComponent(actor)}/permission`,
    'GET',
    undefined,
    { allowMissing: true },
  )
  if (!WRITERS.has(permission?.role_name))
    problems.push(`${actor} does not have write access to ${REPOSITORY}.`)
  const pull = await pullRequest(github, pr)
  if (!pull) return { problems: [...problems, `Pull request #${pr} does not exist.`], reviews: [] }
  if (pull.state !== 'OPEN') problems.push(`Pull request #${pr} is ${pull.state.toLowerCase()}.`)
  if (pull.draft) problems.push('The pull request is a draft. Mark it ready for review first.')
  if (pull.base !== 'main' || pull.baseRepository !== REPOSITORY)
    problems.push('Start CI only builds pull requests into main.')
  if (pull.head !== sha) {
    problems.push(
      `The pull request head is ${short(pull.head)}, not ${short(sha)}. Finish reviewing ` +
        'the new commit, then start CI for it.',
    )
    return { problems, reviews: [], pull }
  }

  const main = (await github(`${prefix}/git/ref/heads/main`)).object.sha
  const comparison = await github(`${prefix}/compare/${main}...${sha}`)
  if (comparison.behind_by !== 0)
    problems.push(
      `${short(sha)} is ${comparison.behind_by} commit(s) behind main ${short(main)}. Update ` +
        'the branch. The new commit then needs finished reviews before CI.',
    )

  const [statuses, checkRuns] = await Promise.all([
    list(github, `${prefix}/commits/${sha}/statuses`),
    list(github, `${prefix}/commits/${sha}/check-runs`, 'check_runs'),
  ])
  const reviews = REVIEWERS.map((reviewer) =>
    reviewer({ sha, statuses, checkRuns, comments: pull.comments }),
  )
  for (const review of reviews.filter((item) => !item.complete))
    problems.push(`${review.name} ${review.reason}.`)

  const open = pull.threads.filter((thread) => !thread.resolved)
  if (open.length)
    problems.push(
      `${open.length} review thread(s) are unresolved: ` +
        open.map((thread) => `${thread.path} by ${thread.author} (${thread.url})`).join(', '),
    )
  for (const opinion of pull.opinions.filter((item) => item.state === 'CHANGES_REQUESTED'))
    problems.push(`${opinion.author} requests changes.`)
  return { problems, reviews, pull }
}

/** The newest status for `context` that Actions wrote on `sha`, or undefined. */
export async function latestStatus(github, sha, context) {
  return (await list(github, `${prefix}/commits/${sha}/statuses`))
    .filter((status) => status.context === context && status.creator?.login === ACTIONS_BOT)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0]
}

/**
 * The first attempt of the Start CI run `status` links to, when it is a run of this
 * workflow on `branch` for the same pull request and commit and it wrote the status while
 * it ran. Otherwise null. Only first attempts publish statuses.
 */
export async function linkedRun(github, status, { pr, sha, branch }) {
  const match = /^https:\/\/github\.com\/qivo-io\/qivo\/actions\/runs\/([1-9]\d*)$/.exec(
    status?.target_url || '',
  )
  if (!match) return null
  const run = await github(`${prefix}/actions/runs/${match[1]}/attempts/1`, 'GET', undefined, {
    allowMissing: true,
  })
  const written = Date.parse(status.created_at)
  if (
    run?.run_attempt !== 1 ||
    run.path !== WORKFLOW ||
    run.event !== 'workflow_dispatch' ||
    run.head_branch !== branch ||
    run.repository?.full_name !== REPOSITORY ||
    run.display_title !== runName(pr, sha) ||
    !(written >= Date.parse(run.run_started_at)) ||
    // A run that is still going may have written the status a moment ago.
    (!ACTIVE.has(run.status) && !(written <= Date.parse(run.updated_at)))
  )
    return null
  return run
}

/** Write the commit status for this run. GitHub limits descriptions to 140 characters. */
async function publish(github, config, state, description) {
  await github(`${prefix}/statuses/${config.sha}`, 'POST', {
    state,
    context: config.context,
    description: description.length > 140 ? `${description.slice(0, 139)}…` : description,
    target_url: config.runUrl,
  })
}

/** Markdown for the run summary or the terminal. */
export function describe(config, result) {
  const lines = [
    `Pull request #${config.pr} at \`${short(config.sha)}\`, requested by ${config.actor}.`,
    '',
  ]
  for (const review of result.reviews)
    lines.push(`- ${review.complete ? 'Done' : 'Not done'}: ${review.name} ${review.reason}.`)
  if (result.problems.length) {
    lines.push('', 'Start CI refuses this request:', '')
    for (const problem of result.problems) lines.push(`- ${problem}`)
  } else {
    lines.push(
      '',
      `Starting CI attests that ${config.actor} assessed every review finding on this commit, ` +
        'including findings in review summaries that are not threads.',
    )
  }
  return `${lines.join('\n')}\n`
}

const refusedReruns =
  'Re-runs are not accepted, because they would reuse an old authorization. Dispatch Start ' +
  'CI again for the commit.'

/**
 * Check the request and claim the commit's status for this run. Returns `{ build }`: false
 * when another run already passed or is building this commit, so a duplicate request
 * starts nothing. Throws, writing nothing, when the request is refused.
 */
export async function authorize(config, github, { log = console.log, summary = () => {} } = {}) {
  if (config.runAttempt !== 1) throw new Error(refusedReruns)
  const result = await eligibility(github, config)
  summary(describe(config, result))
  if (result.problems.length) throw new Error(`Start CI refused: ${result.problems.join(' ')}`)

  const current = await latestStatus(github, config.sha, config.context)
  if (current?.state === 'success' || current?.state === 'pending') {
    const run = await linkedRun(github, current, config)
    const duplicate =
      run && current.state === 'success'
        ? `CI already passed for ${short(config.sha)} in ${current.target_url}.`
        : run && ACTIVE.has(run.status)
          ? `CI is already running for ${short(config.sha)} in ${current.target_url}.`
          : null
    if (duplicate) {
      log(duplicate)
      summary(`\nNothing to start: ${duplicate}\n`)
      return { build: false }
    }
  }
  await publish(github, config, 'pending', `CI is running. Started by ${config.actor}.`)
  log(`Authorized CI for ${short(config.sha)}.`)
  return { build: true }
}

/**
 * Publish the run's result. Success requires that this run still owns the commit's status,
 * that every required job of this attempt succeeded and that the request is still eligible.
 * A newer run that claimed the commit keeps its status. Throws unless CI succeeded.
 */
export async function report(config, github, { log = console.log, summary = () => {} } = {}) {
  if (config.runAttempt !== 1) throw new Error(refusedReruns)
  const current = await latestStatus(github, config.sha, config.context)
  if (current?.target_url !== config.runUrl) {
    log(`Another Start CI run owns the status of ${short(config.sha)}. It reports the result.`)
    throw new Error('This run was superseded.')
  }
  let state = 'failure'
  let description
  try {
    const jobs = await list(
      github,
      `${prefix}/actions/runs/${config.runId}/attempts/${config.runAttempt}/jobs`,
      'jobs',
    )
    const unfinished = REQUIRED_JOBS.map((name) => {
      const matches = jobs.filter((job) => job.name === name)
      const conclusion =
        matches.length === 1 ? matches[0].conclusion || matches[0].status : 'missing'
      return { name, conclusion }
    }).filter((job) => job.conclusion !== 'success')
    if (unfinished.length) {
      if (unfinished.every((job) => job.conclusion === 'cancelled')) state = 'error'
      description = `CI did not pass: ${unfinished.map((job) => `${job.name} ${job.conclusion}`).join(', ')}.`
    } else {
      const result = await eligibility(github, config)
      summary(describe(config, result))
      if (result.problems.length) description = `CI passed, but ${result.problems[0]}`
      else {
        state = 'success'
        description = 'Reviews finished and CI passed.'
      }
    }
  } catch (error) {
    state = 'error'
    description = 'Start CI could not verify the result. See the run log.'
    await publish(github, config, state, description)
    throw error
  }
  await publish(github, config, state, description)
  log(`${state}: ${description}`)
  if (state !== 'success') throw new Error(description)
}

/** Local, read-only: print what Start CI would decide for a pull request. */
async function check(pr, sha) {
  const token =
    process.env.GH_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
  const github = apiClient('https://api.github.com', token)
  const actor = (await github('/user')).login
  const head = sha || (await pullRequest(github, pr))?.head
  if (!head) throw new Error(`Pull request #${pr} does not exist.`)
  const config = { pr, sha: head, actor, branch: 'main' }
  const result = await eligibility(github, config)
  process.stdout.write(describe(config, result))
  if (result.problems.length) process.exitCode = 1
  else
    console.log(
      `\nReady. Start CI with:\n  gh workflow run reviewed-ci.yml --repo ${REPOSITORY} --ref main ` +
        `-f pr=${pr} -f sha=${head}`,
    )
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'check') {
    const [pr, sha] = args
    if (!NUMBER.test(pr || '') || (sha && !COMMIT.test(sha)))
      throw new Error('Usage: node scripts/reviewed-ci.mjs check PR [SHA]')
    await check(Number(pr), sha)
  } else if (command === 'authorize' || command === 'report') {
    const config = configuration(process.env)
    const github = apiClient('https://api.github.com', config.token)
    const summary = (text) =>
      process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
    if (command === 'authorize') {
      const { build } = await authorize(config, github, { summary })
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, `build=${build}\nsha=${config.sha}\n`)
    } else await report(config, github, { summary })
  } else throw new Error('Usage: node scripts/reviewed-ci.mjs check|authorize|report')
}
