// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../../components/ui/tooltip'
import type { SyncPlaceScope } from '../../lib/teamSync'
import { plannerFixture, type Snapshot } from '../../store/plannerFixture.setup'
import {
  type ForcedTeamSettings,
  isTeamSettingsRead,
  teamSettingsServer,
} from '../../store/teamSettingsStandIn.setup'

/* Team sync's scope menu on the real store, its teams from the server
   (teams.picker through the team stand-in) and a team scope the person is
   not in named from teams.get. The organization has 50 teams; the
   signed-in person, a standard user, is in one of them, Team 07, which is
   the only team the store holds. */

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

const AT = '2026-09-14T08:00:00.000Z'
const team = (n: number) => `team-${String(n).padStart(2, '0')}`

let snap: Snapshot
let force: ForcedTeamSettings
let menu: typeof import('./SyncScopeMenu')
let container: HTMLDivElement
let root: Root
/** every teams:picker read's arguments, oldest first */
let asked: Record<string, unknown>[]
/** whether teams:get holds its answers back until `release` */
let holdGet: boolean
let release: (() => void)[]

async function load() {
  vi.resetModules()
  snap = plannerFixture()
  const org = snap.orgs[0].id
  snap.profiles[0].org_role = 'user'
  for (let i = 0; i < 50; i++)
    snap.teams.push({
      id: team(i),
      org_id: org,
      name: `Team ${String(i).padStart(2, '0')}`,
      track_delay_default: true,
      created_at: AT,
    })
  snap.teamMembers.push({ team_id: team(7), profile_id: snap.profiles[0].id, is_leader: false })
  force = {}
  asked = []
  holdGet = false
  release = []
  const reads = teamSettingsServer(
    () => snap,
    () => force,
  )
  network.query.mockImplementation(async (ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'teams:picker') asked.push(args)
    if (isTeamSettingsRead(name)) return await reads.query(name, args)
    return null
  })
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'teams:get' && holdGet) {
      release.push(() => void reads.watch(name, args, next, fail))
      return () => {}
    }
    if (isTeamSettingsRead(name)) return reads.watch(name, args, next, fail)
    next(structuredClone(snap))
    return () => {}
  })
  network.mutation.mockResolvedValue(null)
  const store = await import('../../store/planner')
  await store.initStore()
  menu = await import('./SyncScopeMenu')
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })
const rest = () => act(() => new Promise((resolve) => setTimeout(resolve, 300)))
const picked: string[] = []

async function render(scope: SyncPlaceScope, named = true) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <menu.SyncScopeMenu scope={scope} named={named} onPick={(key) => picked.push(key)} />
      </TooltipProvider>,
    ),
  )
  await settle()
}
const trigger = () => document.querySelector<HTMLElement>('[data-sync-scope-trigger]')
const open = async () => {
  await act(async () => trigger()?.click())
  await settle()
}
const teamChoices = () =>
  [...document.querySelectorAll<HTMLElement>('[data-sync-scope-choice^="team:"]')].map((row) =>
    row.dataset.syncScopeChoice?.slice('team:'.length),
  )
const type = async (text: string) => {
  const input = document.querySelector<HTMLInputElement>('[data-sync-scope-search]')
  if (!input) throw new Error('no search box')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await rest()
  await settle()
}
const end = () => document.querySelector('[data-sync-scope-menu]')?.textContent ?? ''
// the menu's Load more and Try again are cmdk items, which a click selects
const button = (text: string) =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '[data-sync-scope-menu] [role="option"], [data-sync-scope-menu] button',
    ),
  ].find((b) => b.textContent?.trim() === text)

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  picked.length = 0
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await load()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Team sync's scope menu", () => {
  it('lists the organization’s 50 teams from the server 25 at a time, never the store’s own team alone', async () => {
    await render({ kind: 'all' })
    // nothing is read while the menu is closed
    expect(asked).toEqual([])
    await open()
    expect(asked).toEqual([{ org_id: snap.orgs[0].id }])
    expect(teamChoices()).toEqual(Array.from({ length: 25 }, (_, i) => team(i)))
    await act(async () => button('Load more')?.click())
    await settle()
    expect(teamChoices()).toEqual(Array.from({ length: 50 }, (_, i) => team(i)))
    expect(asked).toHaveLength(2)
    expect(asked[1]).toHaveProperty('after')
    // a pick hands the scope's key to the page
    await act(async () =>
      document.querySelector<HTMLElement>(`[data-sync-scope-choice="team:${team(31)}"]`)?.click(),
    )
    await settle()
    expect(picked).toEqual([`team:${team(31)}`])
  })

  it('searches every team on the server, and says no team matches only at a real end', async () => {
    await render({ kind: 'all' })
    await open()
    await type('team 4')
    expect(asked.at(-1)).toEqual({ org_id: snap.orgs[0].id, search: 'team 4' })
    // every word in the name, in any order: Team 04, 14, 24, 34 and 40 to 49
    expect(teamChoices()).toEqual(
      Array.from({ length: 50 }, (_, i) => i)
        .filter((i) => String(i).padStart(2, '0').includes('4'))
        .map(team),
    )
    await type('nothing like it')
    expect(teamChoices()).toEqual([])
    expect(end()).toContain('No matching teams.')
  })

  it('says why it lists no team while the server is not ready, and offers Try again after a failure', async () => {
    force = { notReady: true }
    await render({ kind: 'all' })
    await open()
    expect(teamChoices()).toEqual([])
    expect(end()).toContain("Teams can't be listed yet.")
    await act(async () => root.render(null))
    force = { fail: ['picker'] }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await render({ kind: 'all' })
    await open()
    expect(end()).toContain("Couldn't load teams.")
    force = {}
    await act(async () => button('Try again')?.click())
    await settle()
    expect(teamChoices()).toHaveLength(25)
  })

  it('names the person’s own team at once, and another team from teams.get, loading until it answers', async () => {
    await render({ kind: 'team', id: team(7) })
    expect(trigger()?.dataset.syncScopeTrigger).toBe('Team 07')
    holdGet = true
    await render({ kind: 'team', id: team(31) })
    // never "Choose a scope" for a team it has not named yet
    expect(trigger()?.dataset.syncScopeTrigger).toBe('Loading…')
    holdGet = false
    for (const go of release) go()
    await settle()
    expect(trigger()?.dataset.syncScopeTrigger).toBe('Team 31')
    // a team the server cannot show says so
    await render({ kind: 'team', id: 'team-gone' })
    expect(trigger()?.dataset.syncScopeTrigger).toBe('Team not available')
    // no scope asks for one
    await render({ kind: 'none' }, false)
    expect(trigger()?.dataset.syncScopeTrigger).toBe('Choose a scope')
  })
})
