import { describe, expect, it } from 'vitest'
import { nextVersion, prepareRelease, releaseHeader } from './prepare-release.mjs'

const MAIN = 'a'.repeat(40)
const OLD_APP = 'd'.repeat(40)
const BOT = { login: 'github-actions[bot]' }

/**
 * A GitHub API double that records writes. `change` replaces one kind of response.
 * `tagCommits` maps version tags to commits; by default every tag is on OLD_APP.
 */
function github(change = {}) {
  const writes = []
  const api = async (path, method = 'GET', body, options = {}) => {
    if (method !== 'GET') {
      writes.push({ path, method, body })
      if (path.endsWith('/generate-notes')) return { body: '## Changes\n- One fix' }
      if (path.endsWith('/releases')) {
        if (change.createFails) throw new Error('GitHub API 502')
        return { html_url: 'https://github.com/qivo-io/qivo/releases/tag/draft' }
      }
      return null
    }
    if (path.endsWith('/commits/main')) return { sha: MAIN }
    const tagCommit = /\/commits\/(v[\d.]+)$/.exec(path)
    if (tagCommit) return { sha: change.tagCommits?.[tagCommit[1]] ?? OLD_APP }
    if (path.includes('/git/matching-refs/tags/'))
      return (change.tags || ['v0.1.9']).map((tag) => ({ ref: `refs/tags/${tag}` }))
    if (path.includes('/git/ref/tags/')) {
      expect(options.allowMissing).toBe(true)
      return change.tag || null
    }
    if (path.includes('/releases?'))
      return change.releases || [{ id: 1, tag_name: 'v0.1.9', draft: false, prerelease: false }]
    if (path.includes('environment=staging'))
      return (
        change.staging || [
          {
            id: 20,
            sha: MAIN,
            environment: 'staging',
            creator: BOT,
            created_at: '2026-10-12T10:59:00Z',
            payload: {
              kind: 'qivo-staging-v1',
              app_revision: MAIN,
              ci_run_id: 1,
              workflow_run_id: '100',
              workflow_run_attempt: 1,
            },
          },
        ]
      )
    if (path.includes('/statuses'))
      return [{ id: 1, state: 'success', creator: BOT, created_at: '2026-10-12T11:00:00Z' }]
    if (path.includes('/actions/runs/100'))
      return {
        run_attempt: 1,
        conclusion: 'success',
        path: '.github/workflows/staging.yml',
        head_sha: MAIN,
        head_branch: 'main',
        event: 'workflow_run',
        repository: { full_name: 'qivo-io/qivo' },
        run_started_at: '2026-10-12T10:57:00Z',
        updated_at: '2026-10-12T11:01:00Z',
      }
    throw new Error(`Unexpected test request ${path}`)
  }
  return { api, writes }
}

const quiet = () => {}
/** What qivo.io/version.json reports. */
const live =
  (commit = OLD_APP) =>
  async (url) => {
    expect(url).toBe('https://qivo.io/version.json')
    return Response.json({ commit })
  }
const unavailable = async () => new Response('unavailable', { status: 503 })

describe('version choice', () => {
  it('defaults to the next patch and accepts a newer explicit version', () => {
    expect(nextVersion('', 'v0.1.9')).toBe('v0.1.10')
    expect(nextVersion(undefined, undefined)).toBe('v0.1.0')
    expect(nextVersion(' v0.2.0 ', 'v0.1.9')).toBe('v0.2.0')
  })
  it('refuses unstable, malformed and older versions', () => {
    for (const requested of ['v0.2.0-rc.1', '0.2.0', 'v0.1.9', 'v0.1.8', 'latest'])
      expect(() => nextVersion(requested, 'v0.1.9')).toThrow()
  })
})

describe('preparing a draft', () => {
  it('creates a draft for the staged main commit with the change link', async () => {
    const { api, writes } = github()
    const plan = await prepareRelease({ github: api, log: quiet, fetchImpl: live() })
    expect(plan).toMatchObject({ version: 'v0.1.10', appSha: MAIN, previousTag: 'v0.1.9' })
    expect(writes.map((write) => write.path)).toEqual([
      '/repos/qivo-io/qivo/releases/generate-notes',
      '/repos/qivo-io/qivo/releases',
    ])
    expect(writes[0].body).toEqual({
      tag_name: 'v0.1.10',
      target_commitish: MAIN,
      previous_tag_name: 'v0.1.9',
    })
    const draft = writes[1].body
    expect(draft).toMatchObject({
      tag_name: 'v0.1.10',
      target_commitish: MAIN,
      draft: true,
      prerelease: false,
    })
    expect(draft.body).toContain(`qivo/compare/${OLD_APP}...${MAIN})`)
    expect(draft.body).toContain('including the website and docs')
    expect(draft.body).toContain('## Changes\n- One fix')
  })
  it('writes nothing in a dry run', async () => {
    const { api, writes } = github()
    await expect(
      prepareRelease({ github: api, dryRun: true, log: quiet, fetchImpl: live() }),
    ).resolves.toMatchObject({
      version: 'v0.1.10',
    })
    expect(writes).toEqual([])
  })
  it('refuses while preview does not serve main yet', async () => {
    const { api, writes } = github({ staging: [] })
    await expect(prepareRelease({ github: api, log: quiet, fetchImpl: live() })).rejects.toThrow(
      /does not serve main/,
    )
    expect(writes).toEqual([])
  })
  it('refuses an existing tag, a published release or a person’s draft of the same version', async () => {
    for (const change of [
      { tag: { ref: 'refs/tags/v0.1.10' } },
      {
        releases: [
          { id: 1, tag_name: 'v0.1.9', draft: false, prerelease: false },
          { id: 2, tag_name: 'v0.1.10', draft: false, prerelease: true },
        ],
      },
      {
        releases: [
          { id: 1, tag_name: 'v0.1.9', draft: false, prerelease: false },
          { id: 2, tag_name: 'v0.1.10', draft: true, author: { login: 'lincarl' } },
        ],
      },
    ]) {
      const { api, writes } = github(change)
      await expect(prepareRelease({ github: api, log: quiet, fetchImpl: live() })).rejects.toThrow()
      expect(writes).toEqual([])
    }
  })
  it('deletes every older draft this workflow made, whatever its version', async () => {
    const logged = []
    const { api, writes } = github({
      releases: [
        { id: 1, tag_name: 'v0.1.9', draft: false, prerelease: false },
        { id: 2, tag_name: 'v0.1.10', draft: true, author: BOT },
        // A stale higher version would otherwise deploy its older commit if published.
        { id: 3, tag_name: 'v0.2.0', draft: true, author: BOT },
        { id: 4, tag_name: 'v0.3.0', draft: true, author: { login: 'lincarl' } },
      ],
    })
    await prepareRelease({ github: api, log: (line) => logged.push(line), fetchImpl: live() })
    expect(writes.map((write) => `${write.method} ${write.path}`)).toEqual([
      'POST /repos/qivo-io/qivo/releases/generate-notes',
      'POST /repos/qivo-io/qivo/releases',
      'DELETE /repos/qivo-io/qivo/releases/2',
      'DELETE /repos/qivo-io/qivo/releases/3',
    ])
    expect(logged.some((line) => line.includes('draft v0.3.0 made by a person'))).toBe(true)
  })
  it('keeps the older drafts when the new draft cannot be created', async () => {
    const { api, writes } = github({
      createFails: true,
      releases: [
        { id: 1, tag_name: 'v0.1.9', draft: false, prerelease: false },
        { id: 2, tag_name: 'v0.1.10', draft: true, author: BOT },
      ],
    })
    await expect(prepareRelease({ github: api, log: quiet, fetchImpl: live() })).rejects.toThrow(
      /502/,
    )
    expect(writes.some((write) => write.method === 'DELETE')).toBe(false)
  })
  it('starts the notes at the version production serves, not a newer tag that never deployed', async () => {
    const tags = ['v0.1.8', 'v0.1.9', 'v0.1.10']
    const tagCommits = { 'v0.1.8': 'e'.repeat(40), 'v0.1.9': OLD_APP, 'v0.1.10': 'f'.repeat(40) }
    let { api, writes } = github({ tags, tagCommits })
    await prepareRelease({ github: api, log: quiet, fetchImpl: live() })
    expect(writes[0].body.previous_tag_name).toBe('v0.1.9')
    expect(writes[1].body.tag_name).toBe('v0.1.11')
    expect(writes[1].body.body).toContain(`qivo/compare/${OLD_APP}...${MAIN})`)
    // Without the live app commit, the notes and the link start at the newest tag.
    ;({ api, writes } = github({ tags, tagCommits }))
    await prepareRelease({ github: api, log: quiet, fetchImpl: unavailable })
    expect(writes[0].body.previous_tag_name).toBe('v0.1.10')
    expect(writes[1].body.body).toContain(`qivo/compare/v0.1.10...${MAIN}) (since v0.1.10)`)
  })
  it('numbers from version tags, so a deleted release cannot be reused', async () => {
    const { api } = github({ tags: ['v0.1.9', 'v0.2.0'] })
    await expect(
      prepareRelease({ github: api, dryRun: true, log: quiet, fetchImpl: live() }),
    ).resolves.toMatchObject({
      version: 'v0.2.1',
      previousTag: 'v0.2.0',
    })
  })
  it('says when production already serves the staged commit', async () => {
    const { api, writes } = github()
    await prepareRelease({ github: api, log: quiet, fetchImpl: live(MAIN) })
    expect(writes[1].body.body).toContain('Changes since production: Unchanged')
  })
})

describe('draft text', () => {
  it('names the commit, the staging run and the first release', () => {
    const base = { appSha: MAIN, stagedAt: Date.UTC(2026, 9, 12, 11), stagingRunId: 100 }
    const header = releaseHeader({ ...base, previousTag: 'v0.1.9', productionApp: OLD_APP })
    expect(header).toContain('deploys commit [`aaaaaaa`]')
    expect(header).toContain('2026-10-12 11:00 UTC')
    expect(header).toContain('/actions/runs/100')
    const first = releaseHeader({ ...base, previousTag: undefined, productionApp: null })
    expect(first).toContain('Changes since production: First release')
  })
})
