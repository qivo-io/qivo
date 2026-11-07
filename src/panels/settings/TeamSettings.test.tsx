// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { MEMBER_WORDS } from '../../components/pickerWords'
import { TooltipProvider } from '../../components/ui/tooltip'
import { CONFIRM_IGNORE_MS } from '../../lib/useConfirmArm'
import { plannerFixture, type Snapshot } from '../../store/plannerFixture.setup'
import {
  type ForcedTeamSettings,
  isTeamSettingsRead,
  teamSettingsServer,
} from '../../store/teamSettingsStandIn.setup'

/* Settings › Teams, a team's page and its Add member picker on the real
   store, their reads answered by the team settings stand-in
   (store/teamSettingsStandIn.setup.ts) over a workspace the test holds as
   the server's, which it can change and answer again as Convex reruns the
   open reads. The store loads its own copy, which a test can leave a team
   or a person out of, as the store will once it stops holding the whole
   roster. I am the admin of Testbed Labs. Crew has Leo, a Viewer with an
   old leader row and an agent with one; Bench has nobody. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../../lib/convex', async () => ({
  convex: network,
  live: (await import('../../store/guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const NOW = '2026-09-14T08:00:00.000Z'

type Pending = {
  name: string
  args: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (e: unknown) => void
}

let P: typeof import('../../store/planner')['P']
let pages: typeof import('./TeamSettings')
let shell: typeof import('../Settings')
let version: typeof import('../../store/usePlannerVersion')
/* The caps of the page the test loaded, which a test lowers. */
let caps: typeof import('../../lib/accessCaps')['TEAM_CAPS']
let requests: Pending[]
let toast: ReturnType<typeof vi.fn<(message: string, tone?: string) => void>>
let container: HTMLDivElement
let root: Root
/* What the server holds, the states it is asked to force, its reads, and
   the way to publish the store's workspace. */
let server: {
  snap: Snapshot
  force: ForcedTeamSettings
  reads: ReturnType<typeof teamSettingsServer>
  publish: (snap: Snapshot) => void
}
/* The one-shot reads of the team pages the page sent, by name and
   arguments. */
let queries: { name: string; args: Record<string, unknown> }[]
/* The removal previews the page asked for, each with its arguments. */
let previews: unknown[] = []
/* Every function the app read or watched over the client, by name, which
   a test empties once the store has loaded. The store's workspace parts
   come from the one workspace:whole watch the double holds
   (store/guard/liveDouble.setup.ts), so a name here is a read of its own. */
let opened: string[]

const org = () => server.snap.orgs[0].id
const me = () => server.snap.profiles[0].id

/** A person of my organization. */
const person = (
  snap: Snapshot,
  id: string,
  name: string,
  over: Partial<Snapshot['profiles'][number]> = {},
) =>
  snap.profiles.push({
    ...snap.profiles[0],
    id,
    auth_user_id: `account-${id}`,
    name,
    org_role: 'user',
    plannable_hours: 40,
    ...over,
  })

/** A team of my organization. */
const team = (snap: Snapshot, id: string, name: string) =>
  snap.teams.push({
    id,
    org_id: snap.orgs[0].id,
    name,
    track_delay_default: false,
    created_at: NOW,
  })

/** Loads the store from the fixture, which `shape` changes first; the store
    gets `leave` of a copy, so it can hold less than the server. */
async function load(shape?: (snap: Snapshot) => void, leave?: (snap: Snapshot) => void) {
  vi.resetModules()
  const snap = plannerFixture()
  person(snap, 'leo', 'Leo Berg')
  person(snap, 'vic', 'Vic Viewer', { org_role: 'viewer' })
  person(snap, 'bot', 'Relay', {
    kind: 'agent',
    auth_user_id: undefined,
    plannable_hours: undefined,
  })
  person(snap, 'gus', 'Gus Guest', { org_role: 'guest' })
  person(snap, 'off', 'Oli Off', { active: false })
  person(snap, 'inv', 'Ina Invited', { auth_user_id: undefined })
  team(snap, 'crew', 'Crew')
  team(snap, 'bench', 'Bench')
  snap.teamMembers.push(
    { team_id: 'crew', profile_id: 'leo', is_leader: false },
    { team_id: 'crew', profile_id: 'vic', is_leader: true },
    { team_id: 'crew', profile_id: 'bot', is_leader: true },
  )
  shape?.(snap)
  requests = []
  queries = []
  previews = []
  opened = []
  const reads = teamSettingsServer(
    () => server.snap,
    () => server.force,
  )
  server = { snap, force: {}, reads, publish: () => {} }
  const held = structuredClone(snap)
  leave?.(held)
  network.query.mockImplementation(async (ref, args) => {
    const name = getFunctionName(ref)
    opened.push(name)
    if (name.startsWith('teams:')) queries.push({ name, args })
    if (isTeamSettingsRead(name)) return await reads.query(name, args)
    if (name === 'accessRemovals:preview') {
      previews.push(args)
      return removalAnswer()
    }
    return null
  })
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    opened.push(name)
    if (isTeamSettingsRead(name)) return reads.watch(name, args, next, fail)
    if (name === 'workspace:whole') {
      server.publish = (value) => next(structuredClone(value))
      next(structuredClone(held))
    } else next(null)
    return () => {}
  })
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'identity:claimMySeats') return Promise.resolve(null)
    return new Promise((resolve, reject) => requests.push({ name, args, resolve, reject }))
  })
  const store = await import('../../store/planner')
  P = store.P
  await store.initStore()
  pages = await import('./TeamSettings')
  shell = await import('../Settings')
  version = await import('../../store/usePlannerVersion')
  caps = (await import('../../lib/accessCaps')).TEAM_CAPS
}

/* A removal preview in which nobody loses sight of a task, so the removal
   goes at once without a window. */
const removalAnswer = () => ({
  state: 'ok',
  pending: true,
  leave_only: false,
  people: [],
  tasks: 0,
  items: [],
  items_total: 0,
  hidden: 0,
  projects: [],
  keep: { targets: [], changers: [], allowed: true, refusal: null, offered: true, permitted: true },
  reassign: { allowed: true, refusal: null, permitted: true },
})

const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
/** Answers every open team read again, as Convex reruns them. */
const rerun = async () => {
  await act(async () => server.reads.rerun())
  await settle()
}
/** Waits out the search delay (250 ms) and the read it sends. */
const rest = async () => {
  await act(() => new Promise((resolve) => setTimeout(resolve, 300)))
  await settle()
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.spyOn(console, 'error').mockImplementation(() => {})
  toast = vi.fn<(message: string, tone?: string) => void>()
  window.showToast = toast
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(document, 'visibilityState')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  network.mutation.mockReset()
  network.query.mockReset()
  network.onUpdate.mockReset()
})

/* Renders `page` on the live store, as Settings does. */
async function show(page: () => React.ReactNode) {
  function Live() {
    version.usePlannerVersion()
    return page()
  }
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Live />
      </TooltipProvider>,
    ),
  )
  await settle()
}
const teamsPage = () => show(() => <pages.OrgTeamsPage setPage={vi.fn()} />)
const teamPage = (id = 'crew') => show(() => <pages.TeamPage teamId={id} setPage={vi.fn()} />)

const find = <E extends Element = HTMLElement>(selector: string) => {
  const el = document.querySelector<E>(selector)
  if (!el) throw new Error(`no ${selector}`)
  return el
}
const button = (label: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  )
const click = async (el: Element | null | undefined) => {
  if (!(el instanceof HTMLElement)) throw new Error('nothing to click')
  await act(async () => el.click())
  await settle()
}
async function type(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function answer(name: string, outcome: 'accept' | 'refuse') {
  const request = requests.find((r) => r.name === name)
  if (!request) throw new Error(`${name} was not sent`)
  requests = requests.filter((r) => r !== request)
  await act(async () => {
    if (outcome === 'accept') request.resolve(null)
    else request.reject(new ConvexError({ code: 'rule', message: 'the server said no' }))
  })
  await settle()
}
async function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await settle()
}
const open = (name: string) => server.reads.open().filter((r) => r.name === name)
const teamRows = () =>
  [...document.querySelectorAll<HTMLElement>('[data-team-row]')].map((row) => ({
    id: row.dataset.teamRow,
    name: row.querySelector('[data-team-open]')?.textContent,
    count: row.querySelector('[data-team-count]')?.textContent,
  }))
const memberIds = () =>
  [...document.querySelectorAll<HTMLElement>('[data-settings-team-member]')].map(
    (row) => row.dataset.settingsTeamMember,
  )
const teamsEnd = () => document.querySelector('[data-teams-end]')?.textContent ?? ''
const membersEnd = () => document.querySelector('[data-team-members-end]')?.textContent ?? ''
const deleteOf = (id: string) =>
  find<HTMLButtonElement>(`[data-team-row="${id}"] [data-team-delete]`)

/* ----------------------------------------------------- Settings › Teams */

describe('Settings › Teams', () => {
  it("lists the server's teams with its counts, in its key order, and reads nothing else", async () => {
    await load((snap) => team(snap, 'emile', 'Émile crew'))
    opened = []
    server.force = { counts: { bench: null } }
    await teamsPage()
    expect(teamRows()).toEqual([
      { id: 'bench', name: 'Bench', count: 'Not counted yet' },
      // the agent counts, as team_counts counts it
      { id: 'crew', name: 'Crew', count: '3 members' },
      // the server's byte order puts É after every ASCII letter
      { id: 'emile', name: 'Émile crew', count: '0 members' },
    ])
    expect(server.reads.open()).toEqual([{ name: 'teams:settingsPage', args: { org_id: org() } }])
    expect([...new Set(opened)]).toEqual(['teams:settingsPage'])
    expect(find('[data-org-teams]').dataset.teamsState).toBe('ok')
    expect(teamsEnd()).toBe('')
    // a count of one member
    server.snap.teamMembers = server.snap.teamMembers.filter((m) => m.profile_id === 'leo')
    await rerun()
    expect(teamRows()[1].count).toBe('1 member')
  })

  it('searches the whole list once typing rests, and says no team matches only at a real end', async () => {
    await load()
    await teamsPage()
    const box = find<HTMLInputElement>('[data-teams-search]')
    await type(box, 'crew')
    expect(teamRows().map((r) => r.id)).toEqual(['bench', 'crew'])
    await rest()
    expect(open('teams:settingsPage').map((r) => r.args)).toEqual([
      { org_id: org(), search: 'crew' },
    ])
    expect(teamRows().map((r) => r.id)).toEqual(['crew'])
    await type(box, 'nothing like it')
    await rest()
    expect(teamsEnd()).toBe('No teams match.')
    // a stopped batch is never a real end
    server.force = { stop: 1 }
    await type(box, 'zzz')
    await rest()
    expect(teamsEnd()).toContain(
      'Qivo checked part of the list and found no matches there. Load more continues.',
    )
    expect(teamsEnd()).not.toContain('No teams match.')
  })

  it('loads more, keeps the loaded batches live and asks for a search at the cap', async () => {
    await load((snap) => {
      for (let i = 0; i < 4; i++) team(snap, `t${i}`, `Team ${i}`)
    })
    // a live list gathers at most caps.teams / 25 batches, two here
    server.force = { batch: 2 }
    caps.teams = 50
    await teamsPage()
    expect(teamRows()).toHaveLength(2)
    await click(document.querySelector('[data-teams-more]'))
    expect(teamRows()).toHaveLength(4)
    // the first batch is pinned, the second is open
    expect(open('teams:settingsPage').map((r) => Object.keys(r.args).sort())).toEqual([
      ['org_id', 'through'],
      ['after', 'org_id'],
    ])
    expect(teamsEnd()).toBe('Search to find more teams.')
  })

  it('says loading, not ready, refused and failed apart, with Retry', async () => {
    await load()
    server.reads.hold(true)
    await teamsPage()
    expect(teamsEnd()).toBe('Loading teams…')
    expect(find('[data-org-teams]').getAttribute('aria-busy')).toBe('true')
    server.reads.hold(false)
    server.force = { notReady: true }
    await rerun()
    expect(teamsEnd()).toBe('The team list is not ready yet. Try again in a few minutes.')
    server.force = { refused: true }
    await rerun()
    expect(teamsEnd()).toBe('Only organization admins and team leaders can open the team settings.')
    server.force = { fail: ['settingsPage'] }
    await rerun()
    expect(teamsEnd()).toContain("Couldn't load teams.")
    server.force = {}
    await click(button('Retry', find('[data-org-teams]')))
    expect(teamRows()).toHaveLength(2)
  })

  it("turns Delete off for the organization's last team from the server's count, not the rows on screen", async () => {
    await load()
    await teamsPage()
    expect(deleteOf('crew').disabled).toBe(false)
    // a search shows one row of the two teams
    await type(find<HTMLInputElement>('[data-teams-search]'), 'crew')
    await rest()
    expect(teamRows()).toHaveLength(1)
    expect(deleteOf('crew').disabled).toBe(false)
    server.snap.teams = server.snap.teams.filter((t) => t.id !== 'bench')
    await rerun()
    expect(deleteOf('crew').disabled).toBe(true)
    expect(deleteOf('crew').getAttribute('aria-label')).toBe(
      "The last team can't be deleted. Create another team first.",
    )
  })

  it('hides a team whose deletion is on its way, and turns the last one left off at once', async () => {
    await load()
    vi.useFakeTimers({ toFake: ['Date'] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    await teamsPage()
    await click(deleteOf('crew'))
    vi.setSystemTime(Date.now() + CONFIRM_IGNORE_MS)
    await click(deleteOf('crew'))
    expect(requests.map((r) => r.name)).toEqual(['teams:deleteDeep'])
    expect(teamRows().map((r) => r.id)).toEqual(['bench'])
    expect(deleteOf('bench').disabled).toBe(true)
    // a refusal brings it back
    await answer('teams:deleteDeep', 'refuse')
    expect(teamRows().map((r) => r.id)).toEqual(['bench', 'crew'])
    expect(deleteOf('bench').disabled).toBe(false)
  })

  it('counts a deletion on its way that a search hides, so the last team left keeps Delete off', async () => {
    await load()
    vi.useFakeTimers({ toFake: ['Date'] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    await teamsPage()
    await click(deleteOf('crew'))
    vi.setSystemTime(Date.now() + CONFIRM_IGNORE_MS)
    await click(deleteOf('crew'))
    expect(requests.map((r) => r.name)).toEqual(['teams:deleteDeep'])
    // the search's batch holds Bench alone, and the server still counts Crew
    await type(find<HTMLInputElement>('[data-teams-search]'), 'bench')
    await rest()
    expect(open('teams:settingsPage').map((r) => r.args)).toEqual([
      { org_id: org(), search: 'bench' },
    ])
    expect(teamRows().map((r) => r.id)).toEqual(['bench'])
    expect(deleteOf('bench').disabled).toBe(true)
    // a refusal brings Crew back, and Bench's Delete with it
    await answer('teams:deleteDeep', 'refuse')
    expect(deleteOf('bench').disabled).toBe(false)
  })

  it('keeps a team created here past the loaded rows as Added until a batch holds it, and never shows a pending or refused one', async () => {
    await load()
    server.force = { batch: 1 }
    await teamsPage()
    const field = find<HTMLInputElement>('input[placeholder="New team name"]')
    await type(field, 'Field crew')
    await click(button('Add team'))
    const created = requests.find((r) => r.name === 'teams:create')?.args.id as string
    expect(document.querySelector('[data-team-kept]')).toBeNull()
    expect(teamRows().map((r) => r.name)).toEqual(['Bench'])
    // the server holds it now, past the one loaded batch, and delivers it
    // to the workspace before the create's answer
    team(server.snap, created, 'Field crew')
    await rerun()
    await act(async () =>
      server.publish({ ...server.snap, delivered_at: '2026-09-15T09:00:00.000Z' }),
    )
    await answer('teams:create', 'accept')
    expect(teamRows()).toEqual([
      { id: created, name: 'Field crew', count: 'Added' },
      { id: 'bench', name: 'Bench', count: '0 members' },
    ])
    await click(document.querySelector('[data-teams-more]'))
    await click(document.querySelector('[data-teams-more]'))
    expect(document.querySelector('[data-team-kept]')).toBeNull()
    expect(teamRows().map((r) => r.name)).toEqual(['Bench', 'Crew', 'Field crew'])
    // a refused create never shows
    await type(field, 'Other crew')
    await click(button('Add team'))
    await answer('teams:create', 'refuse')
    expect(document.body.textContent).not.toContain('Other crew')
  })

  it('drops a created team the server no longer holds once the list passed its place', async () => {
    await load()
    server.force = { batch: 1 }
    await teamsPage()
    await type(find<HTMLInputElement>('input[placeholder="New team name"]'), 'Aaa crew')
    await click(button('Add team'))
    const created = requests.find((r) => r.name === 'teams:create')?.args.id as string
    // the workspace delivers the team, but the server's list never holds it,
    // as when someone deleted it meanwhile
    const delivered = structuredClone(server.snap)
    team(delivered, created, 'Aaa crew')
    await act(async () =>
      server.publish({ ...delivered, delivered_at: '2026-09-15T09:00:00.000Z' }),
    )
    await answer('teams:create', 'accept')
    // the first batch reached Bench, past the place of Aaa crew
    expect(document.querySelector('[data-team-kept]')).toBeNull()
    expect(teamRows().map((r) => r.name)).toEqual(['Bench'])
  })

  it('keeps a team created while the tab is hidden as Added until a batch after the return holds it', async () => {
    await load()
    // a batch holds two teams, so the list of Bench and Crew has ended
    server.force = { batch: 2 }
    await teamsPage()
    expect(teamRows().map((r) => r.id)).toEqual(['bench', 'crew'])
    expect(teamsEnd()).toBe('')
    await type(find<HTMLInputElement>('input[placeholder="New team name"]'), 'Field crew')
    await click(button('Add team'))
    const created = requests.find((r) => r.name === 'teams:create')?.args.id as string
    // the server creates the team while the tab is hidden, which keeps the
    // ended list from before the create
    await setVisibility('hidden')
    team(server.snap, created, 'Field crew')
    await act(async () =>
      server.publish({ ...server.snap, delivered_at: '2026-09-15T09:00:00.000Z' }),
    )
    await answer('teams:create', 'accept')
    const kept = [
      { id: created, name: 'Field crew', count: 'Added' },
      { id: 'bench', name: 'Bench', count: '0 members' },
      { id: 'crew', name: 'Crew', count: '3 members' },
    ]
    expect(teamRows()).toEqual(kept)
    // back on the tab, the list reads again. Until that read answers, the
    // ended list it shows is from before the create, both in the first
    // render after the return and while it refreshes, so it tells nothing.
    server.reads.hold(true)
    await setVisibility('visible')
    expect(teamRows()).toEqual(kept)
    server.reads.hold(false)
    await rerun()
    // the new first batch ends at Crew, before Field crew's place
    expect(open('teams:settingsPage')).toHaveLength(1)
    expect(teamRows()).toEqual(kept)
    await click(document.querySelector('[data-teams-more]'))
    expect(document.querySelector('[data-team-kept]')).toBeNull()
    expect(teamRows().map((r) => r.name)).toEqual(['Bench', 'Crew', 'Field crew'])
  })

  it("lists a leader's teams with the non-admin description, and reads nothing for a seat that leads none", async () => {
    await load((snap) => {
      snap.profiles[0].org_role = 'user'
      snap.teamMembers.push({ team_id: 'bench', profile_id: snap.profiles[0].id, is_leader: true })
    }, undefined)
    await teamsPage()
    expect(teamRows().map((r) => r.id)).toEqual(['bench'])
    expect(document.body.textContent).toContain(
      'Teams you lead. Only organization admins can create or delete teams.',
    )
    expect(document.querySelector('[data-team-delete]')).toBeNull()
    await act(async () => root.unmount())
    root = createRoot(container)
    await load((snap) => {
      snap.profiles[0].org_role = 'user'
    })
    await teamsPage()
    expect(server.reads.open()).toEqual([])
    expect(document.body.textContent).toContain('You lead no team yet.')
  })

  it('stops its reads while the tab is hidden and reads again on return', async () => {
    await load()
    await teamsPage()
    await setVisibility('hidden')
    expect(server.reads.open()).toEqual([])
    expect(teamRows()).toHaveLength(2)
    team(server.snap, 'later', 'Later crew')
    await setVisibility('visible')
    expect(open('teams:settingsPage')).toHaveLength(1)
    expect(teamRows().map((r) => r.id)).toContain('later')
  })
})

/* ------------------------------------------------------ a team's page */

describe("a team's page", () => {
  it('waits for the server, then shows its name, count and members, and reads no task', async () => {
    await load()
    opened = []
    server.reads.hold(true)
    await teamPage()
    expect(document.body.textContent).toContain('Loading the team…')
    expect(document.querySelector('[data-settings-team-member]')).toBeNull()
    server.reads.hold(false)
    await rerun()
    expect(find<HTMLInputElement>('input[aria-label="Team name"]').value).toBe('Crew')
    expect(find('[data-team-member-count]').textContent).toBe('3 members')
    expect(memberIds()).toEqual(['leo', 'bot', 'vic'])
    expect(
      server.reads
        .open()
        .map((r) => r.name)
        .sort(),
    ).toEqual(['teams:get', 'teams:members'])
    expect(queries.map((q) => q.name)).toEqual([])
    // the page read nothing else, no task among it
    expect([...new Set(opened)].sort()).toEqual(['teams:get', 'teams:members'])
  })

  it('says it could not load the team with Try again, and that a gone team is no longer available', async () => {
    await load()
    server.force = { fail: ['get'] }
    await teamPage()
    expect(document.body.textContent).toContain("Couldn't load this team.")
    server.force = {}
    await click(button('Try again'))
    expect(find<HTMLInputElement>('input[aria-label="Team name"]').value).toBe('Crew')
    // a failure after an answer keeps it, with the writes off
    server.force = { fail: ['get'] }
    await rerun()
    expect(find('[data-team-settings-failed]').textContent).toContain("Couldn't refresh this team.")
    expect(find<HTMLInputElement>('input[aria-label="Team name"]').readOnly).toBe(true)
    expect(
      find<HTMLButtonElement>('[data-settings-team-member="leo"] [data-team-member-remove]')
        .disabled,
    ).toBe(true)
    // the hours still save, as the line says, since the server checks each save
    expect(find('[data-team-settings-failed]').textContent).toContain('Hours still save.')
    const hours = find<HTMLInputElement>('[data-plannable-for="leo"]')
    await act(async () => hours.focus())
    await type(hours, '30')
    await act(async () => hours.blur())
    await settle()
    expect(requests.map((r) => r.name)).toEqual(['profiles:setPlannableHours'])
    await answer('profiles:setPlannableHours', 'accept')
    server.force = { unavailable: true }
    await rerun()
    expect(find('[data-team-settings-state]').dataset.teamSettingsState).toBe('unavailable')
  })

  it('renames, sets a leader, adds and removes a member and deletes a team the store does not hold, each with what the page showed', async () => {
    await load(undefined, (held) => {
      held.teams = held.teams.filter((t) => t.id !== 'crew')
      held.teamMembers = held.teamMembers.filter((m) => m.team_id !== 'crew')
    })
    await teamPage()
    const org = server.snap.orgs[0].id
    // nothing waits for the store
    expect(document.querySelector('[data-team-waiting], [data-team-member-waiting]')).toBeNull()
    const name = find<HTMLInputElement>('input[aria-label="Team name"]')
    expect(name.value).toBe('Crew')
    expect(name.disabled).toBe(false)
    await act(async () => name.focus())
    await type(name, 'Field crew')
    await act(async () => name.blur())
    await settle()
    expect(requests.at(-1)).toMatchObject({
      name: 'teams:update',
      args: { org_id: org, id: 'crew', patch: { name: 'Field crew' }, expected: { name: 'Crew' } },
    })
    await answer('teams:update', 'accept')
    // the Leader box decides from what the row showed
    const leader = find<HTMLInputElement>(
      '[data-settings-team-member="leo"] [data-team-leader-toggle] input',
    )
    expect(leader.disabled).toBe(false)
    await click(leader)
    expect(requests.at(-1)).toMatchObject({
      name: 'teams:setLeader',
      args: { org_id: org, team_id: 'crew', profile_id: 'leo', is_leader: true },
    })
    await answer('teams:setLeader', 'accept')
    // Add member sends to the page's organization
    await click(find('[data-team-member-picker]'))
    await click(document.querySelector('[data-team-member-choice="off"]'))
    await click(find('[data-team-member-add]'))
    expect(requests.at(-1)).toMatchObject({
      name: 'teams:addMember',
      args: { org_id: org, team_id: 'crew', profile_id: 'off' },
    })
    expect(find('[data-settings-team-member="off"] [data-team-member-kept]').textContent).toBe(
      'Added',
    )
    // a refused add takes the kept row away, with no store to tell it
    await answer('teams:addMember', 'refuse')
    expect(document.querySelector('[data-settings-team-member="off"]')).toBeNull()
    // Remove asks the preview of the change in the page's organization,
    // named as the row showed them
    const remove = () =>
      find<HTMLButtonElement>('[data-settings-team-member="leo"] [data-team-member-remove]')
    expect(remove().disabled).toBe(false)
    await click(remove())
    // the second press counts past the confirm's ignore time
    await act(async () => await new Promise((r) => setTimeout(r, 550)))
    await click(remove())
    await settle()
    expect(previews.at(-1)).toMatchObject({
      org_id: org,
      change: { team_id: 'crew', user_id: 'leo' },
    })
    expect(requests.at(-1)).toMatchObject({
      name: 'teams:removeMember',
      args: { org_id: org, team_id: 'crew', profile_id: 'leo' },
    })
    await act(async () => root.unmount())
    root = createRoot(container)
    await teamsPage()
    expect(deleteOf('crew').disabled).toBe(false)
    expect(document.querySelector('[data-team-waiting]')).toBeNull()
  })

  it("shows the store's hours and role while it holds the person, else the answer's", async () => {
    await load(undefined, (held) => {
      const leo = held.profiles.find((p) => p.id === 'leo')
      if (leo) leo.plannable_hours = 32
      // the store holds Vic as a user, as after this session promoted them
      const vic = held.profiles.find((p) => p.id === 'vic')
      if (vic) vic.org_role = 'user'
      held.profiles = held.profiles.filter((p) => p.id !== 'bot')
    })
    await teamPage()
    expect(find<HTMLInputElement>('[data-plannable-for="leo"]').value).toBe('32')
    expect(
      document.querySelector('[data-settings-team-member="vic"] [data-viewer-chip]'),
    ).toBeNull()
    // the agent the store does not hold shows from the answer, and nothing
    // waits for the store
    const bot = find('[data-settings-team-member="bot"]')
    expect(bot.hasAttribute('data-team-member-waiting')).toBe(false)
    expect(bot.textContent).toContain('Relay')
    expect(bot.querySelector('[data-plannable-unbounded]')).not.toBeNull()
  })

  it("locks Leader for a Viewer and an agent, and paints the store's change at once", async () => {
    await load()
    await teamPage()
    const leader = (id: string) =>
      find<HTMLInputElement>(`[data-settings-team-member="${id}"] [data-team-leader-toggle] input`)
    // a Viewer never leads; an agent's old leader row can still be cleared
    expect(leader('vic').disabled).toBe(true)
    expect(leader('vic').checked).toBe(true)
    expect(leader('bot').disabled).toBe(false)
    expect(leader('leo').checked).toBe(false)
    await click(leader('leo'))
    expect(requests.map((r) => r.name)).toEqual(['teams:setLeader'])
    expect(leader('leo').checked).toBe(true)
  })

  it('searches the members on the server and loads more, and says no member matches only at a real end', async () => {
    await load((snap) => {
      for (let i = 0; i < 3; i++) {
        person(snap, `p${i}`, `Person ${i}`)
        snap.teamMembers.push({ team_id: 'crew', profile_id: `p${i}`, is_leader: false })
      }
    })
    server.force = { batch: 2 }
    await teamPage()
    expect(memberIds()).toEqual(['leo', 'p0'])
    await click(document.querySelector('[data-team-members-more]'))
    expect(memberIds()).toEqual(['leo', 'p0', 'p1', 'p2'])
    await type(find<HTMLInputElement>('[data-team-members-search]'), 'person 2')
    await rest()
    expect(memberIds()).toEqual(['p2'])
    expect(open('teams:members').map((r) => r.args)).toEqual([
      { org_id: org(), team_id: 'crew', search: 'person 2' },
    ])
    await type(find<HTMLInputElement>('[data-team-members-search]'), 'nobody')
    await rest()
    expect(membersEnd()).toBe('No members match.')
    expect(document.querySelector('[data-team-members-none]')).toBeNull()
  })

  it('says No members yet only at the real end of a team with nobody', async () => {
    await load()
    server.force = { fail: ['members'] }
    await teamPage('bench')
    expect(membersEnd()).toContain("Couldn't load members.")
    expect(document.querySelector('[data-team-members-none]')).toBeNull()
    server.force = { notReady: true }
    await click(button('Retry', find('[data-team-members]')))
    expect(membersEnd()).toBe('The member list is not ready yet. Try again in a few minutes.')
    expect(document.querySelector('[data-team-members-none]')).toBeNull()
    server.force = {}
    await rerun()
    expect(find('[data-team-members-none]').textContent).toBe('No members yet.')
    expect(find('[data-team-member-count]').textContent).toBe('0 members')
  })

  it('keeps a row with unsaved hours through a search that hides it, and lets it go once saved', async () => {
    await load()
    await teamPage()
    const hours = () => find<HTMLInputElement>('[data-plannable-for="leo"]')
    const field = hours()
    await act(async () => field.focus())
    await type(field, '30')
    await type(find<HTMLInputElement>('[data-team-members-search]'), 'relay')
    await rest()
    expect(memberIds()).toEqual(['leo', 'bot'])
    // the same field, so its draft and focus stay
    expect(hours()).toBe(field)
    expect(field.value).toBe('30')
    expect(document.activeElement).toBe(field)
    expect(find('[data-settings-team-member="leo"] [data-team-member-kept]').textContent).toBe(
      'Not in this list',
    )
    await act(async () => field.blur())
    await settle()
    expect(requests.map((r) => r.name)).toEqual(['profiles:setPlannableHours'])
    // the store painted the hours, but the row waits for the server's answer
    expect(memberIds()).toEqual(['leo', 'bot'])
    await answer('profiles:setPlannableHours', 'accept')
    expect(memberIds()).toEqual(['bot'])
  })

  it('keeps a row whose hours save waits through a search, and shows the refused hours and the conflict in it', async () => {
    await load()
    await teamPage()
    const field = find<HTMLInputElement>('[data-plannable-for="leo"]')
    await act(async () => field.focus())
    await type(field, '30')
    await act(async () => field.blur())
    await settle()
    expect(requests.map((r) => r.name)).toEqual(['profiles:setPlannableHours'])
    // the search starts while the save waits, its paint reading as saved
    await type(find<HTMLInputElement>('[data-team-members-search]'), 'relay')
    await rest()
    expect(memberIds()).toEqual(['leo', 'bot'])
    expect(find('[data-settings-team-member="leo"] [data-team-member-kept]').textContent).toBe(
      'Not in this list',
    )
    // someone else set 36 first, so the server refuses the save over it
    const leo = server.snap.profiles.find((p) => p.id === 'leo')
    if (leo) leo.plannable_hours = 36
    await act(async () =>
      server.publish({ ...server.snap, delivered_at: '2026-09-15T09:00:00.000Z' }),
    )
    const request = requests.find((r) => r.name === 'profiles:setPlannableHours')
    await act(async () =>
      request?.reject(
        new ConvexError({
          code: 'conflict',
          reason: 'field_changed',
          message: 'plannable_hours changed since you read it',
          changes: [{ record: 'profile', id: 'leo', field: 'plannable_hours', by: null, at: NOW }],
        }),
      ),
    )
    await settle()
    // the same field holds the typed hours, with the value the server keeps
    expect(memberIds()).toEqual(['leo', 'bot'])
    expect(find<HTMLInputElement>('[data-plannable-for="leo"]')).toBe(field)
    expect(field.value).toBe('30')
    expect(find('[data-settings-team-member="leo"] [data-draft-conflict]').textContent).toContain(
      'Changed elsewhere to “36”.',
    )
    // Use saved lets the draft go, and the row with it
    await click(find('[data-settings-team-member="leo"] [data-draft-use-saved]'))
    expect(memberIds()).toEqual(['bot'])
  })

  it('keeps a member added here as Added until a batch holds them, and offers only who may join', async () => {
    await load()
    await teamPage()
    // nothing is read until the picker opens
    expect(queries).toEqual([])
    await click(find('[data-team-member-picker]'))
    expect(queries.map((q) => q.name)).toEqual(['teams:addable'])
    const offered = [...document.querySelectorAll<HTMLElement>('[data-team-member-choice]')].map(
      (c) => [
        c.dataset.teamMemberChoice,
        c.querySelector('.truncate')?.textContent,
        c.querySelector('.ml-auto')?.textContent ?? null,
      ],
    )
    // members and guests left out; switched-off and invited people offered
    expect(offered).toEqual([
      ['inv', 'Ina Invited', 'invited'],
      ['off', 'Oli Off', 'switched off'],
      [me(), 'Planner', null],
    ])
    await click(document.querySelector('[data-team-member-choice="off"]'))
    expect(document.querySelector('[data-team-member-choices]')).toBeNull()
    expect(find('[data-team-member-picker]').textContent).toContain('Oli Off')
    // the list shows one member a batch, so Oli sorts past what it loaded
    server.force = { batch: 1 }
    await rerun()
    expect(memberIds()).toEqual(['leo'])
    await click(find('[data-team-member-add]'))
    expect(requests.map((r) => [r.name, r.args.profile_id])).toEqual([['teams:addMember', 'off']])
    expect(find('[data-team-member-picker]').textContent).toContain('Add member…')
    // the store painted the membership, which no loaded batch holds
    expect(memberIds()).toEqual(['off', 'leo'])
    expect(find('[data-settings-team-member="off"] [data-team-member-kept]').textContent).toBe(
      'Added',
    )
    server.snap.teamMembers.push({ team_id: 'crew', profile_id: 'off', is_leader: false })
    await rerun()
    expect(memberIds()).toEqual(['off', 'leo'])
    await click(document.querySelector('[data-team-members-more]'))
    expect(document.querySelector('[data-team-member-kept]')).toBeNull()
    expect(memberIds()).toEqual(['leo', 'off'])
  })

  it('keeps a member added to a team whose whole list shows as Added until the server answers, then lets the list tell', async () => {
    await load()
    await teamPage()
    // Crew fits one batch, so its list has ended
    expect(memberIds()).toEqual(['leo', 'bot', 'vic'])
    const add = async (id: string) => {
      await click(find('[data-team-member-picker]'))
      await click(document.querySelector(`[data-team-member-choice="${id}"]`))
      await click(find('[data-team-member-add]'))
    }
    await add('off')
    expect(requests.map((r) => [r.name, r.args.profile_id])).toEqual([['teams:addMember', 'off']])
    // the ended list's answer is from before the add, so it tells nothing
    expect(memberIds()).toEqual(['off', 'leo', 'bot', 'vic'])
    expect(find('[data-settings-team-member="off"] [data-team-member-kept]').textContent).toBe(
      'Added',
    )
    // the server reruns the list with the membership before it answers the add
    server.snap.teamMembers.push({ team_id: 'crew', profile_id: 'off', is_leader: false })
    await rerun()
    expect(document.querySelector('[data-team-member-kept]')).toBeNull()
    expect(memberIds()).toEqual(['leo', 'off', 'bot', 'vic'])
    await answer('teams:addMember', 'accept')
    expect(memberIds()).toEqual(['leo', 'off', 'bot', 'vic'])
    // once the server added Ina, the ended list tells that it no longer
    // holds her, as when someone removed her meanwhile
    await add('inv')
    expect(memberIds()).toEqual(['inv', 'leo', 'off', 'bot', 'vic'])
    await answer('teams:addMember', 'accept')
    expect(memberIds()).toEqual(['leo', 'off', 'bot', 'vic'])
  })

  it('keeps a member added again while their first add waits, since the second sends nothing', async () => {
    await load()
    await teamPage()
    const add = async () => {
      await click(find('[data-team-member-picker]'))
      await click(document.querySelector('[data-team-member-choice="off"]'))
      await click(find('[data-team-member-add]'))
    }
    await add()
    // the picker asks the server, which has not added Oli yet, so it offers
    // her again, and the store, which holds her membership, sends nothing
    await add()
    expect(requests.map((r) => [r.name, r.args.profile_id])).toEqual([['teams:addMember', 'off']])
    expect(memberIds()).toEqual(['off', 'leo', 'bot', 'vic'])
    expect(find('[data-settings-team-member="off"] [data-team-member-kept]').textContent).toBe(
      'Added',
    )
    // the server reruns the list with the membership, then answers the add
    server.snap.teamMembers.push({ team_id: 'crew', profile_id: 'off', is_leader: false })
    await rerun()
    await answer('teams:addMember', 'accept')
    expect(document.querySelector('[data-team-member-kept]')).toBeNull()
    expect(memberIds()).toEqual(['leo', 'off', 'bot', 'vic'])
  })

  it('keeps an added member while the page is hidden, since the answers it holds are from before the add', async () => {
    await load()
    await teamPage()
    await click(find('[data-team-member-picker]'))
    await click(document.querySelector('[data-team-member-choice="off"]'))
    await click(find('[data-team-member-add]'))
    await setVisibility('hidden')
    server.snap.teamMembers.push({ team_id: 'crew', profile_id: 'off', is_leader: false })
    await answer('teams:addMember', 'accept')
    expect(memberIds()).toEqual(['off', 'leo', 'bot', 'vic'])
    // back on the page, the list reads again. Until that read answers, the
    // ended list it shows is from before the add, both in the first render
    // after the return and while it refreshes, so it tells nothing.
    server.reads.hold(true)
    await setVisibility('visible')
    expect(memberIds()).toEqual(['off', 'leo', 'bot', 'vic'])
    expect(find('[data-settings-team-member="off"] [data-team-member-kept]').textContent).toBe(
      'Added',
    )
    server.reads.hold(false)
    await rerun()
    expect(document.querySelector('[data-team-member-kept]')).toBeNull()
    expect(memberIds()).toEqual(['leo', 'off', 'bot', 'vic'])
  })
})

/* -------------------------------------------------------- Add member */

describe('Add member', () => {
  const choices = () =>
    [...document.querySelectorAll<HTMLElement>('[data-team-member-choice]')].map(
      (c) => c.dataset.teamMemberChoice,
    )
  const picker = () => find('[data-team-member-choices]')

  it('keeps the chosen person by id and name through a search, Load more and the popover closing', async () => {
    await load((snap) => {
      for (let i = 0; i < 4; i++) person(snap, `p${i}`, `Person ${i}`)
    })
    server.force = { batch: 2 }
    await teamPage()
    await click(find('[data-team-member-picker]'))
    expect(choices()).toEqual(['inv', 'off'])
    await click(document.querySelector('[data-team-member-choice="off"]'))
    await click(find('[data-team-member-picker]'))
    await click(document.querySelector('[data-picker-more]'))
    expect(choices()).toEqual(['inv', 'off', 'p0', 'p1'])
    await type(find<HTMLInputElement>('[data-team-member-picker-search]'), 'person 3')
    await rest()
    expect(choices()).toEqual(['p3'])
    expect(queries.at(-1)?.args).toEqual({ org_id: org(), team_id: 'crew', search: 'person 3' })
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    await settle()
    expect(find('[data-team-member-picker]').dataset.teamMemberTarget).toBe('off')
    expect(find('[data-team-member-picker]').textContent).toContain('Oli Off')
  })

  it('says why it lists nobody: refused, not ready, failed with Try again, stopped and the cap', async () => {
    await load()
    server.force = { refused: true }
    await teamPage()
    await click(find('[data-team-member-picker]'))
    expect(picker().textContent).toContain(
      'Requires an organization admin or a leader of this team.',
    )
    expect(picker().textContent).not.toContain('Nobody else can join this team.')
    await act(async () => root.unmount())
    root = createRoot(container)
    server.force = { notReady: true }
    await teamPage()
    await click(find('[data-team-member-picker]'))
    expect(picker().textContent).toContain("People can't be listed yet.")
    await act(async () => root.unmount())
    root = createRoot(container)
    server.force = { fail: ['addable'] }
    await teamPage()
    await click(find('[data-team-member-picker]'))
    expect(picker().textContent).toContain("Couldn't load people.")
    server.force = { stop: 1 }
    await click(button('Try again', picker()))
    expect(picker().textContent).toContain('Showing the people found so far.')
    expect(picker().textContent).not.toContain('No people match.')
    await act(async () => root.unmount())
    root = createRoot(container)
    server.force = { batch: 1 }
    caps.choices = 1
    await teamPage()
    await click(find('[data-team-member-picker]'))
    expect(picker().textContent).toContain('Search to narrow the list.')
    await act(async () => root.unmount())
    root = createRoot(container)
    server.force = { unavailable: true }
    await teamPage()
    expect(document.body.textContent).toContain('This team is no longer available.')
    // the picker says a team that went is gone, never that a project is
    expect(MEMBER_WORDS.held({ state: 'unavailable' })).toBe('This team is no longer available.')
  })

  it('says nobody else can join only at the real end of a team everyone is in', async () => {
    await load((snap) => {
      for (const p of snap.profiles)
        if (p.org_role !== 'guest' && !['leo', 'vic', 'bot'].includes(p.id))
          snap.teamMembers.push({ team_id: 'crew', profile_id: p.id, is_leader: false })
    })
    await teamPage()
    await click(find('[data-team-member-picker]'))
    expect(choices()).toEqual([])
    expect(picker().textContent).toContain('Nobody else can join this team.')
  })
})

/* ------------------------------------------------------ the Settings shell */

describe('the Settings shell', () => {
  async function openSettings(page: string) {
    const reset = vi.fn()
    function Live() {
      version.usePlannerVersion()
      return (
        <shell.SettingsScreen
          page={page}
          setPage={vi.fn()}
          resetPage={reset}
          onExit={vi.fn()}
          onNewProject={vi.fn()}
          onNewSubProject={vi.fn()}
          onOpenArchivedTasks={vi.fn()}
        />
      )
    }
    await act(async () =>
      root.render(
        <TooltipProvider>
          <Live />
        </TooltipProvider>,
      ),
    )
    await settle()
    return reset
  }

  it("opens a team's page the store does not hold from the server's answer, and moves on when the answer refuses it", async () => {
    await load(undefined, (held) => {
      held.teams = held.teams.filter((t) => t.id !== 'crew')
      held.teamMembers = held.teamMembers.filter((m) => m.team_id !== 'crew')
    })
    let reset = await openSettings('team:crew')
    expect(reset).not.toHaveBeenCalled()
    expect(find('[data-settings-page="team:crew"] h1').textContent).toBe('Crew')
    expect(memberIds()).toEqual(['leo', 'bot', 'vic'])
    // loading and a failure move nothing
    await act(async () => root.unmount())
    root = createRoot(container)
    server.reads.hold(true)
    reset = await openSettings('team:crew')
    expect(reset).not.toHaveBeenCalled()
    server.reads.hold(false)
    server.force = { fail: ['get'] }
    await rerun()
    expect(reset).not.toHaveBeenCalled()
    server.force = { unavailable: true }
    await rerun()
    expect(reset).toHaveBeenCalledWith('account')
  })

  it('moves on from a team whose answer does not let the caller manage it', async () => {
    await load((snap) => {
      snap.profiles[0].org_role = 'user'
      snap.teamMembers.push({ team_id: 'bench', profile_id: snap.profiles[0].id, is_leader: true })
    })
    const reset = await openSettings('team:crew')
    expect(reset).toHaveBeenCalledWith('account')
  })
})

/* ------------------------------------------------------------ the store */

describe('the store', () => {
  it('answers null for a picker read that failed, and creates a team with the id it is given', async () => {
    await load()
    network.query.mockRejectedValueOnce(new Error('offline'))
    expect(await P.teamMemberChoices({ org_id: org(), team_id: 'crew' }, '', null)).toBeNull()
    expect(
      await P.teamMemberChoices({ org_id: org(), team_id: 'crew' }, 'leo', null),
    ).toMatchObject({ state: 'ready', rows: [] })
    void P.addTeam('Field crew', '11111111-1111-4111-8111-111111111111')
    void P.addTeam('Other crew')
    const sent = requests.filter((r) => r.name === 'teams:create').map((r) => r.args)
    expect(sent[0]).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Field crew',
    })
    expect(sent[1].id).toMatch(/^[0-9a-f-]{36}$/)
    expect(P.teamById('11111111-1111-4111-8111-111111111111')?.name).toBe('Field crew')
  })
})
