import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  authorize,
  CONTEXT,
  configuration,
  eligibility,
  REHEARSAL_CONTEXT,
  REQUIRED_JOBS,
  report,
  runName,
} from './reviewed-ci.mjs'

const SHA = 'a'.repeat(40)
const OLDER = 'b'.repeat(40)
const MAIN = 'c'.repeat(40)
const REPO = '/repos/qivo-io/qivo'
const RUN_URL = 'https://github.com/qivo-io/qivo/actions/runs/500'
const config = {
  pr: 7,
  sha: SHA,
  branch: 'main',
  context: CONTEXT,
  actor: 'lincarl',
  runId: 500,
  runAttempt: 1,
  runUrl: RUN_URL,
}

// Evidence both reviewers leave on a commit they finished reviewing.
const reviewedStatuses = [
  {
    id: 1,
    context: 'CodeRabbit',
    state: 'success',
    description: 'Review completed',
    created_at: '2026-10-18T06:00:00Z',
    creator: { login: 'coderabbitai[bot]' },
  },
]
const reviewedChecks = [
  {
    id: 2,
    name: 'Greptile Review',
    head_sha: SHA,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-10-18T06:00:00Z',
    app: { id: 867647 },
    output: {
      summary: 'Greptile has reviewed the Pull Request.\n\n3 files reviewed, 0 comments added.',
    },
  },
]
const comment = (login, body) => ({
  url: 'https://github.com/qivo-io/qivo/pull/7#issuecomment-1',
  body,
  author: { login, __typename: 'Bot' },
  editor: { login, __typename: 'Bot' },
})
const reviewedComments = [
  comment(
    'coderabbitai',
    '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n' +
      `<!-- final_review_risk_coverage:{"sourceCommitId":"${SHA}","coveredCommitId":"${SHA}","kind":"reviewed"} -->`,
  ),
  comment(
    'greptile-apps',
    '<!-- greptile_summary -->\n' +
      `<sub>Reviews (1) · Last reviewed commit: ["x"](https://github.com/qivo-io/qivo/commit/${SHA})</sub>`,
  ),
]

/** A pull request as the GraphQL query returns it, ready unless `change` says otherwise. */
const pullRequest = (change = {}) => ({
  state: 'OPEN',
  isDraft: false,
  headRefOid: SHA,
  baseRefName: 'main',
  baseRepository: { nameWithOwner: 'qivo-io/qivo' },
  latestOpinionatedReviews: { nodes: [] },
  comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: reviewedComments },
  reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
  ...change,
})

/**
 * A GitHub API double. `state` holds what each endpoint returns; every status write is
 * recorded in `writes`, and the newest write becomes the commit's latest status.
 */
function fakeGithub(change = {}) {
  const state = {
    role: 'admin',
    pull: pullRequest(),
    behind: 0,
    statuses: reviewedStatuses,
    checks: reviewedChecks,
    ours: [],
    runs: {},
    jobs: REQUIRED_JOBS.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
    ...change,
  }
  const writes = []
  const github = async (path, method = 'GET', body) => {
    const [route] = path.split('?')
    if (method === 'POST' && route === `${REPO}/statuses/${SHA}`) {
      const status = {
        id: 1000 + writes.length,
        context: body.context,
        state: body.state,
        description: body.description,
        target_url: body.target_url,
        created_at: new Date(Date.parse('2026-10-18T07:00:00Z') + writes.length).toISOString(),
        creator: { login: 'github-actions[bot]' },
      }
      writes.push(status)
      state.ours = [status, ...state.ours]
      return status
    }
    if (method === 'POST' && route === '/graphql')
      return { data: { repository: { pullRequest: state.page?.(body.variables) ?? state.pull } } }
    if (route === `${REPO}/collaborators/lincarl/permission`) return { role_name: state.role }
    if (route === `${REPO}/git/ref/heads/main`) return { object: { sha: MAIN } }
    if (route === `${REPO}/compare/${MAIN}...${SHA}`) return { behind_by: state.behind }
    if (route === `${REPO}/commits/${SHA}/statuses`) return [...state.ours, ...state.statuses]
    if (route === `${REPO}/commits/${SHA}/check-runs`) return { check_runs: state.checks }
    if (route === `${REPO}/actions/runs/500/attempts/1/jobs`) return { jobs: state.jobs }
    const run = /^\/repos\/qivo-io\/qivo\/actions\/runs\/(\d+)\/attempts\/1$/.exec(route)
    if (run) return state.runs[run[1]] ?? null
    throw new Error(`Unexpected request ${method} ${path}`)
  }
  return { github, state, writes }
}

/** A Start CI run that wrote statuses for this commit between 06:30 and 07:30. */
const startCiRun = (change = {}) => ({
  run_attempt: 1,
  path: '.github/workflows/reviewed-ci.yml',
  event: 'workflow_dispatch',
  head_branch: 'main',
  repository: { full_name: 'qivo-io/qivo' },
  display_title: runName(7, SHA),
  status: 'in_progress',
  run_started_at: '2026-10-18T06:30:00Z',
  updated_at: '2026-10-18T07:30:00Z',
  ...change,
})
const ownStatus = (state, run = 400, created = '2026-10-18T06:45:00Z') => ({
  id: 900,
  context: CONTEXT,
  state,
  description: 'x',
  target_url: `https://github.com/qivo-io/qivo/actions/runs/${run}`,
  created_at: created,
  creator: { login: 'github-actions[bot]' },
})
const quiet = { log: () => {} }

describe('configuration', () => {
  const env = {
    GITHUB_REPOSITORY: 'qivo-io/qivo',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: 'qivo-io/qivo/.github/workflows/reviewed-ci.yml@refs/heads/main',
    GITHUB_RUN_ID: '500',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_ACTOR: 'lincarl',
    GITHUB_TRIGGERING_ACTOR: 'lincarl',
    GH_TOKEN: 'test-token',
    QIVO_PR: '7',
    QIVO_SHA: SHA,
  }

  it('publishes the required context only from main', () => {
    expect(configuration(env)).toMatchObject({ pr: 7, sha: SHA, context: CONTEXT, runUrl: RUN_URL })
    const branch = {
      ...env,
      GITHUB_REF: 'refs/heads/t3/ci',
      GITHUB_WORKFLOW_REF: 'qivo-io/qivo/.github/workflows/reviewed-ci.yml@refs/heads/t3/ci',
    }
    expect(configuration(branch).context).toBe(REHEARSAL_CONTEXT)
  })

  it('accepts run IDs of any length', () => {
    // Run IDs already have eleven digits.
    const run = { ...env, GITHUB_RUN_ID: '39109520217' }
    expect(configuration(run)).toMatchObject({
      runId: 39109520217,
      runUrl: 'https://github.com/qivo-io/qivo/actions/runs/39109520217',
    })
    expect(() => configuration({ ...env, GITHUB_RUN_ID: '0123' })).toThrow()
  })

  it('refuses other repositories, events, workflows and malformed inputs', () => {
    expect(() => configuration({ ...env, GITHUB_REPOSITORY: 'someone/qivo' })).toThrow()
    expect(() => configuration({ ...env, GITHUB_EVENT_NAME: 'push' })).toThrow()
    expect(() =>
      configuration({
        ...env,
        GITHUB_WORKFLOW_REF: 'qivo-io/qivo/.github/workflows/ci.yml@refs/heads/main',
      }),
    ).toThrow()
    expect(() => configuration({ ...env, GITHUB_REF: 'refs/tags/v1.0.0' })).toThrow()
    expect(() => configuration({ ...env, QIVO_SHA: SHA.slice(0, 7) })).toThrow()
    expect(() => configuration({ ...env, QIVO_PR: '7; rm -rf /' })).toThrow()
  })
})

describe('eligibility', () => {
  it('is ready when the head is reviewed, current and has no open threads', async () => {
    const { github } = fakeGithub()
    const result = await eligibility(github, config)
    expect(result.problems).toEqual([])
    expect(result.reviews.map((review) => review.complete)).toEqual([true, true])
  })

  it('refuses a stale request without judging reviews of the wrong commit', async () => {
    const { github } = fakeGithub({ pull: pullRequest({ headRefOid: OLDER }) })
    const result = await eligibility(github, config)
    expect(result.problems).toEqual([
      'The pull request head is bbbbbbb, not aaaaaaa. Finish reviewing the new commit, then start CI for it.',
    ])
    expect(result.reviews).toEqual([])
  })

  it('lists every reason a reviewed head is not ready', async () => {
    const { github } = fakeGithub({
      role: 'read',
      behind: 2,
      statuses: [],
      pull: pullRequest({
        isDraft: true,
        latestOpinionatedReviews: {
          nodes: [{ state: 'CHANGES_REQUESTED', author: { login: 'lincarl', __typename: 'User' } }],
        },
        reviewThreads: {
          pageInfo: { hasNextPage: false },
          nodes: [
            { isResolved: true, path: 'a.ts', comments: { nodes: [] } },
            {
              isResolved: false,
              path: 'b.ts',
              comments: {
                nodes: [{ url: 'u', author: { login: 'greptile-apps', __typename: 'Bot' } }],
              },
            },
          ],
        },
      }),
    })
    expect((await eligibility(github, config)).problems).toEqual([
      'lincarl does not have write access to qivo-io/qivo.',
      'The pull request is a draft. Mark it ready for review first.',
      'aaaaaaa is 2 commit(s) behind main ccccccc. Update the branch. The new commit then needs finished reviews before CI.',
      'CodeRabbit has not posted a status on this commit.',
      '1 review thread(s) are unresolved: b.ts by greptile-apps[bot] (u)',
      'lincarl requests changes.',
    ])
  })

  it('reads every page of comments and threads once', async () => {
    const thread = (resolved, path) => ({
      isResolved: resolved,
      path,
      comments: { nodes: [{ url: path, author: { login: 'coderabbitai', __typename: 'Bot' } }] },
    })
    // Comments take two pages and threads one. GitHub returns an empty page, without a
    // cursor, after a connection's last cursor.
    const page = ({ comments, threads }) =>
      pullRequest({
        comments:
          comments === null
            ? { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [reviewedComments[0]] }
            : { pageInfo: { hasNextPage: false, endCursor: 'c2' }, nodes: [reviewedComments[1]] },
        reviewThreads:
          threads === null
            ? { pageInfo: { hasNextPage: false, endCursor: 't1' }, nodes: [thread(false, 'x.ts')] }
            : { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      })
    const { github } = fakeGithub({ page })
    const result = await eligibility(github, config)
    expect(result.reviews.map((review) => review.complete)).toEqual([true, true])
    expect(result.problems).toEqual([
      '1 review thread(s) are unresolved: x.ts by coderabbitai[bot] (x.ts)',
    ])
  })

  it('refuses closed pull requests and other base branches', async () => {
    const { github } = fakeGithub({
      pull: pullRequest({ state: 'MERGED', baseRefName: 'release' }),
    })
    expect((await eligibility(github, config)).problems).toEqual([
      'Pull request #7 is merged.',
      'Start CI only builds pull requests into main.',
    ])
  })
})

describe('authorize', () => {
  it('claims the commit with a pending status that links this run', async () => {
    const { github, writes } = fakeGithub()
    expect(await authorize(config, github, quiet)).toEqual({ build: true })
    expect(writes).toMatchObject([{ state: 'pending', context: CONTEXT, target_url: RUN_URL }])
  })

  it('writes nothing when it refuses the request or a re-run', async () => {
    const refused = fakeGithub({ pull: pullRequest({ headRefOid: OLDER }) })
    await expect(authorize(config, refused.github, quiet)).rejects.toThrow('Start CI refused')
    expect(refused.writes).toEqual([])
    const rerun = fakeGithub()
    await expect(authorize({ ...config, runAttempt: 2 }, rerun.github, quiet)).rejects.toThrow(
      'Re-runs are not accepted',
    )
    expect(rerun.writes).toEqual([])
  })

  it('starts nothing for a commit another run is building or already passed', async () => {
    const running = fakeGithub({ ours: [ownStatus('pending')], runs: { 400: startCiRun() } })
    expect(await authorize(config, running.github, quiet)).toEqual({ build: false })
    expect(running.writes).toEqual([])
    const passed = fakeGithub({
      ours: [ownStatus('success', 400, '2026-10-18T07:20:00Z')],
      runs: { 400: startCiRun({ status: 'completed', conclusion: 'success' }) },
    })
    expect(await authorize(config, passed.github, quiet)).toEqual({ build: false })
  })

  it('rebuilds after a failure, a run that ended without reporting, or a status it cannot trust', async () => {
    const retries = [
      { ours: [ownStatus('failure')], runs: { 400: startCiRun({ status: 'completed' }) } },
      { ours: [ownStatus('pending')], runs: { 400: startCiRun({ status: 'completed' }) } },
      // Statuses that name another workflow, commit or time do not prove a passing run.
      {
        ours: [ownStatus('success')],
        runs: { 400: startCiRun({ path: '.github/workflows/x.yml' }) },
      },
      {
        ours: [ownStatus('success')],
        runs: { 400: startCiRun({ display_title: runName(7, OLDER) }) },
      },
      {
        ours: [ownStatus('success', 400, '2026-10-18T08:00:00Z')],
        runs: { 400: startCiRun({ status: 'completed' }) },
      },
      { ours: [ownStatus('success')], runs: {} },
    ]
    for (const change of retries) {
      const { github, writes } = fakeGithub(change)
      expect(await authorize(config, github, quiet)).toEqual({ build: true })
      expect(writes.map((write) => write.state)).toEqual(['pending'])
    }
  })
})

describe('report', () => {
  /** A fake where this run already claimed the commit. */
  const claimed = (change) => {
    const fake = fakeGithub(change)
    fake.state.ours = [
      { ...ownStatus('pending', 500), id: 999, created_at: '2026-10-18T06:59:00Z' },
    ]
    return fake
  }
  const job = (conclusion, status = 'completed') => [{ name: REQUIRED_JOBS[0], status, conclusion }]

  it('publishes success only after the build succeeded and everything still holds', async () => {
    const { github, writes } = claimed()
    await report(config, github, quiet)
    expect(writes).toMatchObject([
      { state: 'success', description: 'Reviews finished and CI passed.' },
    ])
  })

  it('never reports success for a failed, skipped, cancelled, missing or doubled job', async () => {
    const cases = [
      [job('failure'), 'failure', 'CI did not pass: Build and test / quality failure.'],
      [job('skipped'), 'failure', 'CI did not pass: Build and test / quality skipped.'],
      [
        job(null, 'in_progress'),
        'failure',
        'CI did not pass: Build and test / quality in_progress.',
      ],
      [[], 'failure', 'CI did not pass: Build and test / quality missing.'],
      [
        [...job('success'), ...job('success')],
        'failure',
        'CI did not pass: Build and test / quality missing.',
      ],
      [job('cancelled'), 'error', 'CI did not pass: Build and test / quality cancelled.'],
    ]
    for (const [jobs, state, description] of cases) {
      const { github, writes } = claimed({ jobs })
      await expect(report(config, github, quiet)).rejects.toThrow(description)
      expect(writes).toMatchObject([{ state, description }])
    }
  })

  it('reports failure when the pull request changed while CI ran', async () => {
    const { github, writes } = claimed({ pull: pullRequest({ headRefOid: OLDER }) })
    await expect(report(config, github, quiet)).rejects.toThrow('CI passed, but')
    expect(writes).toMatchObject([{ state: 'failure' }])
  })

  it('leaves the status alone for a re-run or a newer run that claimed the commit', async () => {
    const rerun = claimed()
    await expect(report({ ...config, runAttempt: 2 }, rerun.github, quiet)).rejects.toThrow()
    expect(rerun.writes).toEqual([])
    const superseded = fakeGithub({ ours: [ownStatus('pending', 501, '2026-10-18T07:01:00Z')] })
    await expect(report(config, superseded.github, quiet)).rejects.toThrow('superseded')
    expect(superseded.writes).toEqual([])
  })

  it('reports an error, not success, when it cannot verify the result', async () => {
    const { github, writes } = claimed()
    const broken = async (path, ...rest) => {
      if (path.includes('/compare/')) throw new Error('GET /compare returned HTTP 502.')
      return github(path, ...rest)
    }
    await expect(report(config, broken, quiet)).rejects.toThrow('HTTP 502')
    expect(writes).toMatchObject([{ state: 'error' }])
  })
})

describe('workflow policy', () => {
  const workflows = Object.fromEntries(
    readdirSync('.github/workflows').map((file) => [
      file,
      readFileSync(`.github/workflows/${file}`, 'utf8'),
    ]),
  )
  const start = workflows['reviewed-ci.yml']

  it('gives every run the title runName() matches', () => {
    // Unquoted, " #" would start a YAML comment and cut the title to "Start CI for".
    const title = /^run-name: '(.+)'$/m.exec(start)?.[1] ?? ''
    const values = { 'inputs.pr': '7', 'inputs.sha': SHA }
    expect(title.replace(/\$\{\{ (.+?) \}\}/g, (_, expression) => values[expression])).toBe(
      runName(7, SHA),
    )
  })

  it('names the build job as REQUIRED_JOBS expects', () => {
    // The jobs API names a called workflow's job "<caller name> / <called job>".
    expect(start).toMatch(/\n {2}build:\n {4}name: Build and test\n/)
    expect(start).toMatch(/\n {4}uses: \.\/\.github\/workflows\/ci\.yml\n/)
    const jobs = [...workflows['ci.yml'].split('\njobs:\n')[1].matchAll(/^ {2}([a-z][\w-]*):$/gm)]
    expect(jobs.map((match) => match[1])).toEqual(['quality'])
    expect(REQUIRED_JOBS).toEqual(['Build and test / quality'])
  })

  it('keeps the build unprivileged and cache writes out of Start CI', () => {
    const build = start.split('\n  build:\n')[1].split('\n  report:\n')[0]
    expect(build).toMatch(/permissions:\n {6}contents: read\n/)
    expect(build).toMatch(/cache-mode: read\n/)
    expect(build).not.toMatch(/secrets:/)
    expect(start).toMatch(/\ncache-mode: none\n/)
    // A called workflow that asks for more than read access would not start at all.
    expect(workflows['ci.yml']).not.toMatch(/^\s*cache-mode:\s*(write|write-only)\s*$/m)
  })

  it('runs one Start CI run per commit at a time and queues the next', () => {
    // Overlapping runs for one commit would race for its single status.
    expect(start).toMatch(
      /\nconcurrency:\n {2}group: reviewed-ci-.+\n {2}cancel-in-progress: false\n/,
    )
    expect(start.split('\njobs:\n')[1]).not.toMatch(/concurrency:/)
  })

  it('lets only the Start CI controller write statuses or name a check reviewed-ci', () => {
    for (const [file, text] of Object.entries(workflows)) {
      if (file !== 'reviewed-ci.yml') expect(text, file).not.toMatch(/statuses:\s*write/)
      expect(text, file).not.toMatch(/^\s*(name:\s*)?reviewed-ci:?\s*$/m)
    }
  })

  it('cancels the group Start CI uses for runs from main', () => {
    // Evaluate both groups for a main run building OLDER and a push that replaced OLDER,
    // as GitHub would.
    const values = {
      'github.ref': 'refs/heads/main',
      'inputs.sha': OLDER,
      'github.event.before || github.event.pull_request.head.sha': OLDER,
    }
    const group = (text) =>
      /group: (reviewed-ci-.+)$/m
        .exec(text)[1]
        .replace(/\$\{\{ (.+?) \}\}/g, (_, expression) => values[expression] ?? '?')
    expect(group(start)).toBe(`reviewed-ci-refs/heads/main-${OLDER}`)
    expect(group(workflows['reviewed-ci-cancel.yml'])).toBe(group(start))
  })
})
