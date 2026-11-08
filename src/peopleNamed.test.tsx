// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiAccessPageAnswer } from './lib/apiAccess'
import { TODAY_WEEK, weekToISO } from './lib/dates'
import { isPeopleSettingsRead, peopleSettingsServer } from './store/peopleSettingsStandIn.setup'
import type { Snapshot } from './store/plannerFixture.setup'
import { isProjectSettingsRead, projectSettingsServer } from './store/projectSettingsStandIn.setup'
import { isTeamSettingsRead, teamSettingsServer } from './store/teamSettingsStandIn.setup'
import { BOARD_TEST_TIMEOUT, loadBoard, spread, taskRow } from './views/boardFixture.setup'

/* The people every page shows, as the profile cache names and paints them
   (store/profileCache.ts, store/planner.ts P.person): a person the
   workspace's people part does not hold shows as loading, then by name once
   people.byIds answers, never as Unassigned, "Unknown user" or "Unavailable
   user" until the answer leaves them out; and the audit, one case a page:
   every portrait a page renders ([data-avatar]) is of a person an open view
   names (usePeople), so a host that forgets to name its people fails here.
   The caller's own seats are the workspace's always, and the store asks for
   their pictures whatever the views name (store/planner.ts wantPictures),
   so the audit leaves them out; the view filter's Assignee menu, which
   names no one, is not open in any case. The Settings pages read their
   answers from their stand-ins over the same snapshot (settingsReads). */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('./lib/convex', async () => ({
  convex: network,
  live: (await import('./store/guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('./lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return []
      }
    },
  )
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.scrollTo = () => {}
  localStorage.clear()
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

type Board = Awaited<ReturnType<typeof loadBoard>>

/** Gina and Hal, people of the organization the workspace's people part
    does not hold, who own work the views show. */
const GINA = 'gina'
const HAL = 'hal'
const unheld = (snap: Snapshot) => {
  for (const [id, name, initials] of [
    [GINA, 'Gina Ghost', 'GG'],
    [HAL, 'Hal Hidden', 'HH'],
  ] as const)
    snap.profiles.push({
      ...snap.profiles[0],
      id,
      auth_user_id: `account-${id}`,
      name,
      initials,
      org_role: 'user',
      kind: 'person',
      plannable_hours: 30,
    })
}

/** Loads the Board's store with `prepare`, Gina and Hal left out of the
    people part and their faces held back, and records what the views
    name. */
async function load(prepare: (snap: Snapshot) => void, options: Parameters<typeof loadBoard>[2]) {
  const board = await loadBoard(
    network,
    (snap) => {
      unheld(snap)
      prepare(snap)
    },
    options,
  )
  board.server.people.unheld = new Set([GINA, HAL])
  board.server.people.hold = true
  await board.deliver()
  const names = watchNames(board)
  return { board, names }
}

/** What the open views name now, followed through P.namePeople. */
function watchNames(board: Board) {
  const owners = new Map<string, Set<string>>()
  const real = board.P.namePeople
  vi.spyOn(board.P, 'namePeople').mockImplementation((owner, people) => {
    if (people.length === 0) owners.delete(owner)
    else owners.set(owner, new Set(people.map((p) => p.id)))
    return real(owner, people)
  })
  return {
    /** every person an open view names now */
    named: () => new Set([...owners.values()].flatMap((ids) => [...ids])),
    /** the portraits on the page whose person no open view names, the
        caller's own seats left out */
    unnamed: () => {
      const named = new Set([...owners.values()].flatMap((ids) => [...ids]))
      const own = new Set(board.P.myProfileIds)
      return [...document.querySelectorAll<HTMLElement>('[data-avatar]')]
        .map((el) => el.dataset.avatar ?? '')
        .filter((id) => id && !named.has(id) && !own.has(id))
    },
  }
}

/** Answers the Settings pages' reads from their stand-ins over the board's
    snapshot, the server's, which holds Gina and Hal, beside the reads
    loadBoard answers, people.byIds among them; and API access's reads with
    one token of Gina's. */
function settingsReads(board: Board) {
  const people = peopleSettingsServer(() => board.snapshot)
  const teams = teamSettingsServer(() => board.snapshot)
  const projects = projectSettingsServer(() => board.snapshot)
  const query = network.query.getMockImplementation()
  const watch = network.onUpdate.getMockImplementation()
  const org = board.snapshot.orgs[0].id
  const period = '2026-09-01T00:00:00.000Z'
  const apiAccess: Record<string, () => unknown> = {
    'apiAccess:summary': () => ({
      state: 'ready',
      periods: [{ key: period, kind: 'paid', start: period, end: period, current: true }],
      period,
      summary: { calls: 3, included_calls: null, plan: null, waived: false },
    }),
    'apiAccess:page': (): ApiAccessPageAnswer => ({
      state: 'ready',
      period,
      person: null,
      rows: [
        {
          table: 'mcp_tokens',
          id: 'gina-token',
          name: 'Gina’s token',
          prefix: 'qvt_gina',
          profile_id: GINA,
          person: 'Gina Ghost',
          agent: false,
          removed: false,
          access: 'write',
          expires_at: null,
          last_used_at: null,
          revoked_at: null,
          revoked_by_admin: false,
          state: 'active',
          calls: 3,
        },
      ],
      next: null,
      stopped: false,
    }),
    'apiAccess:people': () => ({ state: 'ready', rows: [], next: null, stopped: false }),
  }
  network.query.mockImplementation(async (ref, args) => {
    const name = getFunctionName(ref)
    if (name in apiAccess) return apiAccess[name]?.()
    if (name !== 'people:byIds' && isPeopleSettingsRead(name)) return people.query(name, args)
    if (isTeamSettingsRead(name)) return teams.query(name, args)
    if (isProjectSettingsRead(name)) return projects.query(name, args)
    return query?.(ref, args)
  })
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name !== 'people:byIds' && isPeopleSettingsRead(name))
      return people.watch(name, args, next, fail)
    if (isTeamSettingsRead(name)) return teams.watch(name, args, next, fail)
    if (isProjectSettingsRead(name)) return projects.watch(name, args, next, fail)
    return watch?.(ref, args, next, fail)
  })
  return { org }
}

/** Lets the store's frame-batched repaint and React run. */
const repaint = async () => {
  for (let i = 0; i < 3; i++) await act(async () => await new Promise((r) => setTimeout(r, 30)))
}

/** The portraits of person `id`, by their state. */
const portraits = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(`[data-avatar="${id}"]`)].map(
    (el) => el.dataset.avatarState ?? 'ok',
  )

const WORDS_BEFORE_ANSWER = ['Unknown user', 'Unavailable user', 'Unknown person']

describe('people the workspace does not hold, on each page', () => {
  it(
    'names the Board’s lanes and cards loading and then by name, never unknown before the answer, and names every portrait',
    async () => {
      const { board, names } = await load(
        (snap) => {
          snap.issues.push({ ...taskRow(snap, 'g1', 'todo', 1), assignee_id: GINA })
          snap.issues.push({ ...taskRow(snap, 'h1', 'progress', 2), assignee_id: HAL })
          snap.issues.push({ ...taskRow(snap, 'm1', 'todo', 3) })
        },
        { metaViz: 'assignees' },
      )
      await board.render(root)
      await repaint()
      // loading: plain squares and a "Loading…" lane, never Unassigned
      expect(portraits(GINA).length).toBeGreaterThan(0)
      expect(portraits(GINA).every((s) => s === 'loading')).toBe(true)
      const lanes = () =>
        [...document.querySelectorAll<HTMLElement>('[data-lane^="assignee:"]')].map((lane) =>
          lane.textContent?.trim(),
        )
      expect(lanes().some((text) => text?.startsWith('Loading…'))).toBe(true)
      for (const words of WORDS_BEFORE_ANSWER)
        expect(document.body.textContent).not.toContain(words)
      expect(document.querySelector(`[data-lane="assignee:unassigned"]`)).toBeNull()
      expect(names.unnamed()).toEqual([])
      // a text filter cannot tell whether a word is in a name not loaded
      // yet, so it keeps the task
      const task = () => {
        const it = board.P.viewTask('board:desktop', 'g1')
        if (!it) throw new Error('the Board holds no g1')
        return it
      }
      expect(board.P.matchesSearch(task(), 'zzz')).toBe(true)
      // the answer names them
      board.server.people.hold = false
      await board.answer()
      await repaint()
      expect(portraits(GINA).every((s) => s === 'ok')).toBe(true)
      expect(document.body.textContent).toContain('Gina Ghost')
      expect(names.unnamed()).toEqual([])
      // once named, the filter decides by the name
      expect(board.P.matchesSearch(task(), 'zzz')).toBe(false)
      expect(board.P.matchesSearch(task(), 'ghost')).toBe(true)
      // only an answer that leaves Hal out makes him unknown
      board.server.people.force = 'gone'
      await board.answer()
      await repaint()
      expect(portraits(HAL).every((s) => s === 'gone')).toBe(true)
      expect(lanes().some((text) => text?.startsWith('Unknown user'))).toBe(true)
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'draws a Board card’s loading portrait again once the answer leaves its person out or fails',
    async () => {
      const { board } = await load(
        (snap) => {
          snap.issues.push({ ...taskRow(snap, 'g1', 'todo', 1), assignee_id: GINA })
        },
        { metaViz: 'assignees' },
      )
      await board.render(root)
      await repaint()
      const card = () =>
        [...document.querySelectorAll<HTMLElement>(`[data-card] [data-avatar="${GINA}"]`)].map(
          (el) => el.dataset.avatarState ?? 'ok',
        )
      expect(card()).toEqual(['loading'])
      // no face arrives, so the people the store paints stay the same, and
      // the card, which skips a render while its context holds, must still
      // draw the server's answer
      board.server.people.force = 'error'
      board.server.people.hold = false
      await board.answer()
      await repaint()
      expect(card()).toEqual(['failed'])
      board.server.people.force = 'gone'
      await board.answer()
      await repaint()
      expect(card()).toEqual(['gone'])
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'names the owner of a parent heading that an Assignee filter leaves on the Board only above its subtask',
    async () => {
      const { board, names } = await load((snap) => {
        snap.issues.push({ ...taskRow(snap, 'par', 'progress', 1), assignee_id: GINA })
        snap.issues.push({
          ...taskRow(snap, 'kid', 'todo', 2),
          parent_id: 'par',
          assignee_id: HAL,
        })
      }, {})
      await board.render(root)
      await board.filter({ assignees: [HAL] })
      await repaint()
      // Hal's card shows under its parent's heading, whose owner is Gina
      const heading = document.querySelector('[aria-label="Parent: Task par"]')
      expect(heading).not.toBeNull()
      expect(board.card('par')).toBeNull()
      expect(portraits(GINA).length).toBeGreaterThan(0)
      expect(names.named().has(GINA)).toBe(true)
      expect(names.unnamed()).toEqual([])
      board.server.people.hold = false
      await board.answer()
      await repaint()
      expect(portraits(GINA).every((s) => s === 'ok')).toBe(true)
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'names the phone Board’s owners and the assignees its text filter matches tasks by',
    async () => {
      const { board, names } = await load(
        (snap) => {
          snap.issues.push({
            ...taskRow(snap, 'r1', 'review', 1),
            assignee_id: GINA,
            reviewer_id: HAL,
          })
        },
        { phone: true },
      )
      await board.render(root)
      await repaint()
      // Hal owns the task while it waits for his review; Gina is its assignee
      expect(names.named().has(HAL)).toBe(true)
      expect(names.named().has(GINA)).toBe(true)
      expect(names.unnamed()).toEqual([])
      // once Gina's name loads, the text filter decides by it
      board.server.people.hold = false
      await board.answer()
      await repaint()
      const task = board.P.viewTask('board:phone', 'r1')
      if (!task) throw new Error('the phone Board holds no r1')
      expect(board.P.matchesSearch(task, 'ghost')).toBe(true)
      expect(board.P.matchesSearch(task, 'zzz')).toBe(false)
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'names the Overview’s lead and its lists’ owners, loading and then by name',
    async () => {
      const { board, names } = await load(
        (snap) => {
          // Gina leads the project, so the signed-in admin works on it
          // through a User grant, as admin status gives no access to
          // project work
          snap.projects[0].lead_id = GINA
          snap.access.push({
            project_id: snap.projects[0].id,
            profile_id: snap.profiles[0].id,
            level: 'user',
          })
          snap.issues.push({
            ...taskRow(snap, 'late', 'progress', 1),
            assignee_id: HAL,
            due_date: '2020-01-01',
          })
        },
        { scope: '' },
      )
      const { Overview } = await import('./views/Overview')
      const actions = new Proxy({}, { get: () => () => {} }) as never
      const scope = board.snapshot.projects[0].id
      await board.renderView(root, (info) => (
        <Overview info={{ ...info, ...(board.P.scopeInfo(scope) ?? info) }} actions={actions} />
      ))
      await repaint()
      const lead = () => document.querySelector('[data-ov-lead]')
      expect(lead()?.textContent).toContain('Loading…')
      expect(names.unnamed()).toEqual([])
      board.server.people.hold = false
      await board.answer()
      await repaint()
      expect(lead()?.textContent).toContain('Gina Ghost')
      expect(names.unnamed()).toEqual([])
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'names no lead for an Overview health row whose project the workspace cannot place',
    async () => {
      const { board, names } = await load(
        (snap) => {
          spread(1)(snap)
          const two = snap.projects.find((p) => p.id === 'two')
          if (two) two.lead_id = GINA
        },
        { scope: 'plan' },
      )
      // a row of a project the workspace does not hold, led by Hal
      board.server.overview.edit = (query, answer) => {
        const ok = answer as { state: string; rows?: { project_id: string; lead_id: string }[] }
        if (query !== 'health' || ok.state !== 'ok' || !ok.rows?.[0]) return answer
        return {
          ...ok,
          rows: [...ok.rows, { ...ok.rows[0], project_id: 'elsewhere', lead_id: HAL }],
        }
      }
      const { Overview } = await import('./views/Overview')
      const actions = new Proxy({}, { get: () => () => {} }) as never
      await board.renderView(root, (info) => <Overview info={info} actions={actions} />)
      await repaint()
      expect(document.querySelector('[data-ovcard="elsewhere"]')).not.toBeNull()
      // the placed row's lead is named in its organization, and Hal not at
      // all, since a read in another organization would answer him gone
      expect(names.named().has(GINA)).toBe(true)
      expect(names.named().has(HAL)).toBe(false)
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'names the task window’s reporter, holders and its relation rows’ owners, loading and then by name',
    async () => {
      const { board, names } = await load(
        (snap) => {
          snap.issues.push({
            ...taskRow(snap, 'parent', 'progress', 1),
            assignee_id: GINA,
            reporter_id: HAL,
          })
          snap.issues.push({
            ...taskRow(snap, 'child', 'todo', 2),
            parent_id: 'parent',
            assignee_id: HAL,
          })
        },
        { tasks: true },
      )
      const { IssueDetail } = await import('./panels/IssueDetail')
      const handle = board.P.handleOf('parent') ?? ''
      await board.renderView(root, () => (
        <IssueDetail issueId={handle} onClose={() => {}} onOpen={() => {}} />
      ))
      await repaint()
      const reporter = () => document.querySelector('[data-task-reporter]')?.textContent ?? ''
      expect(reporter()).toContain('Loading…')
      expect(reporter()).not.toContain('No reporter')
      expect(names.unnamed()).toEqual([])
      board.server.people.hold = false
      await board.answer()
      await repaint()
      expect(reporter()).toContain('Hal Hidden')
      expect(names.unnamed()).toEqual([])
      // the child's window draws its Parent row's owner, Gina, and names her
      const child = board.P.handleOf('child') ?? ''
      await board.renderView(root, () => (
        <IssueDetail issueId={child} onClose={() => {}} onOpen={() => {}} />
      ))
      await repaint()
      expect(portraits(GINA).length).toBeGreaterThan(0)
      expect(names.named().has(GINA)).toBe(true)
      expect(names.unnamed()).toEqual([])
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'names Team sync’s people and its cards’ owners',
    async () => {
      const { board, names } = await load((snap) => {
        snap.issues.push({ ...taskRow(snap, 'g1', 'progress', 1), assignee_id: GINA })
      }, {})
      const { TeamSync } = await import('./views/TeamSync')
      const scope = `project:${board.snapshot.projects[0].parent_id ?? board.snapshot.projects[0].id}`
      await board.renderView(root, () => (
        <TeamSync
          place={{ scope, step: 'team' }}
          onPlace={() => {}}
          onCorrect={() => {}}
          onClose={() => {}}
          onOpenTask={() => {}}
          onShowTask={() => {}}
          onShowPerson={() => {}}
          onShowBoard={() => {}}
        />
      ))
      await repaint()
      // the page shows Gina's portrait in its walk, named while it shows
      expect(portraits(GINA).length).toBeGreaterThan(0)
      expect(names.unnamed()).toEqual([])
      board.server.people.hold = false
      await board.answer()
      await repaint()
      expect(portraits(GINA).every((s) => s === 'ok')).toBe(true)
      expect(names.unnamed()).toEqual([])
    },
    BOARD_TEST_TIMEOUT,
  )

  it.each([
    ['swimlanes', true],
    ['assignees', false],
  ] as const)(
    'names a sub-project’s lead on the %s Board only while its lane headings draw them',
    async (metaViz, drawn) => {
      const { board, names } = await load(
        (snap) => {
          spread(1)(snap)
          const two = snap.projects.find((p) => p.id === 'two')
          if (two) two.lead_id = GINA
        },
        { metaViz, scope: 'plan' },
      )
      await board.render(root)
      await repaint()
      expect(portraits(GINA).length > 0).toBe(drawn)
      expect(names.named().has(GINA)).toBe(drawn)
      expect(names.unnamed()).toEqual([])
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'names the Roadmap’s people and Team utilization’s, loading and then by name',
    async () => {
      const dated = { start_week: weekToISO(TODAY_WEEK), end_week: weekToISO(TODAY_WEEK + 1) }
      const { board, names } = await load((snap) => {
        snap.issues.push({ ...taskRow(snap, 'g1', 'todo', 1), assignee_id: GINA, ...dated })
        snap.issues.push({ ...taskRow(snap, 'h1', 'todo', 2), assignee_id: HAL, ...dated })
      }, {})
      const { Roadmap } = await import('./views/Roadmap')
      await board.renderView(root, (info) => (
        <Roadmap
          info={info}
          filters={{
            mine: false,
            assignees: [],
            priority: null,
            stale: false,
            focus: false,
            search: '',
          }}
          actions={new Proxy({}, { get: () => () => {} }) as never}
          filterControls={() => null}
          focusPlan={null}
        />
      ))
      await repaint()
      // Team utilization lists both, loading, never leaving them out
      const team = () =>
        [...document.querySelectorAll<HTMLElement>('[data-res-row]')].map(
          (row) => row.dataset.resRow,
        )
      expect(team()).toEqual(expect.arrayContaining([GINA, HAL]))
      expect(portraits(GINA).length).toBeGreaterThan(0)
      expect(names.unnamed()).toEqual([])
      board.server.people.hold = false
      await board.answer()
      await repaint()
      expect(portraits(GINA).every((s) => s === 'ok')).toBe(true)
      expect(names.unnamed()).toEqual([])
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'names Settings › Users’ people',
    async () => {
      const { board, names } = await load(() => {}, {})
      settingsReads(board)
      const { OrgUsersPage } = await import('./panels/settings/UsersSettings')
      await board.renderView(root, () => <OrgUsersPage setPage={vi.fn()} />)
      await repaint()
      expect(portraits(GINA).length).toBeGreaterThan(0)
      expect(portraits(HAL).length).toBeGreaterThan(0)
      expect(names.unnamed()).toEqual([])
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'names a team page’s members, and the person Add member shows once its picker closes',
    async () => {
      const { board, names } = await load((snap) => {
        snap.teams.push({
          id: 'crew',
          org_id: snap.orgs[0].id,
          name: 'Crew',
          track_delay_default: false,
          created_at: '2026-09-14T08:00:00.000Z',
        })
        snap.teamMembers.push({ team_id: 'crew', profile_id: GINA, is_leader: true })
      }, {})
      settingsReads(board)
      const { TeamPage } = await import('./panels/settings/TeamSettings')
      await board.renderView(root, () => <TeamPage teamId="crew" setPage={vi.fn()} />)
      await repaint()
      expect(portraits(GINA).length).toBeGreaterThan(0)
      expect(names.unnamed()).toEqual([])
      // Hal, picked in Add member, stays on its button after the picker closes
      const click = async (selector: string) => {
        const el = document.querySelector<HTMLElement>(selector)
        if (!el) throw new Error(`no ${selector}`)
        await act(async () => el.click())
        await repaint()
      }
      await click('[data-team-member-picker]')
      await click(`[data-team-member-choice="${HAL}"]`)
      expect(document.querySelector('[data-team-member-choices]')).toBeNull()
      expect(
        document.querySelector(`[data-team-member-picker] [data-avatar="${HAL}"]`),
      ).not.toBeNull()
      expect(names.unnamed()).toEqual([])
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'names a project’s Settings page’s people',
    async () => {
      const { board, names } = await load((snap) => {
        snap.access.push(
          { project_id: snap.projects[0].id, profile_id: GINA, level: 'user' },
          { project_id: snap.projects[0].id, profile_id: HAL, level: 'viewer' },
        )
      }, {})
      settingsReads(board)
      const { ProjectPage } = await import('./panels/settings/ProjectSettings')
      const project = board.snapshot.projects[0].id
      await board.renderView(root, () => <ProjectPage project={project} setPage={vi.fn()} />)
      await repaint()
      expect(portraits(GINA).length).toBeGreaterThan(0)
      expect(names.unnamed()).toEqual([])
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'names API access’s credentials’ people',
    async () => {
      const { board, names } = await load(() => {}, {})
      settingsReads(board)
      const { OrgApiAccessPage } = await import('./panels/settings/ApiAccessSettings')
      await board.renderView(root, () => <OrgApiAccessPage />)
      await repaint()
      expect(portraits(GINA).length).toBeGreaterThan(0)
      expect(names.unnamed()).toEqual([])
    },
    BOARD_TEST_TIMEOUT,
  )
})
