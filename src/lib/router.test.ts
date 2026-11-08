import { beforeEach, describe, expect, it, vi } from 'vitest'

/* The router reads the live store to resolve numbers and slugs, so the tests
   stand a fake one in its place: importing the real planner would pull in
   src/lib/convex.ts (which throws without VITE_CONVEX_URL) and assign
   window.PLANNER. Only the handful of members router.ts actually touches are
   faked — anything it starts using will fail loudly here rather than silently.

   Fixture: one home organization (HOME, slug "home") with projects 1 and 7 and
   issues QN-5 / QN-9, plus a foreign one (ACME, slug "acme") whose numbering
   collides on purpose — project 1 and QN-5 exist twice, which is the whole
   reason an address carries the organization at all (0081). */
const HOME = 'org-home'
const ACME = 'org-acme'

/* The fixture row shapes — deliberately NOT the planner's VM types: they carry
   only the fields the fixtures set, so a test reaching for an unfaked field
   fails to compile the same way an unfaked store member fails at runtime. */
type FakeProject = {
  id: string
  num: number | null
  org: string
  type: string
  children?: string[]
  parent?: string
}
type FakeIssue = {
  id: string
  key: string
  uuid: string
  org: string
  project: string
  assignee: string
}
type FakeOrg = { id: string; slug: string; name: string }

/* What the window shows of a task the workspace does not hold, from its own
   read (P.detail), and the read of a registered reference (P.reference). */
type FakeDetail = { task: string; view: FakeIssue | null }
type FakeReference = {
  ref: string
  state: string
  task: { uuid: string; org: string; num: number | null; project: string | null } | null
}

const store = {} as {
  projects: FakeProject[]
  issues: FakeIssue[]
  homeOrg: string
  orgs: FakeOrg[]
  myProfileIds: string[]
  issueById: Record<string, FakeIssue>
  detail: FakeDetail | null
  reference: FakeReference | null
  orgBySlug: (s: string) => FakeOrg | undefined
  project: (id: string) => FakeProject | undefined
  /** The workspace's held project, which the fake answers as `project`. */
  heldProject: (id: string) => FakeProject | undefined
  issueRefIn: (org: string, key: string) => string | null
  handleNow: (uuid: string, org: string, num: number) => string
  handleOf: (uuid: string) => string | null
}

vi.mock('../store/planner', () => ({
  ISSUE_PREFIX: 'QN',
  MINE_SCOPE: 'mine',
  // every project the fake holds is the workspace's, so heldProject is project
  P: new Proxy(
    {},
    { get: (_t, k) => store[(k === 'heldProject' ? 'project' : k) as keyof typeof store] },
  ),
}))

import {
  addressedTask,
  buildPath,
  issueLink,
  namesProjectPage,
  noteProjectPage,
  numberedProjectPage,
  ORG_NONE,
  parseHash,
  parsePath,
  pathMatchesState,
  projectPageRef,
  projectPagesRev,
  sameTask,
  scopeForIssue,
  syncPlaceOf,
  taskSegmentOf,
  type UiState,
} from './router'
import { refParts, taskRef } from './taskReference'

/* A real uuid of a task the workspace does not hold, as the server gives
   them, which a uuid address resolves to a reference. */
const FAR = '6f1c2a4e-0000-4000-8000-0000000000aa'

/* Task `id` as the scope rules read it. */
const scopeTask = (id: string) => {
  const it = store.issueById[id]
  return it && { project: it.project, owner: it.assignee }
}

const project = (
  id: string,
  num: number | null,
  org: string,
  extra: Partial<FakeProject> = {},
): FakeProject => ({
  id,
  num,
  org,
  type: 'meta',
  children: [],
  ...extra,
})

beforeEach(() => {
  const projects = [
    project('p-home-1', 1, HOME, { children: ['p-home-1a'] }),
    project('p-home-1a', null, HOME, { type: 'project', parent: 'p-home-1' }),
    project('p-home-7', 7, HOME),
    project('p-acme-1', 1, ACME),
  ]
  /* `assignee` matters to one rule only: My view holds a task when it is
     MINE, so scopeForIssue narrows away from the sentinel when it isn't.
     QN-9 is somebody else's on purpose; the ACME one is mine, because a seat
     in another organization is still me (0081). */
  const issues = [
    {
      id: 'QN-5',
      key: 'QN-5',
      uuid: 'uuid-home-5',
      org: HOME,
      project: 'p-home-1a',
      assignee: 'me',
    },
    {
      id: 'QN-9',
      key: 'QN-9',
      uuid: 'uuid-home-9',
      org: HOME,
      project: 'p-home-7',
      assignee: 'someone-else',
    },
    // a foreign issue's HANDLE is its uuid; only its display key reads "QN-5"
    {
      id: 'uuid-acme-5',
      key: 'QN-5',
      uuid: 'uuid-acme-5',
      org: ACME,
      project: 'p-acme-1',
      assignee: 'me',
    },
  ]
  store.projects = projects
  store.issues = issues
  store.homeOrg = HOME
  store.orgs = [
    { id: HOME, slug: 'home', name: 'Home' },
    { id: ACME, slug: 'acme', name: 'Acme' },
  ]
  store.issueById = Object.fromEntries(issues.map((i) => [i.id, i] as const))
  store.orgBySlug = (s: string) => store.orgs.find((o) => o.slug === s)
  store.project = (id: string) => projects.find((p) => p.id === id)
  // as the store gives a handle: its own for a task it holds, else the home
  // organization's key or another organization's uuid
  store.handleNow = (uuid: string, org: string, num: number) =>
    store.issues.find((i) => i.uuid === uuid)?.id ?? (org === store.homeOrg ? `QN-${num}` : uuid)
  store.issueRefIn = (org: string, key: string) => {
    const it = issues.find((i) => i.org === org && i.key === key)
    return it ? it.id : null
  }
  store.handleOf = (uuid: string) => store.issues.find((i) => i.uuid === uuid)?.id ?? null
  // a seat in another organization is still me (0081)
  store.myProfileIds = ['me']
  store.detail = null
  store.reference = null
})

describe('parsePath — the front door parses to NOTHING', () => {
  /* Load-bearing, and the reason it has its own block. App reads a NON-null
     route with no view as "overview" and persists that to user_prefs, so if
     an organization's own front door parsed to a route, every visit to the
     domain would silently reset the view the user left on. Only null reaches
     the saved-state branch. */
  it('the app prefix and the org front door mean "use the saved state"', () => {
    expect(parsePath('/app')).toBeNull()
    expect(parsePath('/app/')).toBeNull()
    expect(parsePath('/app/home')).toBeNull()
    expect(parsePath('/app/home/')).toBeNull()
    expect(parsePath('/app/~')).toBeNull()
    expect(parsePath('/app/~/')).toBeNull()
  })

  it('ignores anything outside the app prefix', () => {
    expect(parsePath('/')).toBeNull()
    expect(parsePath('/pricing')).toBeNull()
    expect(parsePath('/docs/getting-started')).toBeNull()
    expect(parsePath('/application/home/board')).toBeNull() // not /app/
    expect(parsePath('')).toBeNull()
  })

  it('strips a query string and a fragment before reading the path', () => {
    expect(parsePath('/app/home/board/p/7?x=1')).toEqual({ view: 'kanban', scope: 'p-home-7' })
    expect(parsePath('/app/home/board/p/7#access_token=abc')).toEqual({
      view: 'kanban',
      scope: 'p-home-7',
    })
  })
})

describe('parsePath — the org segment', () => {
  it('does not open tasks through former /i/ segments', () => {
    for (const path of [
      '/app/home/i/qn-9',
      '/app/home/board/i/qn-9',
      '/app/home/board/mine/i/qn-9',
      '/app/home/board/mine/i/qn-9',
      '/app/home/inbox/i/qn-9',
      '/app/home/board/p/7/i/qn-9',
      '/app/acme/board/i/qn-5',
    ]) {
      expect(parsePath(path)?.issue).toBeUndefined()
    }
  })

  it('pins which organization a bare number is read in', () => {
    expect(parsePath('/app/home/board/p/1')).toEqual({ view: 'kanban', scope: 'p-home-1' })
    expect(parsePath('/app/acme/board/p/1')).toEqual({ view: 'kanban', scope: 'p-acme-1' })
    expect(parsePath('/app/home/tasks/qn-5')!.issue).toBe('QN-5')
    expect(parsePath('/app/acme/tasks/qn-5')!.issue).toBe('uuid-acme-5')
  })

  it('~ names no organization, and reads home-first', () => {
    expect(parsePath('/app/~/board/p/1')).toEqual({ view: 'kanban', scope: 'p-home-1' })
    expect(parsePath('/app/~/tasks/qn-5')!.issue).toBe('QN-5')
  })

  it('a slug this login cannot resolve resolves NOTHING, rather than falling home', () => {
    // the same number exists at home, so a home-first fallback would silently
    // open MY project 1 when handed a link to someone else's
    // it names a project no read can ask about (Route.unheld null), which
    // App answers with the project chooser and a note
    expect(parsePath('/app/globex/board/p/1')).toEqual({ view: 'kanban', unheld: null })
    expect(parsePath('/app/globex/tasks/qn-5')).toEqual({})
    // …and the view/settings shell the link named still applies
    expect(parsePath('/app/globex/roadmap/p/1')!.view).toBe('roadmap')
  })

  it('resolves an issue by uuid or bare number too', () => {
    expect(parsePath('/app/home/tasks/5')!.issue).toBe('QN-5')
    expect(parsePath('/app/home/tasks/uuid-acme-5')!.issue).toBe('uuid-acme-5')
    expect(parsePath('/app/home/tasks/QN-5')!.issue).toBe('QN-5')
  })
})

describe('parsePath — scopes and pages', () => {
  it('reads My view with and without a view', () => {
    expect(parsePath('/app/~/mine')).toEqual({ scope: 'mine' })
    expect(parsePath('/app/~/roadmap/mine')).toEqual({ view: 'roadmap', scope: 'mine' })
    expect(parseHash('#/board/mine')).toEqual({ view: 'kanban', scope: 'mine' })
  })

  it('reads an address that once named all projects as its view with no scope, and drops a task after it', () => {
    expect(parsePath('/app/~/all')).toEqual({})
    expect(parsePath('/app/~/board/all')).toEqual({ view: 'kanban' })
    expect(parsePath('/app/home/overview/all')).toEqual({ view: 'overview' })
    expect(parsePath('/app/acme/roadmap/all')).toEqual({ view: 'roadmap' })
    expect(parsePath('/app/home/board/all/tasks/qn-9')).toEqual({ view: 'kanban' })
    expect(parsePath('/app/~/board/all/tasks/qn-9')).toEqual({ view: 'kanban' })
    expect(parseHash('#/board/all')).toEqual({ view: 'kanban' })
    expect(parseHash('#/o/acme/roadmap/all/tasks/qn-5')).toEqual({ view: 'roadmap' })
    // `all` is no project either
    expect(parsePath('/app/home/board/p/all')).toEqual({ view: 'kanban', unheld: null })
    // and the view's bare address, which the startup rule serves, is what
    // the app writes for it
    expect(buildPath({ view: 'kanban' })).toBe('/app/home')
  })

  it('reads a task window open over My view, the org pinning only the task', () => {
    expect(parsePath('/app/home/board/mine/tasks/qn-9')).toEqual({
      view: 'kanban',
      scope: 'mine',
      issue: 'QN-9',
    })
    expect(parsePath('/app/acme/board/mine/tasks/qn-5')).toEqual({
      view: 'kanban',
      scope: 'mine',
      issue: 'uuid-acme-5',
    })
  })

  it('a sentinel never collides with a project reference', () => {
    expect(parsePath('/app/home/board/p/all')).toEqual({ view: 'kanban', unheld: null })
    expect(parsePath('/app/home/board/p/mine')).toEqual({ view: 'kanban', unheld: null })
  })

  it('names a project the workspace does not hold as App asks the server about it', () => {
    // by its number in the organization the address pins, `~` reading home
    expect(parsePath('/app/home/board/p/9')).toEqual({
      view: 'kanban',
      unheld: { org_id: HOME, num: 9 },
    })
    expect(parsePath('/app/acme/roadmap/p/7')).toEqual({
      view: 'roadmap',
      unheld: { org_id: ACME, num: 7 },
    })
    expect(parsePath('/app/~/p/9')).toEqual({ unheld: { org_id: HOME, num: 9 } })
    // by its uuid alone, lowercase
    expect(parsePath(`/app/home/board/p/${FAR.toUpperCase()}`)).toEqual({
      view: 'kanban',
      unheld: FAR,
    })
    // a number no project has, and an unpinned one with no home to read it in
    expect(parsePath('/app/home/board/p/0')).toEqual({ view: 'kanban', unheld: null })
    store.homeOrg = ''
    expect(parsePath('/app/~/board/p/9')).toEqual({ view: 'kanban', unheld: null })
    store.homeOrg = HOME
    // a held project is the scope, with no unheld; Team sync keeps its own form
    expect(parsePath('/app/home/board/p/7')).toEqual({ view: 'kanban', scope: 'p-home-7' })
    expect(parsePath('/app/home/sync/p/9')).toEqual({ sync: { scope: 'unresolved:9' } })
  })

  it('reads the full-screen pages', () => {
    expect(parsePath('/app/~/inbox')).toEqual({ inbox: true })
    expect(parsePath('/app/home/inbox/tasks/qn-9')).toEqual({ inbox: true, issue: 'QN-9' })
    expect(parsePath('/app/~/settings/account')).toEqual({ settings: 'account' })
    expect(parsePath('/app/~/settings/desktop')).toEqual({ settings: 'desktop' })
    expect(parsePath('/app/home/settings/org-general')).toEqual({ settings: 'org-general' })
    expect(parsePath('/app/home/settings/project/7')).toEqual({ settings: 'project:p-home-7' })
    expect(parsePath('/app/home/settings/projects-archived-tasks')).toEqual({
      settings: 'projects-archived-tasks',
    })
  })

  it('reads a project page’s uuid without the workspace, a held number through it, and any other segment as the account page', () => {
    const far = '7E1C2A4E-0000-4000-8000-0000000000AA'
    // the page's own read decides what a uuid shows, held or not
    expect(parsePath(`/app/home/settings/project/${far}`)).toEqual({
      settings: `project:${far.toLowerCase()}`,
    })
    expect(parsePath(`/app/~/settings/project/${far}`)).toEqual({
      settings: `project:${far.toLowerCase()}`,
    })
    // under a slug this login cannot resolve, nothing past the page
    expect(parsePath(`/app/nowhere/settings/project/${far}`)).toEqual({ settings: 'account' })
    // a segment that is neither
    expect(parsePath('/app/home/settings/project/not-a-project')).toEqual({ settings: 'account' })
    expect(parseHash(`#/o/home/settings/project/${far}`)).toEqual({
      settings: `project:${far.toLowerCase()}`,
    })
  })

  it('reads a number the workspace does not hold as a numbered page in the organization the address names, never another', () => {
    // a held number is the page by id, in the organization the address pins
    expect(parsePath('/app/home/settings/project/1')).toEqual({ settings: 'project:p-home-1' })
    expect(parsePath('/app/acme/settings/project/1')).toEqual({ settings: 'project:p-acme-1' })
    // an unheld one is the numbered page of that organization
    expect(parsePath('/app/home/settings/project/99')).toEqual({
      settings: numberedProjectPage(HOME, 99),
    })
    expect(parsePath('/app/acme/settings/project/7')).toEqual({
      settings: numberedProjectPage(ACME, 7),
    })
    expect(parseHash('#/o/acme/settings/project/7')).toEqual({
      settings: numberedProjectPage(ACME, 7),
    })
    // `~` reads it in the home organization only
    expect(parsePath('/app/~/settings/project/99')).toEqual({
      settings: numberedProjectPage(HOME, 99),
    })
    expect(parseHash('#/settings/project/99')).toEqual({ settings: numberedProjectPage(HOME, 99) })
    // the key names the number by itself, which no uuid page can be
    expect(numberedProjectPage(HOME, 99)).toBe(`project:${HOME}/99`)
    expect(projectPageRef(numberedProjectPage(ACME, 7))).toEqual({ org_id: ACME, num: 7 })
    expect(projectPageRef('project:p-home-7')).toEqual({ id: 'p-home-7' })
    expect(projectPageRef('account')).toBeNull()
    expect(projectPageRef(`project:${HOME}/0`)).toBeNull()
    // a login without a home organization reads no number under `~`
    store.homeOrg = ''
    expect(parsePath('/app/~/settings/project/99')).toEqual({ settings: 'account' })
    expect(parsePath('/app/acme/settings/project/7')).toEqual({
      settings: numberedProjectPage(ACME, 7),
    })
    store.homeOrg = HOME
    // a slug this login cannot resolve names nothing past the page
    expect(parsePath('/app/nowhere/settings/project/7')).toEqual({ settings: 'account' })
    // a number outside 1 to Number.MAX_SAFE_INTEGER is the account page
    for (const n of ['0', '00', String(Number.MAX_SAFE_INTEGER + 1), '1e3', '-3', '1.5'])
      expect(parsePath(`/app/home/settings/project/${n}`), n).toEqual({ settings: 'account' })
    expect(parsePath(`/app/home/settings/project/${Number.MAX_SAFE_INTEGER}`)).toEqual({
      settings: numberedProjectPage(HOME, Number.MAX_SAFE_INTEGER),
    })
  })

  it("reads an unpinned number in the home organization before any project the workspace holds, never as another organization's project of that number", () => {
    // Acme's project 99 is held, Home's project 99 is not
    store.projects = [...store.projects, project('p-acme-99', 99, ACME)]
    expect(parsePath('/app/~/settings/project/99')).toEqual({
      settings: numberedProjectPage(HOME, 99),
    })
    expect(parseHash('#/settings/project/99')).toEqual({ settings: numberedProjectPage(HOME, 99) })
    // pinned to Acme, the number is Acme's held project
    expect(parsePath('/app/acme/settings/project/99')).toEqual({ settings: 'project:p-acme-99' })
    expect(parseHash('#/o/acme/settings/project/99')).toEqual({ settings: 'project:p-acme-99' })
    // a view's project address and Team sync's read it the same way
    expect(parsePath('/app/~/board/p/99')).toEqual({
      view: 'kanban',
      unheld: { org_id: HOME, num: 99 },
    })
    expect(parseHash('#/board/p/99')).toEqual({ view: 'kanban', unheld: { org_id: HOME, num: 99 } })
    expect(parsePath('/app/~/sync/p/99')).toEqual({ sync: { scope: 'unresolved:99' } })
    // a login without a home organization holds no project by an unpinned
    // number, though projects 1 of Home and of Acme are both held
    store.homeOrg = ''
    expect(parsePath('/app/~/settings/project/1')).toEqual({ settings: 'account' })
    expect(parseHash('#/settings/project/1')).toEqual({ settings: 'account' })
    expect(parsePath('/app/~/board/p/1')).toEqual({ view: 'kanban', unheld: null })
    expect(parsePath('/app/acme/settings/project/1')).toEqual({ settings: 'project:p-acme-1' })
    store.homeOrg = HOME
  })

  it('names a numbered page by the number it was opened by, through a reload, Back and Forward', () => {
    const page = { settingsPage: numberedProjectPage(ACME, 7) }
    expect(buildPath(page)).toBe('/app/acme/settings/project/7')
    expect(parsePath(buildPath(page))).toEqual({ settings: page.settingsPage })
    expect(pathMatchesState('/app/acme/settings/project/7', page)).toBe(true)
    // `~` reads in the home organization, and the address names its slug
    const home = { settingsPage: numberedProjectPage(HOME, 99) }
    expect(buildPath(home)).toBe('/app/home/settings/project/99')
    expect(pathMatchesState('/app/~/settings/project/99', home)).toBe(true)
    // another number, or another page, is another page
    expect(pathMatchesState('/app/acme/settings/project/8', page)).toBe(false)
    expect(pathMatchesState('/app/acme/settings/account', page)).toBe(false)
    // once the workspace holds the project, its address parses to the page
    // by id, and still names this numbered page in place
    store.projects = [...store.projects, project('p-acme-7', 7, ACME)]
    expect(parsePath('/app/acme/settings/project/7')).toEqual({ settings: 'project:p-acme-7' })
    expect(namesProjectPage('/app/acme/settings/project/7', page.settingsPage)).toBe(true)
    expect(namesProjectPage('/app/home/settings/project/7', page.settingsPage)).toBe(false)
    expect(pathMatchesState('/app/acme/settings/project/7', page)).toBe(true)
    // an organization that left can no longer be named, and `~` would read
    // the number at home, so the address names the account page instead
    store.orgs = store.orgs.filter((o) => o.id !== ACME)
    expect(buildPath(page)).toBe('/app/~/settings/account')
  })

  it('opens Settings › Archived tasks at the old Archive address, rewritten in place', () => {
    const page = { settings: 'projects-archived-tasks' }
    expect(parsePath('/app/~/archive')).toEqual(page)
    expect(parsePath('/app/home/archive')).toEqual(page)
    const state = { scope: 'p-home-7', view: 'kanban', settingsPage: 'projects-archived-tasks' }
    expect(buildPath(state)).toBe('/app/home/settings/projects-archived-tasks')
    // the old address names the same page, so it is replaced, not stacked
    expect(pathMatchesState('/app/~/archive', state)).toBe(true)
  })

  it('old view names still parse — split and resources folded into the roadmap', () => {
    expect(parsePath('/app/home/split/p/7')!.view).toBe('roadmap')
    expect(parsePath('/app/home/resources/p/7')!.view).toBe('roadmap')
  })
})

describe('buildPath', () => {
  it('names the owning organization for content that has one', () => {
    expect(buildPath({ scope: 'p-home-7', view: 'kanban' })).toBe('/app/home/board/p/7')
    expect(buildPath({ scope: 'p-acme-1', view: 'roadmap' })).toBe('/app/acme/roadmap/p/1')
    expect(buildPath({ scope: 'p-home-7', view: 'kanban', openIssue: 'QN-9' })).toBe(
      '/app/home/board/tasks/qn-9',
    )
    expect(buildPath({ scope: 'p-home-7', view: 'kanban', openIssue: 'uuid-acme-5' })).toBe(
      '/app/acme/board/tasks/qn-5',
    )
  })

  it('names NO organization for the addresses that are about none', () => {
    // both sentinels span every org; the inbox does too; an account page is
    // about a person
    expect(buildPath({ scope: 'mine', view: 'kanban' })).toBe('/app/~/board/mine')
    expect(buildPath({ scope: 'mine', view: 'overview' })).toBe('/app/~/overview/mine')
    expect(buildPath({ inboxOpen: true })).toBe('/app/~/inbox')
    expect(buildPath({ settingsPage: 'account' })).toBe('/app/~/settings/account')
    expect(buildPath({ settingsPage: 'desktop' })).toBe('/app/~/settings/desktop')
  })

  it('keeps the address of a project settings page whose project left while it shows', () => {
    const gone = new Set<string>()
    const live = store.project
    store.project = (id: string) => (gone.has(id) ? undefined : live(id))
    expect(buildPath({ settingsPage: 'project:p-home-7' })).toBe('/app/home/settings/project/7')
    // someone else archives or deletes it while its Archive or delete window is open
    gone.add('p-home-7')
    expect(buildPath({ settingsPage: 'project:p-home-7' })).toBe('/app/home/settings/project/7')
    expect(
      pathMatchesState('/app/home/settings/project/7', { settingsPage: 'project:p-home-7' }),
    ).toBe(true)
    // a project this page never named is still named by its id
    expect(buildPath({ settingsPage: 'project:p-gone' })).toBe('/app/~/settings/project/p-gone')
    // once the project's organization left too, by its id, never the
    // number of a home project, and that address replaces the old one
    expect(buildPath({ settingsPage: 'project:p-acme-1' })).toBe('/app/acme/settings/project/1')
    gone.add('p-acme-1')
    store.orgs = store.orgs.filter((o) => o.id !== ACME)
    expect(buildPath({ settingsPage: 'project:p-acme-1' })).toBe('/app/~/settings/project/p-acme-1')
    expect(
      pathMatchesState('/app/acme/settings/project/1', { settingsPage: 'project:p-acme-1' }),
    ).toBe(true)
    expect(
      pathMatchesState('/app/acme/settings/project/2', { settingsPage: 'project:p-acme-1' }),
    ).toBe(false)
  })

  it('names a page whose project the workspace does not hold by its uuid under the organization its read named, in place', () => {
    const far = '7e1c2a4e-0000-4000-8000-0000000000bb'
    const page = { settingsPage: `project:${far}` }
    const rev = projectPagesRev()
    // before its read answers, by its id under no organization
    expect(buildPath(page)).toBe(`/app/~/settings/project/${far}`)
    noteProjectPage(far, { org: ACME })
    expect(projectPagesRev()).toBe(rev + 1)
    // the same note again changes nothing
    noteProjectPage(far, { org: ACME })
    expect(projectPagesRev()).toBe(rev + 1)
    expect(buildPath(page)).toBe(`/app/acme/settings/project/${far}`)
    // the new address replaces the old one, whose org segment alone differs
    expect(pathMatchesState(`/app/~/settings/project/${far}`, page)).toBe(true)
    // and parses back to the same page, so a reload and Back open it again
    expect(parsePath(`/app/acme/settings/project/${far}`)).toEqual({ settings: page.settingsPage })
    noteProjectPage(far, null)
    expect(buildPath(page)).toBe(`/app/~/settings/project/${far}`)
  })

  it('names the page of a project last opened by its number by that number, also by its id', () => {
    const far = '7e1c2a4e-0000-4000-8000-0000000000dd'
    const numbered = { settingsPage: numberedProjectPage(ACME, 41) }
    const byId = { settingsPage: `project:${far}` }
    // the numbered page's read names the project and the number it opened by
    noteProjectPage(far, { org: ACME, num: 41 })
    expect(buildPath(numbered)).toBe('/app/acme/settings/project/41')
    expect(buildPath(byId)).toBe('/app/acme/settings/project/41')
    // so a sub-project's Back to it by id finds the address it came from,
    // and that address names the page by id in place
    expect(namesProjectPage('/app/acme/settings/project/41', byId.settingsPage)).toBe(true)
    expect(pathMatchesState('/app/acme/settings/project/41', byId)).toBe(true)
    expect(namesProjectPage('/app/acme/settings/project/42', byId.settingsPage)).toBe(false)
    // a read of the page by id keeps the number, in the same organization
    noteProjectPage(far, { org: ACME })
    expect(buildPath(byId)).toBe('/app/acme/settings/project/41')
    // once its organization cannot be named, by its uuid, as `~` would read
    // the number at home
    const orgs = store.orgs
    store.orgs = orgs.filter((o) => o.id !== ACME)
    expect(buildPath(byId)).toBe(`/app/~/settings/project/${far}`)
    expect(namesProjectPage('/app/~/settings/project/41', byId.settingsPage)).toBe(false)
    store.orgs = orgs
    // a page opened by id alone keeps its uuid
    noteProjectPage(far, null)
    noteProjectPage(far, { org: ACME })
    expect(buildPath(byId)).toBe(`/app/acme/settings/project/${far}`)
    noteProjectPage(far, null)
  })

  it('moves a held page whose project left the workspace to its uuid once its read names it', () => {
    const near = '7e1c2a4e-0000-4000-8000-0000000000cc'
    let held = true
    const live = store.project
    store.project = (id: string) =>
      id === near ? (held ? project(near, 3, ACME) : undefined) : live(id)
    const page = { settingsPage: `project:${near}` }
    expect(buildPath(page)).toBe('/app/acme/settings/project/3')
    // it leaves the workspace and stays readable; while a window holds the
    // page nothing notes it, and the number stays
    held = false
    expect(buildPath(page)).toBe('/app/acme/settings/project/3')
    noteProjectPage(near, { org: ACME })
    expect(buildPath(page)).toBe(`/app/acme/settings/project/${near}`)
    expect(pathMatchesState('/app/acme/settings/project/3', page)).toBe(true)
    noteProjectPage(near, null)
  })

  it('the org settings pages ARE about an organization, so they name it', () => {
    expect(buildPath({ settingsPage: 'org-general' })).toBe('/app/home/settings/org-general')
    expect(buildPath({ settingsPage: 'org-users' })).toBe('/app/home/settings/org-users')
    expect(buildPath({ settingsPage: 'team:abc' })).toBe('/app/home/settings/team%3Aabc')
    // a project settings page follows the PROJECT's org — a guest can hold
    // lead on a foreign project
    expect(buildPath({ settingsPage: 'project:p-acme-1' })).toBe('/app/acme/settings/project/1')
  })

  it("a task open over a sentinel names the TASK's org, keeping the mode", () => {
    expect(buildPath({ scope: 'mine', view: 'kanban', openIssue: 'QN-9' })).toBe(
      '/app/home/board/mine/tasks/qn-9',
    )
    expect(buildPath({ scope: 'mine', view: 'kanban', openIssue: 'uuid-acme-5' })).toBe(
      '/app/acme/board/mine/tasks/qn-5',
    )
    expect(buildPath({ scope: 'mine', view: 'kanban', openIssue: 'uuid-acme-5' })).toBe(
      '/app/acme/board/mine/tasks/qn-5',
    )
  })

  it('keeps naming a task that left the store, in its organization, while its window shows', () => {
    expect(buildPath({ inboxOpen: true, openIssue: 'QN-9' })).toBe('/app/home/inbox/tasks/qn-9')
    expect(buildPath({ scope: 'mine', view: 'kanban', openIssue: 'uuid-acme-5' })).toBe(
      '/app/acme/board/mine/tasks/qn-5',
    )
    // someone else archives or deletes them while their windows are open
    delete store.issueById['QN-9']
    delete store.issueById['uuid-acme-5']
    expect(buildPath({ inboxOpen: true, openIssue: 'QN-9' })).toBe('/app/home/inbox/tasks/qn-9')
    expect(buildPath({ scope: 'mine', view: 'kanban', openIssue: 'uuid-acme-5' })).toBe(
      '/app/acme/board/mine/tasks/qn-5',
    )
    // so the address the window had stays, without a new entry
    expect(
      pathMatchesState('/app/home/inbox/tasks/qn-9', { inboxOpen: true, openIssue: 'QN-9' }),
    ).toBe(true)
    // a handle the address never named still names no organization
    expect(buildPath({ inboxOpen: true, openIssue: 'QN-404' })).toBe('/app/~/inbox/tasks/qn-404')
  })

  it('names a task the store does not hold by the organization and key its reference names', () => {
    // as Search opens an archived home task, and a guest seat's
    const home40 = taskRef({ org: HOME, num: 40, uuid: 'uuid-home-40' })
    const acme8 = taskRef({ org: ACME, num: 8, uuid: 'uuid-acme-8' })
    expect(buildPath({ view: 'kanban', openIssue: home40 })).toBe('/app/home/board/tasks/qn-40')
    expect(buildPath({ scope: 'mine', view: 'kanban', openIssue: acme8 })).toBe(
      '/app/acme/board/mine/tasks/qn-8',
    )
    // never under ~, where QN-8 would read as the home organization's task
    expect(buildPath({ inboxOpen: true, openIssue: acme8 })).toBe('/app/acme/inbox/tasks/qn-8')
    // an Inbox row's reference, which names no number, by its uuid until a
    // read names its key
    const row = taskRef({ org: ACME, uuid: FAR })
    expect(buildPath({ inboxOpen: true, openIssue: row })).toBe(`/app/acme/inbox/tasks/${FAR}`)
    store.reference = {
      ref: row,
      state: 'resolved',
      task: { uuid: FAR, org: ACME, num: 12, project: 'p-acme-1' },
    }
    expect(buildPath({ inboxOpen: true, openIssue: row })).toBe('/app/acme/inbox/tasks/qn-12')
    // and that address names the same task, so it changes in place
    expect(
      pathMatchesState(`/app/acme/inbox/tasks/${FAR}`, { inboxOpen: true, openIssue: row }),
    ).toBe(true)
    // a handle nothing names still names no organization
    expect(buildPath({ scope: 'mine', view: 'kanban', openIssue: 'uuid-acme-9' })).toBe(
      '/app/~/board/mine/tasks/uuid-acme-9',
    )
  })

  it('reads the address of a task the store does not hold as a reference, in its own organization only', () => {
    const home41 = taskRef({ org: HOME, num: 41 })
    const acme41 = taskRef({ org: ACME, num: 41 })
    expect(parsePath('/app/home/board/mine/tasks/qn-41')?.issue).toBe(home41)
    expect(parsePath('/app/acme/board/mine/tasks/qn-41')?.issue).toBe(acme41)
    // `~` reads a number in the home organization
    expect(parsePath('/app/~/board/tasks/41')?.issue).toBe(home41)
    // a uuid names a task anywhere, read first in the organization named
    expect(refParts(parsePath(`/app/acme/inbox/tasks/${FAR.toUpperCase()}`)?.issue)).toEqual({
      org: null,
      uuid: FAR,
      from: ACME,
    })
    expect(refParts(parsePath(`/app/~/inbox/tasks/${FAR}`)?.issue)).toEqual({
      org: null,
      uuid: FAR,
    })
    // so the window's address is its state, by the task's identity, and the
    // page's is not
    const opened = taskRef({ org: ACME, num: 41, uuid: 'uuid-acme-41' })
    expect(
      pathMatchesState('/app/acme/board/mine/tasks/qn-41', {
        scope: 'mine',
        view: 'kanban',
        openIssue: opened,
      }),
    ).toBe(true)
    expect(
      pathMatchesState('/app/acme/board/mine/tasks/qn-41', {
        scope: 'mine',
        view: 'kanban',
        openIssue: null,
      }),
    ).toBe(false)
    // another organization's task with that number is another task
    expect(sameTask(parsePath('/app/home/board/mine/tasks/qn-41')?.issue, opened)).toBe(false)
  })

  it('reads a pinned number in its own organization only, never as the home task of that number', () => {
    // Acme holds no QN-9, Home does: Acme's address is Acme's QN-9
    expect(parsePath('/app/acme/board/tasks/qn-9')?.issue).toBe(taskRef({ org: ACME, num: 9 }))
    expect(parsePath('/app/acme/board/tasks/qn-9')?.issue).not.toBe('QN-9')
    expect(parseHash('#/o/acme/tasks/qn-9')?.issue).toBe(taskRef({ org: ACME, num: 9 }))
    // Home holds no QN-6, so neither does its address read Acme's
    expect(parsePath('/app/home/tasks/qn-6')?.issue).toBe(taskRef({ org: HOME, num: 6 }))
    // a login without a home organization reads no number under ~
    store.homeOrg = ''
    expect(parsePath('/app/~/tasks/qn-6')?.issue).toBeUndefined()
    expect(parseHash('#/tasks/qn-6')?.issue).toBeUndefined()
    // a slug the login cannot resolve resolves nothing, uuid included
    expect(parsePath('/app/globex/tasks/qn-6')?.issue).toBeUndefined()
    expect(parsePath(`/app/globex/tasks/${FAR}`)?.issue).toBeUndefined()
  })

  it('answers a held uuid by its handle without walking the tasks, and a ref no task can have with none', () => {
    store.issues = new Proxy(store.issues, {
      get(target, key) {
        if (key === 'find' || key === 'filter' || key === Symbol.iterator)
          throw new Error('the router walked every task')
        return Reflect.get(target, key)
      },
    })
    store.handleOf = (uuid) => (uuid === 'uuid-acme-5' ? 'uuid-acme-5' : null)
    expect(parsePath('/app/home/tasks/UUID-ACME-5')?.issue).toBe('uuid-acme-5')
    expect(parsePath('/app/home/tasks/not-a-task')?.issue).toBeUndefined()
    expect(parsePath('/app/home/tasks/qn-0')?.issue).toBeUndefined()
  })

  it('pins a reference to its organization through a change of the home organization', () => {
    const home43 = taskRef({ org: HOME, num: 43 })
    expect(parsePath('/app/home/board/mine/tasks/qn-43')?.issue).toBe(home43)
    // Home becomes a guest seat and Acme the home organization, where an
    // active QN-43 exists
    store.homeOrg = ACME
    const acme43 = {
      id: 'QN-43',
      key: 'QN-43',
      uuid: 'uuid-acme-43',
      org: ACME,
      project: 'p-acme-1',
      assignee: 'me',
    }
    store.issues = [...store.issues, acme43]
    store.issueById['QN-43'] = acme43
    store.issueRefIn = (org: string, key: string) =>
      store.issues.find((i) => i.org === org && i.key === key)?.id ?? null
    // Home's address still names Home's task, never Acme's QN-43
    expect(parsePath('/app/home/board/mine/tasks/qn-43')?.issue).toBe(home43)
    expect(sameTask(home43, 'QN-43')).toBe(false)
    // Acme's address, and `~`, now read the home organization's live QN-43
    expect(parsePath('/app/acme/board/mine/tasks/qn-43')?.issue).toBe('QN-43')
    expect(parsePath('/app/~/board/tasks/43')?.issue).toBe('QN-43')
    // and the window on Home's task names Home's address, by its key
    expect(buildPath({ scope: 'mine', view: 'kanban', openIssue: home43 })).toBe(
      '/app/home/board/mine/tasks/qn-43',
    )
  })

  it('names the task a handle opens now, not the one it named before the home organization changed', () => {
    // Home's QN-19, which nothing named before, as no other test does
    const home19 = { ...store.issueById['QN-5'], id: 'QN-19', key: 'QN-19', uuid: 'uuid-home-19' }
    store.issues = [...store.issues, home19]
    store.issueById['QN-19'] = home19
    // the window on it names it by Home's address
    expect(buildPath({ view: 'kanban', openIssue: 'QN-19' })).toBe('/app/home/board/tasks/qn-19')
    expect(issueLink('QN-19')).toBe('/app/home/tasks/qn-19')
    // Acme becomes the home organization: Home's QN-19 opens by its uuid,
    // and QN-19 is the handle of Acme's QN-19, which has not loaded
    store.homeOrg = ACME
    store.issues = store.issues.map((i) => (i === home19 ? { ...i, id: 'uuid-home-19' } : i))
    store.issueById = Object.fromEntries(store.issues.map((i) => [i.id, i] as const))
    store.issueRefIn = (org: string, key: string) =>
      store.issues.find((i) => i.org === org && i.key === key)?.id ?? null
    // QN-19 reads in the home organization, never as Home's task
    expect(issueLink('QN-19')).toBe('/app/~/tasks/qn-19')
    expect(buildPath({ view: 'kanban', openIssue: 'QN-19' })).toBe('/app/~/board/tasks/qn-19')
    // and once a window shows Acme's QN-19 from its own read, by Acme's address
    store.detail = {
      task: 'uuid-acme-19',
      view: { ...home19, id: 'QN-19', uuid: 'uuid-acme-19', org: ACME, project: 'p-acme-1' },
    }
    expect(issueLink('QN-19')).toBe('/app/acme/tasks/qn-19')
    expect(buildPath({ view: 'kanban', openIssue: 'QN-19' })).toBe('/app/acme/board/tasks/qn-19')
    // Home's task keeps its own address by its new handle
    expect(issueLink('uuid-home-19')).toBe('/app/home/tasks/qn-19')
  })

  it('names a task that left the store by its new handle after the home organization changed', () => {
    // Home's QN-21 is open, then archived: it leaves the store, and the
    // address goes on naming it
    const home21 = { ...store.issueById['QN-5'], id: 'QN-21', key: 'QN-21', uuid: 'uuid-home-21' }
    store.issues = [...store.issues, home21]
    store.issueById['QN-21'] = home21
    expect(buildPath({ view: 'kanban', openIssue: 'QN-21' })).toBe('/app/home/board/tasks/qn-21')
    store.issues = store.issues.filter((i) => i !== home21)
    delete store.issueById['QN-21']
    expect(buildPath({ view: 'kanban', openIssue: 'QN-21' })).toBe('/app/home/board/tasks/qn-21')
    // Acme becomes the home organization, and the window follows the task
    // to the handle it opens by now, its uuid (P.watchHandles)
    store.homeOrg = ACME
    expect(buildPath({ view: 'kanban', openIssue: 'uuid-home-21' })).toBe(
      '/app/home/board/tasks/qn-21',
    )
    expect(issueLink('uuid-home-21')).toBe('/app/home/tasks/qn-21')
    // and its old handle names the home organization's QN-21, never Home's
    expect(issueLink('QN-21')).toBe('/app/~/tasks/qn-21')
  })

  it("names a task by its uuid once its organization left too, never the home organization's task of that number", () => {
    const open = 'uuid-acme-5'
    const sync = { scope: 'all', step: 'team' }
    expect(buildPath({ inboxOpen: true, openIssue: open })).toBe('/app/acme/inbox/tasks/qn-5')
    expect(buildPath({ sync, openIssue: open })).toBe('/app/home/sync/all/tasks/uuid-acme-5')
    // the person loses their seat in Acme: its organization and tasks go
    store.orgs = store.orgs.filter((o) => o.id !== ACME)
    store.issues = store.issues.filter((i) => i.org !== ACME)
    delete store.issueById[open]
    const paths = [
      buildPath({ inboxOpen: true, openIssue: open }),
      buildPath({ scope: 'mine', view: 'kanban', openIssue: open }),
      buildPath({ view: 'kanban', openIssue: open }),
      buildPath({ sync, openIssue: open }),
    ]
    expect(paths).toEqual([
      '/app/~/inbox/tasks/uuid-acme-5',
      '/app/~/board/mine/tasks/uuid-acme-5',
      '/app/~/board/tasks/uuid-acme-5',
      '/app/home/sync/all/tasks/uuid-acme-5',
    ])
    // so a reload or a Back to them opens no task, not the home QN-5
    for (const path of paths) expect(parsePath(path)?.issue).not.toBe('QN-5')
    // and each replaces the address that named the task before, in place
    expect(
      pathMatchesState('/app/acme/inbox/tasks/qn-5', { inboxOpen: true, openIssue: open }),
    ).toBe(true)
    expect(
      pathMatchesState('/app/acme/board/mine/tasks/qn-5', {
        scope: 'mine',
        view: 'kanban',
        openIssue: open,
      }),
    ).toBe(true)
    // also when the organization's address changed after the task left
    store.orgs = [...store.orgs, { id: ACME, slug: 'acme' } as (typeof store.orgs)[number]]
    store.issueById[open] = { ...store.issues[0], id: open, uuid: open, key: 'QN-5', org: ACME }
    expect(buildPath({ inboxOpen: true, openIssue: open })).toBe('/app/acme/inbox/tasks/qn-5')
    delete store.issueById[open]
    store.orgs = store.orgs.map((o) => (o.id === ACME ? { ...o, slug: 'acme2' } : o))
    expect(buildPath({ inboxOpen: true, openIssue: open })).toBe('/app/acme2/inbox/tasks/qn-5')
    store.orgs = store.orgs.filter((o) => o.id !== ACME)
    expect(
      pathMatchesState('/app/acme2/inbox/tasks/qn-5', { inboxOpen: true, openIssue: open }),
    ).toBe(true)
    // while another task's address, or another page's, is still a move
    expect(
      pathMatchesState('/app/acme/inbox/tasks/qn-6', { inboxOpen: true, openIssue: open }),
    ).toBe(false)
    expect(
      pathMatchesState('/app/acme/board/mine/tasks/qn-5', { inboxOpen: true, openIssue: open }),
    ).toBe(false)
  })

  it("leaves out a task opened by number once its organization left, never naming the home organization's task of that number", () => {
    // a link to Acme's QN-5 whose read has not named its uuid
    const acme5 = taskRef({ org: ACME, num: 5 })
    const sync = { scope: 'all', step: 'team' }
    expect(buildPath({ view: 'kanban', openIssue: acme5 })).toBe('/app/acme/board/tasks/qn-5')
    // the person loses their seat in Acme
    store.orgs = store.orgs.filter((o) => o.id !== ACME)
    const paths = [
      buildPath({ inboxOpen: true, openIssue: acme5 }),
      buildPath({ scope: 'mine', view: 'kanban', openIssue: acme5 }),
      buildPath({ scope: 'p-home-7', view: 'kanban', openIssue: acme5 }),
      buildPath({ sync, openIssue: acme5 }),
      issueLink(acme5),
    ]
    expect(paths).toEqual([
      '/app/~/inbox',
      '/app/~/board/mine',
      '/app/home/board/p/7',
      '/app/home/sync/all',
      '/app/~',
    ])
    // so a reload or a Back opens no task, not the home QN-5
    for (const path of paths) expect(sameTask(parsePath(path)?.issue, 'QN-5'), path).toBe(false)
    // a uuid still names it
    const named = taskRef({ org: ACME, num: 5, uuid: 'uuid-acme-5' })
    expect(buildPath({ view: 'kanban', openIssue: named })).toBe('/app/~/board/tasks/uuid-acme-5')
  })

  it('full-screen pages still outrank the scope', () => {
    expect(buildPath({ scope: 'mine', view: 'kanban', inboxOpen: true })).toBe('/app/~/inbox')
    expect(buildPath({ scope: 'mine', view: 'kanban', settingsPage: 'account' })).toBe(
      '/app/~/settings/account',
    )
  })

  it('a state with no project to name falls back to the org front door', () => {
    // a brand-new organization with no projects: parses back to null, so the
    // saved UI state survives the round trip rather than being reset
    expect(buildPath({ view: 'kanban' })).toBe('/app/home')
    expect(parsePath(buildPath({ view: 'kanban' }))).toBeNull()
  })

  it('round-trips every emitted form', () => {
    for (const s of [
      { scope: 'mine', view: 'overview' },
      { scope: 'mine', view: 'kanban' },
      { scope: 'mine', view: 'roadmap' },
      { scope: 'mine', view: 'kanban', openIssue: 'QN-9' },
      { scope: 'mine', view: 'overview' },
      { scope: 'mine', view: 'kanban' },
      { scope: 'mine', view: 'kanban', openIssue: 'QN-9' },
      { scope: 'p-home-7', view: 'roadmap' },
      { scope: 'p-acme-1', view: 'kanban' },
      { scope: 'p-home-7', view: 'kanban', openIssue: 'uuid-acme-5' },
    ] as UiState[]) {
      const r = parsePath(buildPath(s))!
      expect(r.scope || null).toBe(s.scope && !s.openIssue ? s.scope : r.scope || null)
      expect(r.view).toBe(s.view)
      expect(r.issue || null).toBe(s.openIssue || null)
    }
    // a reference round-trips to the same task
    for (const open of [
      taskRef({ org: HOME, num: 40 }),
      taskRef({ org: ACME, num: 8, uuid: FAR }),
    ]) {
      const r = parsePath(buildPath({ scope: 'mine', view: 'kanban', openIssue: open }))!
      expect(sameTask(r.issue, open)).toBe(true)
    }
  })
})

describe('sameTask, whether two names name one task', () => {
  it('compares by uuid, or by number in one organization, never by the strings alone', () => {
    const home5 = taskRef({ org: HOME, num: 5 })
    // a reference and the handle it moves to name one task
    expect(sameTask(home5, 'QN-5')).toBe(true)
    expect(sameTask(taskRef({ org: null, uuid: 'uuid-acme-5' }), 'uuid-acme-5')).toBe(true)
    // the same number in another organization does not
    expect(sameTask(taskRef({ org: ACME, num: 5 }), 'QN-5')).toBe(false)
    expect(sameTask(home5, 'uuid-acme-5')).toBe(false)
    // nor does a uuid the store cannot tell is that task yet
    expect(sameTask(taskRef({ org: null, uuid: FAR }), taskRef({ org: ACME, num: 8 }))).toBe(false)
    expect(sameTask(null, 'QN-5')).toBe(false)
  })

  it("tells another organization's task of a held task's id apart from it", () => {
    // ACME's held task and HOME's task of the same id, which the store does not hold
    const homeCopy = taskRef({ org: HOME, num: 12, uuid: 'uuid-acme-5' })
    expect(sameTask(homeCopy, 'uuid-acme-5')).toBe(false)
    expect(sameTask(homeCopy, taskRef({ org: ACME, uuid: 'uuid-acme-5' }))).toBe(false)
    // the same id in the same organization, or with none named yet, is one task
    expect(sameTask(taskRef({ org: ACME, num: 5, uuid: 'uuid-acme-5' }), 'uuid-acme-5')).toBe(true)
    expect(sameTask(homeCopy, taskRef({ org: null, uuid: 'uuid-acme-5' }))).toBe(true)
  })

  it('never reads a reference as a handle', () => {
    // a reference that looked up as a handle would open the home QN-5
    const acme5 = taskRef({ org: ACME, num: 5 })
    store.issueById[acme5] = store.issueById['QN-5']
    expect(sameTask(acme5, 'QN-5')).toBe(false)
    expect(buildPath({ view: 'kanban', openIssue: acme5 })).toBe('/app/acme/board/tasks/qn-5')
    expect(refParts('QN-5')).toBeUndefined()
    expect(refParts('uuid-acme-5')).toBeUndefined()
    expect(refParts(acme5)).toEqual({ org: ACME, num: 5 })
  })
})

describe('issueLink — the shareable short form', () => {
  it("names the task's own organization", () => {
    expect(issueLink('QN-9')).toBe('/app/home/tasks/qn-9')
    expect(issueLink('uuid-acme-5')).toBe('/app/acme/tasks/qn-5')
  })

  it('round-trips to the task it names, across the org collision', () => {
    expect(parsePath(issueLink('QN-5'))!.issue).toBe('QN-5')
    expect(parsePath(issueLink('uuid-acme-5'))!.issue).toBe('uuid-acme-5')
  })

  it('names a task the store does not hold by its organization and key, never under ~', () => {
    // as a related row opens a subtask the workspace does not hold yet, in
    // the home organization and in a guest seat's
    expect(issueLink(taskRef({ org: HOME, num: 60, uuid: 'uuid-home-60' }))).toBe(
      '/app/home/tasks/qn-60',
    )
    const acme61 = taskRef({ org: ACME, num: 61, uuid: 'uuid-acme-61' })
    expect(issueLink(acme61)).toBe('/app/acme/tasks/qn-61')
    expect(sameTask(parsePath(issueLink(acme61))!.issue, acme61)).toBe(true)
    // the window's own read names a handle the workspace does not hold
    store.detail = {
      task: 'uuid-acme-62',
      view: { ...store.issueById['uuid-acme-5'], id: 'uuid-acme-62', uuid: 'uuid-acme-62' },
    }
    expect(issueLink('uuid-acme-62')).toBe('/app/acme/tasks/qn-5')
    // a handle nothing names still names no organization
    store.detail = null
    expect(issueLink('uuid-acme-62')).toBe('/app/~/tasks/uuid-acme-62')
    // nor does a uuid alone while its organization is not known
    expect(issueLink(taskRef({ org: null, uuid: FAR }))).toBe(`/app/~/tasks/${FAR}`)
  })

  it('names a task that left the store while its window showed it', () => {
    // the window's address named it while the store held it
    buildPath({ view: 'kanban', openIssue: 'uuid-acme-5' })
    store.issues = store.issues.filter((i) => i.id !== 'uuid-acme-5')
    store.issueById = Object.fromEntries(store.issues.map((i) => [i.id, i] as const))
    expect(issueLink('uuid-acme-5')).toBe('/app/acme/tasks/qn-5')
    // once its organization left too, its uuid names it
    store.orgs = store.orgs.filter((o) => o.id !== ACME)
    expect(issueLink('uuid-acme-5')).toBe('/app/~/tasks/uuid-acme-5')
  })
})

describe('parseHash — shared route grammar', () => {
  it('reads project and task forms', () => {
    expect(parseHash('#/board/p/1')).toEqual({ view: 'kanban', scope: 'p-home-1' })
    expect(parseHash('#/o/acme/board/p/1')).toEqual({ view: 'kanban', scope: 'p-acme-1' })
    expect(parseHash('#/tasks/qn-5')!.issue).toBe('QN-5')
    expect(parseHash('#/tasks/5')!.issue).toBe('QN-5')
    expect(parseHash('#/o/acme/tasks/qn-5')!.issue).toBe('uuid-acme-5')
  })

  it('reads sentinel and page forms', () => {
    expect(parseHash('#/board/mine')).toEqual({ view: 'kanban', scope: 'mine' })
    expect(parseHash('#/board/mine/tasks/qn-9')).toEqual({
      view: 'kanban',
      scope: 'mine',
      issue: 'QN-9',
    })
    expect(parseHash('#/settings/org-general')).toEqual({ settings: 'org-general' })
    expect(parseHash('#/inbox')).toEqual({ inbox: true })
    expect(parseHash('#/archive')).toEqual({ settings: 'projects-archived-tasks' })
  })

  it('does not open tasks through former /i/ hash segments', () => {
    for (const hash of ['#/i/qn-5', '#/i/5', '#/o/acme/i/qn-5', '#/board/mine/i/qn-9']) {
      expect(parseHash(hash)?.issue).toBeUndefined()
    }
  })

  it('still ignores what is not an app route — auth fragments above all', () => {
    expect(parseHash('#access_token=abc')).toBeNull()
    expect(parseHash('#/')).toBeNull()
    expect(parseHash('')).toBeNull()
  })

  it('an unresolvable org prefix still resolves nothing', () => {
    expect(parseHash('#/o/globex/board/p/1')).toEqual({ view: 'kanban', unheld: null })
  })
})

describe('scopeForIssue', () => {
  it('keeps the preferred project when the issue lives inside it', () => {
    expect(scopeForIssue(scopeTask('QN-5'), 'p-home-1')).toBe('p-home-1') // via the parent's children
    expect(scopeForIssue(scopeTask('QN-5'), 'p-home-1a')).toBe('p-home-1a')
  })

  it("falls back to the issue's own sub-project otherwise", () => {
    expect(scopeForIssue(scopeTask('QN-5'), 'p-home-7')).toBe('p-home-1a')
    expect(scopeForIssue(scopeTask('QN-5'), null)).toBe('p-home-1a')
  })

  it('keeps no scope over all projects: such a token narrows to the task like any other', () => {
    expect(scopeForIssue(scopeTask('QN-5'), 'all')).toBe('p-home-1a')
    expect(scopeForIssue(scopeTask('uuid-acme-5'), 'all')).toBe('p-acme-1')
  })

  it("My view holds only MY tasks, so a short link to someone else's narrows", () => {
    expect(scopeForIssue(scopeTask('QN-5'), 'mine')).toBe('mine')
    // a seat in another organization is still me (0081)
    expect(scopeForIssue(scopeTask('uuid-acme-5'), 'mine')).toBe('mine')
    // …but this one is somebody else's: land on a board that actually shows it
    expect(scopeForIssue(scopeTask('QN-9'), 'mine')).toBe('p-home-7')
  })

  it('takes a task the store does not hold from its answer, and keeps the preferred scope until then', () => {
    expect(scopeForIssue(undefined, 'p-home-7')).toBe('p-home-7')
    expect(scopeForIssue({ project: 'p-acme-1', owner: 'someone-else' }, 'mine')).toBe('p-acme-1')
    expect(scopeForIssue({ project: 'p-acme-1', owner: 'me' }, 'mine')).toBe('mine')
  })
})

describe('pathMatchesState — replace in place vs. a new history entry', () => {
  it('the front door and a foreign path are overwritten in place', () => {
    expect(pathMatchesState('/app/home', { scope: 'mine', view: 'kanban' })).toBe(true)
    expect(pathMatchesState('/', { scope: 'mine', view: 'kanban' })).toBe(true)
  })

  it('the canonical path for a state matches it', () => {
    expect(pathMatchesState('/app/~/board/mine', { scope: 'mine', view: 'kanban' })).toBe(true)
    expect(
      pathMatchesState('/app/home/board/mine/tasks/qn-9', {
        scope: 'mine',
        view: 'kanban',
        openIssue: 'QN-9',
      }),
    ).toBe(true)
    expect(pathMatchesState('/app/home/board/p/7', { scope: 'p-home-7', view: 'kanban' })).toBe(
      true,
    )
  })

  it('changing scope is a navigation, not a normalization', () => {
    expect(pathMatchesState('/app/home/board/p/7', { scope: 'mine', view: 'kanban' })).toBe(false)
    expect(pathMatchesState('/app/~/board/mine', { scope: 'p-home-7', view: 'kanban' })).toBe(false)
  })

  it('entering or leaving a sentinel scope with a task open earns an entry', () => {
    // <view>/tasks/<issue> IS the project-scope form — it omits the scope segment
    // because the issue names its own project
    expect(
      pathMatchesState('/app/home/board/tasks/qn-9', {
        scope: 'mine',
        view: 'kanban',
        openIssue: 'QN-9',
      }),
    ).toBe(false)
    expect(
      pathMatchesState('/app/home/board/mine/tasks/qn-9', {
        scope: 'p-home-7',
        view: 'kanban',
        openIssue: 'QN-9',
      }),
    ).toBe(false)
    expect(
      pathMatchesState('/app/home/board/tasks/qn-9', {
        scope: 'mine',
        view: 'kanban',
        openIssue: 'QN-9',
      }),
    ).toBe(false)
  })

  it('moving between My view and a project earns one too, as they are different panes', () => {
    // the rule compares the sentinel by identity: entering or leaving My
    // view with the window open changes the pane behind the task
    expect(
      pathMatchesState('/app/home/board/mine/tasks/qn-9', {
        scope: 'p-home-7',
        view: 'kanban',
        openIssue: 'QN-9',
      }),
    ).toBe(false)
    expect(
      pathMatchesState('/app/home/board/tasks/qn-9', {
        scope: 'mine',
        view: 'kanban',
        openIssue: 'QN-9',
      }),
    ).toBe(false)
    expect(pathMatchesState('/app/~/board/mine', { scope: 'p-home-7', view: 'kanban' })).toBe(false)
    expect(pathMatchesState('/app/home/board/p/7', { scope: 'mine', view: 'kanban' })).toBe(false)
  })

  it('a viewless short link still normalizes in place — including into a sentinel scope', () => {
    // the boot path for /app/home/tasks/qn-9 with a saved sentinel scope: the path
    // names neither view nor scope, which is "not yet canonical", not
    // "somewhere else" — pushing here would leave a junk entry on every boot
    expect(
      pathMatchesState('/app/home/tasks/qn-9', {
        scope: 'mine',
        view: 'kanban',
        openIssue: 'QN-9',
      }),
    ).toBe(true)
    expect(
      pathMatchesState('/app/home/tasks/qn-9', {
        scope: 'mine',
        view: 'kanban',
        openIssue: 'QN-9',
      }),
    ).toBe(true)
    expect(
      pathMatchesState('/app/home/tasks/qn-9', {
        scope: 'p-home-7',
        view: 'kanban',
        openIssue: 'QN-9',
      }),
    ).toBe(true)
  })

  it('an address whose only difference is the ORG segment has MOVED, not navigated', () => {
    /* `organizations` is in the realtime publication, so an admin renaming the
       address re-emits in every colleague's open tab within a second. Pushing
       there would leave a history entry whose Back target is a slug that no
       longer resolves — which the app renders as "this organization isn't
       available to you". */
    expect(pathMatchesState('/app/oldname/board/p/7', { scope: 'p-home-7', view: 'kanban' })).toBe(
      true,
    )
    expect(
      pathMatchesState('/app/oldname/board/mine/tasks/qn-9', {
        scope: 'mine',
        view: 'kanban',
        openIssue: 'QN-9',
      }),
    ).toBe(true)
  })

  it('a stale slug normalizes in place even when the rest of the route differs', () => {
    /* Not the org-moved rule above — this one falls all the way through to the
       parse, where an unresolvable slug resolves NO scope, and
       `(r.scope || s.scope) === s.scope` reads that as "not yet canonical"
       rather than "somewhere else". That is the safe direction and it is
       deliberate: we cannot tell a moved address from a stranger's, so the
       choice is between a junk history entry and an address that self-heals,
       and replaceState is the one that cannot strand a Back button. */
    expect(pathMatchesState('/app/oldname/board/p/1', { scope: 'p-home-7', view: 'kanban' })).toBe(
      true,
    )
  })

  it('a different route under a slug that DOES resolve is a real navigation', () => {
    expect(pathMatchesState('/app/home/board/p/1', { scope: 'p-home-7', view: 'kanban' })).toBe(
      false,
    )
    expect(pathMatchesState('/app/acme/board/p/1', { scope: 'p-home-7', view: 'kanban' })).toBe(
      false,
    )
  })

  it('reads a reference as the task its address names, and the handle it moves to as the same', () => {
    // a task the store does not hold (App pendingTask)
    const ref = taskRef({ org: HOME, num: 404 })
    // a viewless short link moved into a sentinel scope still normalizes in place
    expect(
      pathMatchesState('/app/home/tasks/qn-404', { scope: 'mine', view: 'kanban', openIssue: ref }),
    ).toBe(true)
    // so does a new step of Team sync under it
    const sync = { scope: 'all', step: 'agents' }
    expect(pathMatchesState('/app/home/sync/all/tasks/qn-404', { sync, openIssue: ref })).toBe(true)
    // a project's task address moved into All projects earns an entry
    expect(
      pathMatchesState('/app/home/board/tasks/qn-404', {
        scope: 'mine',
        view: 'kanban',
        openIssue: ref,
      }),
    ).toBe(false)
    // another task's address does not name it, nor another organization's
    expect(pathMatchesState('/app/home/sync/all/tasks/qn-405', { sync, openIssue: ref })).toBe(
      false,
    )
    expect(pathMatchesState('/app/acme/tasks/qn-404', { view: 'kanban', openIssue: ref })).toBe(
      false,
    )
    // once the workspace holds the task, its handle names the same address
    const home404 = { ...store.issueById['QN-5'], id: 'QN-404', key: 'QN-404', uuid: 'uuid-404' }
    store.issues = [...store.issues, home404]
    store.issueById['QN-404'] = home404
    expect(
      pathMatchesState('/app/home/tasks/qn-404', { view: 'kanban', openIssue: 'QN-404' }),
    ).toBe(true)
    expect(buildPath({ view: 'kanban', openIssue: ref })).toBe('/app/home/board/tasks/qn-404')
  })

  it('the ~ sentinel is not a real slug and cannot be taken', () => {
    // organizations_slug_check admits only [a-z0-9-], so this is structural
    expect(ORG_NONE).toBe('~')
    expect(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(ORG_NONE)).toBe(false)
  })
})

describe('Team sync addresses', () => {
  const TEAM = '6f1c2a4e-0000-4000-8000-000000000001'
  const PERSON = '6f1c2a4e-0000-4000-8000-000000000002'

  it('the bare page is a route of its own, never the empty "overview" route', () => {
    // {} would boot the Overview and persist it; null would ignore the link
    expect(parsePath('/app/home/sync')).toEqual({ sync: {} })
    expect(parsePath('/app/~/sync')).toEqual({ sync: {} })
    expect(parsePath('/app/~/sync')).not.toEqual({})
  })

  it('reads each scope, then the step', () => {
    expect(parsePath('/app/home/sync/all')).toEqual({ sync: { scope: 'all' } })
    expect(parsePath('/app/home/sync/p/7')).toEqual({ sync: { scope: 'project:p-home-7' } })
    expect(parsePath(`/app/home/sync/team/${TEAM.toUpperCase()}/agents`)).toEqual({
      sync: { scope: `team:${TEAM}`, step: 'agents' },
    })
    expect(parsePath(`/app/home/sync/all/people/${PERSON}`)).toEqual({
      sync: { scope: 'all', step: PERSON },
    })
    expect(parsePath(`/app/home/sync/p/p-home-1a/people/${PERSON}`)).toEqual({
      sync: { scope: 'project:p-home-1a', step: PERSON },
    })
  })

  it('pins a project number to the org segment, and an unreadable slug resolves nothing', () => {
    expect(parsePath('/app/acme/sync/p/1')).toEqual({ sync: { scope: 'project:p-acme-1' } })
    expect(parsePath('/app/globex/sync/p/1')).toEqual({ sync: {} })
    expect(parsePath(`/app/globex/sync/team/${TEAM}/people/${PERSON}/tasks/qn-5`)).toEqual({
      sync: {},
    })
    // an unknown project is a scope the page cannot honour, as typed, never
    // the saved one or All projects; the step still reads
    expect(parsePath('/app/home/sync/p/99/agents')).toEqual({
      sync: { scope: 'unresolved:99', step: 'agents' },
    })
    expect(parsePath('/app/home/sync/p/99/agents')?.sync?.scope).not.toBeUndefined()
    // a people segment without a person is no step
    expect(parsePath('/app/home/sync/all/people')).toEqual({ sync: { scope: 'all' } })
  })

  it('reads a task window over the page', () => {
    expect(parsePath(`/app/home/sync/all/people/${PERSON}/tasks/qn-9`)).toEqual({
      sync: { scope: 'all', step: PERSON },
      issue: 'QN-9',
    })
    expect(parsePath('/app/home/sync/all/tasks/uuid-acme-5')).toEqual({
      sync: { scope: 'all' },
      issue: 'uuid-acme-5',
    })
  })

  it('names the home organization, the scope and the step', () => {
    expect(buildPath({ sync: { scope: 'all', step: 'team' } })).toBe('/app/home/sync/all')
    expect(buildPath({ sync: { scope: 'project:p-home-7', step: 'agents' } })).toBe(
      '/app/home/sync/p/7/agents',
    )
    expect(buildPath({ sync: { scope: `team:${TEAM}`, step: PERSON } })).toBe(
      `/app/home/sync/team/${TEAM}/people/${PERSON}`,
    )
    // no number to name: the uuid, which parses back the same
    expect(buildPath({ sync: { scope: 'project:p-home-1a', step: 'team' } })).toBe(
      '/app/home/sync/p/p-home-1a',
    )
  })

  it('writes the bare page for no scope and keeps an unresolved project as it was typed', () => {
    // the rule before the agenda wrote /sync/all for any scope that was
    // neither a project nor a team, which must fail now
    expect(buildPath({ sync: { scope: '', step: 'team' } })).toBe('/app/home/sync')
    expect(buildPath({ sync: { scope: '', step: 'team' } })).not.toBe('/app/home/sync/all')
    expect(buildPath({ sync: { scope: '', step: PERSON } })).toBe(`/app/home/sync/people/${PERSON}`)
    expect(buildPath({ sync: { scope: 'unresolved:99', step: 'agents' } })).toBe(
      '/app/home/sync/p/99/agents',
    )
  })

  it('names a task over the page by key at home and by uuid from another org', () => {
    expect(buildPath({ sync: { scope: 'all', step: PERSON }, openIssue: 'QN-9' })).toBe(
      `/app/home/sync/all/people/${PERSON}/tasks/qn-9`,
    )
    // "qn-5" under the home slug would open MY QN-5
    expect(buildPath({ sync: { scope: 'all', step: 'team' }, openIssue: 'uuid-acme-5' })).toBe(
      '/app/home/sync/all/tasks/uuid-acme-5',
    )
  })

  it("never names another organization's task by its number under the home slug, also before a read names its uuid", () => {
    const sync = { scope: 'all', step: PERSON }
    // a link to Acme's QN-5 whose read has not named its uuid yet
    const acme5 = taskRef({ org: ACME, num: 5 })
    const path = buildPath({ sync, openIssue: acme5 })
    expect(path).toBe(`/app/home/sync/all/people/${PERSON}`)
    // so a reload or a copy of it opens no task, not the home QN-5
    expect(parsePath(path)?.issue).toBeUndefined()
    // under Acme's own project the slug is Acme's, which reads its number
    expect(buildPath({ sync: { scope: 'project:p-acme-1', step: 'team' }, openIssue: acme5 })).toBe(
      '/app/acme/sync/p/1/tasks/qn-5',
    )
    // a home task opened by its number keeps its key
    expect(buildPath({ sync, openIssue: taskRef({ org: HOME, num: 40 }) })).toBe(
      `/app/home/sync/all/people/${PERSON}/tasks/qn-40`,
    )
    // once the read names the uuid, the address names the task by it
    store.reference = {
      ref: acme5,
      state: 'resolved',
      task: { uuid: FAR, org: ACME, num: 5, project: 'p-acme-1' },
    }
    const named = buildPath({ sync, openIssue: acme5 })
    expect(named).toBe(`/app/home/sync/all/people/${PERSON}/tasks/${FAR}`)
    expect(sameTask(parsePath(named)?.issue, acme5)).toBe(true)
  })

  it('names a task of another organization that left while its organization stays by its uuid, never its number under the home slug', () => {
    const sync = { scope: 'all', step: 'team' }
    const open = 'uuid-acme-5'
    expect(buildPath({ sync, openIssue: open })).toBe('/app/home/sync/all/tasks/uuid-acme-5')
    // someone archives it, or it moves where this person cannot open it,
    // while the person keeps their seat in Acme
    store.issues = store.issues.filter((i) => i.id !== open)
    delete store.issueById[open]
    const path = buildPath({ sync, openIssue: open })
    expect(path).toBe('/app/home/sync/all/tasks/uuid-acme-5')
    expect(parsePath(path)?.issue).not.toBe('QN-5')
    // the other forms name it under Acme's slug, which reads Acme's number
    expect(buildPath({ view: 'kanban', openIssue: open })).toBe('/app/acme/board/tasks/qn-5')
  })

  it('round-trips every emitted form', () => {
    for (const s of [
      { sync: { scope: 'all', step: 'team' } },
      { sync: { scope: 'all', step: 'agents' } },
      { sync: { scope: 'project:p-home-7', step: PERSON } },
      { sync: { scope: 'project:p-home-1a', step: 'team' } },
      { sync: { scope: 'project:p-acme-1', step: 'team' } },
      { sync: { scope: `team:${TEAM}`, step: PERSON }, openIssue: 'QN-9' },
      { sync: { scope: 'all', step: 'team' }, openIssue: 'uuid-acme-5' },
      { sync: { scope: 'unresolved:99', step: 'team' } },
      // a typed segment holding what an address reads as its own parts
      { sync: { scope: 'unresolved:a/b', step: 'team' } },
      { sync: { scope: 'unresolved:a?b#c', step: PERSON } },
    ] as UiState[]) {
      const r = parsePath(buildPath(s))!
      expect(r.sync?.scope).toBe(s.sync!.scope)
      expect(r.sync?.step || 'team').toBe(s.sync!.step)
      expect(r.issue || null).toBe(s.openIssue || null)
    }
  })

  it('full-screen pages still outrank it, and it outranks the scope below', () => {
    const sync = { scope: 'all', step: 'team' }
    expect(buildPath({ sync, settingsPage: 'account' })).toBe('/app/~/settings/account')
    expect(buildPath({ scope: 'p-home-7', view: 'roadmap', sync })).toBe('/app/home/sync/all')
  })

  it('a new step or scope rewrites the address in place', () => {
    const at = (step: string, scope = 'all') => ({
      scope: 'p-home-7',
      view: 'kanban',
      sync: { scope, step },
    })
    expect(pathMatchesState('/app/home/sync/all', at(PERSON))).toBe(true)
    expect(pathMatchesState(`/app/home/sync/all/people/${PERSON}`, at('agents'))).toBe(true)
    expect(pathMatchesState('/app/home/sync/all', at('team', 'project:p-home-7'))).toBe(true)
    // the bare page normalizes to its explicit form without an entry
    expect(pathMatchesState('/app/home/sync', at('team'))).toBe(true)
  })

  it('entering, leaving and opening a task over it are navigations', () => {
    const sync = { scope: 'all', step: 'team' }
    expect(pathMatchesState('/app/home/sync/all', { scope: 'all', view: 'kanban' })).toBe(false)
    expect(pathMatchesState('/app/~/board/mine', { scope: 'all', view: 'kanban', sync })).toBe(
      false,
    )
    expect(pathMatchesState('/app/~/inbox', { sync })).toBe(false)
    expect(pathMatchesState('/app/home/sync/all', { inboxOpen: true })).toBe(false)
    expect(pathMatchesState('/app/home/sync/all', { settingsPage: 'account', sync })).toBe(false)
    expect(pathMatchesState('/app/home/sync/all', { sync, openIssue: 'QN-9' })).toBe(false)
    expect(pathMatchesState('/app/home/sync/all/tasks/qn-9', { sync })).toBe(false)
  })

  it('rewrites a sync address in place for a login with no home organization', () => {
    const view = { scope: 'p-home-7', view: 'overview' }
    // with a home organization, leaving the page is a navigation
    expect(pathMatchesState('/app/home/sync', view)).toBe(false)
    // without one there is no page to leave: no entry that Back would land on
    store.homeOrg = ''
    expect(pathMatchesState('/app/home/sync', view)).toBe(true)
    expect(pathMatchesState(`/app/home/sync/all/people/${PERSON}`, view)).toBe(true)
  })

  it("opens the phone on the viewer's own page only from the bare page link", () => {
    const phone = { saved: 'project:p-home-7', me: PERSON, mobile: true }
    const desk = { ...phone, mobile: false }
    const place = (path: string, viewer: Parameters<typeof syncPlaceOf>[1]) =>
      syncPlaceOf(parsePath(path)!.sync!, viewer)
    // the bare link: the saved scope, and the phone's own page
    expect(place('/app/home/sync', phone)).toEqual({ scope: 'project:p-home-7', step: PERSON })
    expect(place('/app/home/sync', desk)).toEqual({ scope: 'project:p-home-7', step: 'team' })
    // every address the app writes names a scope: Back, a reload or a task
    // closing over the opening lands on the opening, phone or not
    expect(place('/app/home/sync/all', phone)).toEqual({ scope: 'all', step: 'team' })
    expect(place('/app/home/sync/all/tasks/qn-9', phone)).toEqual({ scope: 'all', step: 'team' })
    expect(place(`/app/home/sync/team/${TEAM}`, phone)).toEqual({
      scope: `team:${TEAM}`,
      step: 'team',
    })
    // a named step wins everywhere; nothing saved means no scope, where the
    // page asks to choose, never All projects
    expect(place('/app/home/sync/p/7/agents', phone)).toEqual({
      scope: 'project:p-home-7',
      step: 'agents',
    })
    expect(place('/app/home/sync', { me: PERSON, mobile: false })).toEqual({
      scope: '',
      step: 'team',
    })
    expect(place('/app/home/sync', { me: PERSON, mobile: false }).scope).not.toBe('all')
    // the phone keeps its own page behind the picker, so a pick lands there
    expect(place('/app/home/sync', { me: PERSON, mobile: true })).toEqual({
      scope: '',
      step: PERSON,
    })
    // an address's project the app cannot resolve stays so, also with a
    // saved scope
    expect(place('/app/home/sync/p/99', phone)).toEqual({ scope: 'unresolved:99', step: 'team' })
  })
})

describe('phone page navigation', () => {
  it('restores the project directory independently of the saved project/view', () => {
    const state: UiState = { scope: 'p-home-1', view: 'roadmap', projectsOpen: true }
    expect(buildPath(state)).toBe('/app/~/projects')
    expect(parsePath('/app/~/projects')).toEqual({ projects: true })
    expect(pathMatchesState('/app/home/roadmap/p/1', state)).toBe(false)
    expect(pathMatchesState('/app/~/projects', { scope: 'p-home-1', view: 'roadmap' })).toBe(false)
    expect(pathMatchesState('/app/~/projects', { scope: 'mine', projectsOpen: true })).toBe(true)
  })

  it('treats the settings menu as personal navigation and gives layers distinct history', () => {
    expect(buildPath({ settingsPage: 'menu' })).toBe('/app/~/settings/menu')
    expect(parsePath('/app/~/settings/menu')).toEqual({ settings: 'menu' })
    expect(buildPath({ settingsPage: 'account-appearance' })).toBe(
      '/app/~/settings/account-appearance',
    )
    expect(parsePath('/app/~/settings/account-appearance')).toEqual({
      settings: 'account-appearance',
    })
    expect(buildPath({ projectsOpen: true, settingsPage: 'project:p-acme-1' })).toBe(
      '/app/acme/settings/project/1',
    )
    expect(pathMatchesState('/app/~/projects', { settingsPage: 'menu' })).toBe(false)
    expect(pathMatchesState('/app/~/settings/menu', { settingsPage: 'account' })).toBe(false)
    expect(pathMatchesState('/app/~/inbox', { projectsOpen: true })).toBe(false)
  })
})

describe('addressedTask, the task a boot reads with the first parts', () => {
  it('names the slug and the ref taskWindow.task reads, from a path or a legacy hash', () => {
    const qn7 = { slug: 'northstar', ref: 'QN-7' }
    expect(addressedTask('/app/northstar/board/tasks/QN-7', '')).toEqual(qn7)
    expect(addressedTask('/app/northstar/inbox/tasks/7', '')).toEqual(qn7)
    expect(addressedTask('/app/northstar/sync/all/tasks/qn-7', '')).toEqual(qn7)
    expect(addressedTask('/app/northstar', '#/o/northstar/board/tasks/QN-7')).toEqual(qn7)
    expect(addressedTask(`/app/northstar/tasks/${FAR.toUpperCase()}`, '')).toEqual({
      slug: 'northstar',
      ref: FAR,
    })
  })

  it("takes a legacy hash's organization, never the home organization's reading", () => {
    // #/o/<guest>/ pins the guest organization, as parseHash reads it
    expect(addressedTask('/app', '#/o/partner/tasks/QN-7')).toEqual({
      slug: 'partner',
      ref: 'QN-7',
    })
    // a hash without one names the home organization, which the boot
    // knows only once its people arrive: no boot read
    expect(addressedTask('/app', '#/tasks/QN-7')).toBeUndefined()
    expect(addressedTask('/app/~/inbox/tasks/QN-7', '')).toBeUndefined()
  })

  it('reads encoded segments as the parsers decode them', () => {
    expect(addressedTask('/app/northstar/board/%74asks/qn-5', '')?.ref).toBe('QN-5')
    expect(taskSegmentOf('/app/northstar/board/%74asks/qn%2D5', '')).toBe('qn-5')
    expect(taskSegmentOf('/app', '#/inbox/tasks/QN-7')).toBe('QN-7')
  })

  it('names none for a scope, a page, a path outside the app, or a ref no task can have', () => {
    expect(addressedTask('/app/northstar/board/p/3', '')).toBeUndefined()
    expect(addressedTask('/app/northstar/settings/project/3', '')).toBeUndefined()
    expect(addressedTask('/app', '')).toBeUndefined()
    expect(addressedTask('/docs/tasks/intro', '')).toBeUndefined()
    expect(addressedTask('/app', '#tasks')).toBeUndefined()
    expect(addressedTask('/app/northstar/tasks/qn-0', '')).toBeUndefined()
    expect(addressedTask('/app/northstar/tasks/not-a-task', '')).toBeUndefined()
    // an organization's slug is not a page
    expect(addressedTask('/app/tasks/board/p/3', '')).toBeUndefined()
    // a path that names a page leaves the hash unread, as parsePath does
    expect(addressedTask('/app/northstar/board/p/3', '#/o/northstar/tasks/QN-7')).toBeUndefined()
  })
})
