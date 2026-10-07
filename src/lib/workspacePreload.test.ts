import { beforeEach, describe, expect, it, vi } from 'vitest'

const chunks = vi.hoisted(() => ({
  loadOverview: vi.fn(async () => undefined),
  loadKanban: vi.fn(async () => undefined),
  loadInbox: vi.fn(async () => undefined),
  loadIssueDetail: vi.fn(async () => undefined),
  loadSettings: vi.fn(async () => undefined),
  loadArchive: vi.fn(async () => undefined),
  loadRoadmap: vi.fn(async () => undefined),
  loadTeamSync: vi.fn(async () => undefined),
}))

vi.mock('./workspaceChunks', () => chunks)

import { preloadWorkspacePage } from './workspacePreload'

function expectPreload(pathname: string, hash: string, expected: (keyof typeof chunks)[]) {
  vi.clearAllMocks()
  preloadWorkspacePage(pathname, hash)
  const called = Object.entries(chunks)
    .filter(([, loader]) => loader.mock.calls.length > 0)
    .map(([name]) => name)
  expect(called.sort(), `${pathname}${hash}`).toEqual([...expected].sort())
}

describe('workspace route preloading', () => {
  beforeEach(() => vi.clearAllMocks())

  it('loads only the explicit page, including legacy view names', () => {
    const routes = {
      overview: 'loadOverview',
      board: 'loadKanban',
      kanban: 'loadKanban',
      roadmap: 'loadRoadmap',
      split: 'loadRoadmap',
      resources: 'loadRoadmap',
      inbox: 'loadInbox',
      sync: 'loadTeamSync',
      archive: 'loadArchive',
      settings: 'loadSettings',
    } satisfies Record<string, keyof typeof chunks>
    for (const [page, loader] of Object.entries(routes)) {
      expectPreload(`/app/northstar/${page}`, '', [loader])
    }
  })

  it('gives explicit paths precedence over legacy hashes, including unknown pages', () => {
    expectPreload('/app/northstar/board/all', '#/roadmap/all', ['loadKanban'])
    expectPreload('/app/northstar/unknown', '#/inbox', [])
    expectPreload('/app/~/inbox?source=link', '#/board/all', ['loadInbox'])
  })

  it('uses legacy hashes only at an app or organization front door', () => {
    expectPreload('/app', '#/board/all', ['loadKanban'])
    expectPreload('/app/northstar/', '#/roadmap/mine', ['loadRoadmap'])
    expectPreload('/app/board', '#/inbox', ['loadInbox'])
    expectPreload('/app', '#/o/northstar/settings/account', ['loadSettings'])
    expectPreload('/pricing', '#/board/all', [])
  })

  it('preloads task details only at task positions in supported routes', () => {
    expectPreload('/app/northstar/tasks/qn-42', '', ['loadIssueDetail'])
    expectPreload('/app/northstar/board/tasks/qn-42', '', ['loadKanban', 'loadIssueDetail'])
    expectPreload('/app/northstar/overview/mine/tasks/qn-42', '', [
      'loadOverview',
      'loadIssueDetail',
    ])
    expectPreload('/app/northstar/roadmap/p/3/tasks/qn-42', '', ['loadRoadmap', 'loadIssueDetail'])
    expectPreload('/app/northstar/inbox/tasks/qn-42', '', ['loadInbox', 'loadIssueDetail'])
    expectPreload('/app/northstar/sync/p/3/people/nora/tasks/qn-42', '', [
      'loadTeamSync',
      'loadIssueDetail',
    ])
    expectPreload('/app/northstar/sync/team/team-id/agents/tasks/qn-42', '', [
      'loadTeamSync',
      'loadIssueDetail',
    ])
    expectPreload('/app', '#/all/tasks/qn-42', ['loadIssueDetail'])
    expectPreload('/app/northstar/inbox/t%61sks/QN-42', '', ['loadInbox', 'loadIssueDetail'])
  })

  it('does not confuse identifiers or unrelated suffixes with task positions', () => {
    expectPreload('/app/tasks/board/all', '', ['loadKanban'])
    expectPreload('/app/northstar/board/p/tasks', '', ['loadKanban'])
    expectPreload('/app/northstar/sync/people/tasks', '', ['loadTeamSync'])
    expectPreload('/app/northstar/sync/team/tasks/people/nora', '', ['loadTeamSync'])
    expectPreload('/app/northstar/settings/tasks/qn-42', '', ['loadSettings'])
    expectPreload('/app/northstar/archive/tasks/qn-42', '', ['loadArchive'])
    expectPreload('/app/northstar/inbox/all/tasks/qn-42', '', ['loadInbox'])
    expectPreload('/app/northstar/board/tasks', '', ['loadKanban'])
  })

  it('leaves front doors, unrelated hashes and unknown addresses to the app', () => {
    for (const path of [
      '/app',
      '/app/',
      '/app/northstar',
      '/app/tasks',
      '/app/~/unknown',
      '/app/~/constructor',
      '/app/~/toString',
    ]) {
      expectPreload(path, '', [])
      expectPreload(path, '#signup', [])
    }
    expectPreload('/app', '#/', [])
    expectPreload('/app', '#/unknown/tasks/qn-42', [])
    expectPreload('/appx/northstar/board/all', '#/inbox', [])
    expectPreload('/app/%/board', '', [])
    expectPreload('/app', '#/board/%', [])
  })

  it('absorbs speculative import failures and permits later preload attempts', async () => {
    chunks.loadKanban.mockRejectedValueOnce(new Error('Board chunk unavailable'))
    chunks.loadIssueDetail.mockRejectedValueOnce(new Error('Task chunk unavailable'))
    preloadWorkspacePage('/app/northstar/board/tasks/qn-42', '')
    await new Promise((resolve) => setTimeout(resolve, 0))
    preloadWorkspacePage('/app/northstar/board/tasks/qn-42', '')
    expect(chunks.loadKanban).toHaveBeenCalledTimes(2)
    expect(chunks.loadIssueDetail).toHaveBeenCalledTimes(2)
  })
})
