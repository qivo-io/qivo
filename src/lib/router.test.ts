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

const store = {} as {
  projects: FakeProject[]
  issues: FakeIssue[]
  homeOrg: string
  orgs: FakeOrg[]
  issueById: Record<string, FakeIssue>
  orgBySlug: (s: string) => FakeOrg | undefined
  project: (id: string) => FakeProject | undefined
  issueRefIn: (org: string, key: string) => string | null
  isMine: (it: FakeIssue) => boolean
}

vi.mock('../store/planner', () => ({
  ISSUE_PREFIX: 'QN',
  ALL_SCOPE: 'all',
  MINE_SCOPE: 'mine',
  P: new Proxy({}, { get: (_t, k) => store[k as keyof typeof store] }),
}))

import {
  buildPath,
  issueLink,
  ORG_NONE,
  parseHash,
  parsePath,
  pathMatchesState,
  scopeForIssue,
  syncPlaceOf,
  type UiState,
} from './router'

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
  store.issueRefIn = (org: string, key: string) => {
    const it = issues.find((i) => i.org === org && i.key === key)
    return it ? it.id : null
  }
  store.isMine = (it: FakeIssue) => !!it && it.assignee === 'me'
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
      '/app/home/board/all/i/qn-9',
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
    expect(parsePath('/app/globex/board/p/1')).toEqual({ view: 'kanban' })
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
  it('reads the sentinel scopes with and without a view', () => {
    expect(parsePath('/app/~/all')).toEqual({ scope: 'all' })
    expect(parsePath('/app/~/board/all')).toEqual({ view: 'kanban', scope: 'all' })
    expect(parsePath('/app/~/mine')).toEqual({ scope: 'mine' })
    expect(parsePath('/app/~/roadmap/mine')).toEqual({ view: 'roadmap', scope: 'mine' })
  })

  it('reads a task window open over a sentinel — the org pins only the task', () => {
    expect(parsePath('/app/home/board/all/tasks/qn-9')).toEqual({
      view: 'kanban',
      scope: 'all',
      issue: 'QN-9',
    })
    expect(parsePath('/app/acme/board/mine/tasks/qn-5')).toEqual({
      view: 'kanban',
      scope: 'mine',
      issue: 'uuid-acme-5',
    })
  })

  it('a sentinel never collides with a project reference', () => {
    expect(parsePath('/app/home/board/p/all')).toEqual({ view: 'kanban' })
    expect(parsePath('/app/home/board/p/mine')).toEqual({ view: 'kanban' })
  })

  it('reads the full-screen pages', () => {
    expect(parsePath('/app/~/archive')).toEqual({ archive: true })
    expect(parsePath('/app/~/inbox')).toEqual({ inbox: true })
    expect(parsePath('/app/home/inbox/tasks/qn-9')).toEqual({ inbox: true, issue: 'QN-9' })
    expect(parsePath('/app/~/settings/account')).toEqual({ settings: 'account' })
    expect(parsePath('/app/home/settings/org-general')).toEqual({ settings: 'org-general' })
    expect(parsePath('/app/home/settings/project/7')).toEqual({ settings: 'project:p-home-7' })
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
    // both sentinels span every org; the inbox and archive do too; an account
    // page is about a person
    expect(buildPath({ scope: 'all', view: 'kanban' })).toBe('/app/~/board/all')
    expect(buildPath({ scope: 'mine', view: 'overview' })).toBe('/app/~/overview/mine')
    expect(buildPath({ inboxOpen: true })).toBe('/app/~/inbox')
    expect(buildPath({ archiveOpen: true })).toBe('/app/~/archive')
    expect(buildPath({ settingsPage: 'account' })).toBe('/app/~/settings/account')
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
    expect(buildPath({ scope: 'all', view: 'kanban', openIssue: 'QN-9' })).toBe(
      '/app/home/board/all/tasks/qn-9',
    )
    expect(buildPath({ scope: 'all', view: 'kanban', openIssue: 'uuid-acme-5' })).toBe(
      '/app/acme/board/all/tasks/qn-5',
    )
    expect(buildPath({ scope: 'mine', view: 'kanban', openIssue: 'uuid-acme-5' })).toBe(
      '/app/acme/board/mine/tasks/qn-5',
    )
  })

  it('full-screen pages still outrank the scope', () => {
    expect(buildPath({ scope: 'all', view: 'kanban', inboxOpen: true })).toBe('/app/~/inbox')
    expect(buildPath({ scope: 'all', view: 'kanban', archiveOpen: true })).toBe('/app/~/archive')
    expect(buildPath({ scope: 'all', view: 'kanban', settingsPage: 'account' })).toBe(
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
      { scope: 'all', view: 'overview' },
      { scope: 'all', view: 'kanban' },
      { scope: 'all', view: 'roadmap' },
      { scope: 'all', view: 'kanban', openIssue: 'QN-9' },
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
    expect(parseHash('#/board/all')).toEqual({ view: 'kanban', scope: 'all' })
    expect(parseHash('#/board/mine/tasks/qn-9')).toEqual({
      view: 'kanban',
      scope: 'mine',
      issue: 'QN-9',
    })
    expect(parseHash('#/settings/org-general')).toEqual({ settings: 'org-general' })
    expect(parseHash('#/inbox')).toEqual({ inbox: true })
    expect(parseHash('#/archive')).toEqual({ archive: true })
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
    expect(parseHash('#/o/globex/board/p/1')).toEqual({ view: 'kanban' })
  })
})

describe('scopeForIssue', () => {
  it('keeps the preferred project when the issue lives inside it', () => {
    expect(scopeForIssue('QN-5', 'p-home-1')).toBe('p-home-1') // via the parent's children
    expect(scopeForIssue('QN-5', 'p-home-1a')).toBe('p-home-1a')
  })

  it("falls back to the issue's own sub-project otherwise", () => {
    expect(scopeForIssue('QN-5', 'p-home-7')).toBe('p-home-1a')
    expect(scopeForIssue('QN-5', null)).toBe('p-home-1a')
  })

  it('All projects already holds every issue, so it is never narrowed away', () => {
    expect(scopeForIssue('QN-5', 'all')).toBe('all')
    expect(scopeForIssue('uuid-acme-5', 'all')).toBe('all')
  })

  it("My view holds only MY tasks, so a short link to someone else's narrows", () => {
    expect(scopeForIssue('QN-5', 'mine')).toBe('mine')
    // a seat in another organization is still me (0081)
    expect(scopeForIssue('uuid-acme-5', 'mine')).toBe('mine')
    // …but this one is somebody else's: land on a board that actually shows it
    expect(scopeForIssue('QN-9', 'mine')).toBe('p-home-7')
  })
})

describe('pathMatchesState — replace in place vs. a new history entry', () => {
  it('the front door and a foreign path are overwritten in place', () => {
    expect(pathMatchesState('/app/home', { scope: 'all', view: 'kanban' })).toBe(true)
    expect(pathMatchesState('/', { scope: 'all', view: 'kanban' })).toBe(true)
  })

  it('the canonical path for a state matches it', () => {
    expect(pathMatchesState('/app/~/board/all', { scope: 'all', view: 'kanban' })).toBe(true)
    expect(
      pathMatchesState('/app/home/board/all/tasks/qn-9', {
        scope: 'all',
        view: 'kanban',
        openIssue: 'QN-9',
      }),
    ).toBe(true)
    expect(pathMatchesState('/app/home/board/p/7', { scope: 'p-home-7', view: 'kanban' })).toBe(
      true,
    )
  })

  it('changing scope is a navigation, not a normalization', () => {
    expect(pathMatchesState('/app/home/board/p/7', { scope: 'all', view: 'kanban' })).toBe(false)
    expect(pathMatchesState('/app/~/board/all', { scope: 'p-home-7', view: 'kanban' })).toBe(false)
  })

  it('entering or leaving a sentinel scope with a task open earns an entry', () => {
    // <view>/tasks/<issue> IS the project-scope form — it omits the scope segment
    // because the issue names its own project
    expect(
      pathMatchesState('/app/home/board/tasks/qn-9', {
        scope: 'all',
        view: 'kanban',
        openIssue: 'QN-9',
      }),
    ).toBe(false)
    expect(
      pathMatchesState('/app/home/board/all/tasks/qn-9', {
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

  it('moving BETWEEN the two sentinels earns one too — they are different panes', () => {
    // the rule compares sentinel identity, not "is it a sentinel": a boolean
    // XOR would call these the same page and Back would skip straight past it
    expect(
      pathMatchesState('/app/home/board/mine/tasks/qn-9', {
        scope: 'all',
        view: 'kanban',
        openIssue: 'QN-9',
      }),
    ).toBe(false)
    expect(
      pathMatchesState('/app/home/board/all/tasks/qn-9', {
        scope: 'mine',
        view: 'kanban',
        openIssue: 'QN-9',
      }),
    ).toBe(false)
    expect(pathMatchesState('/app/~/board/mine', { scope: 'all', view: 'kanban' })).toBe(false)
    expect(pathMatchesState('/app/~/board/all', { scope: 'mine', view: 'kanban' })).toBe(false)
  })

  it('a viewless short link still normalizes in place — including into a sentinel scope', () => {
    // the boot path for /app/home/tasks/qn-9 with a saved sentinel scope: the path
    // names neither view nor scope, which is "not yet canonical", not
    // "somewhere else" — pushing here would leave a junk entry on every boot
    expect(
      pathMatchesState('/app/home/tasks/qn-9', { scope: 'all', view: 'kanban', openIssue: 'QN-9' }),
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
      pathMatchesState('/app/oldname/board/all/tasks/qn-9', {
        scope: 'all',
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
    // an unknown project leaves the scope to the saved one, the step still reads
    expect(parsePath('/app/home/sync/p/99/agents')).toEqual({ sync: { step: 'agents' } })
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

  it('names a task over the page by key at home and by uuid from another org', () => {
    expect(buildPath({ sync: { scope: 'all', step: PERSON }, openIssue: 'QN-9' })).toBe(
      `/app/home/sync/all/people/${PERSON}/tasks/qn-9`,
    )
    // "qn-5" under the home slug would open MY QN-5
    expect(buildPath({ sync: { scope: 'all', step: 'team' }, openIssue: 'uuid-acme-5' })).toBe(
      '/app/home/sync/all/tasks/uuid-acme-5',
    )
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
    expect(buildPath({ sync, archiveOpen: true })).toBe('/app/~/archive')
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
    expect(pathMatchesState('/app/~/board/all', { scope: 'all', view: 'kanban', sync })).toBe(false)
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
    // a named step wins everywhere; nothing saved means all projects
    expect(place('/app/home/sync/p/7/agents', phone)).toEqual({
      scope: 'project:p-home-7',
      step: 'agents',
    })
    expect(place('/app/home/sync', { me: PERSON, mobile: false })).toEqual({
      scope: 'all',
      step: 'team',
    })
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
