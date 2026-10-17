// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../../components/ui/tooltip'
import type { DeletedMatch, DeletedRow, Deleter } from '../../lib/deletedItems'
import { plannerFixture, type Snapshot } from '../../store/plannerFixture.setup'

/* The Deleted items page on the real store, with the network mocked. The
   fixture's one person (me) is an admin unless a test makes them a lead or a
   standard user. Each test delivers the deletedItems.list answer it needs and
   says how the server answers restore, purge and the search. The clock is
   fixed at 15:00 local time on 16 Oct 2026, so rows deleted at 14:0x read
   "Today 14:0x" in any time zone. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../../lib/convex', () => ({ convex: network }))
vi.mock('../../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

type Answer = {
  restored?: string[]
  purged?: string[]
  refused?: { id: string; reason: string }[]
  deferred?: string[]
}
type Subscription = {
  args: { deleted_by?: string }
  next: (value: unknown) => void
  fail: (cause: unknown) => void
  live: boolean
}
type Search = {
  text: string
  next: (rows: DeletedMatch[]) => void
  fail: (cause: unknown) => void
  live: boolean
}

const NOW = new Date(2026, 9, 16, 15, 0)
const at = (h: number, m: number, s = 0, day = 16) => new Date(2026, 9, day, h, m, s).toISOString()

let snap: Snapshot
let ORG: string
let container: HTMLDivElement
let root: Root
let lists: Subscription[]
// the server's answers, per call; a call without one never settles
let answers: Record<string, ((args: Record<string, unknown>) => Promise<Answer>) | undefined>
// the page's deletedItems.matches subscriptions, one per searched text
let searches: Search[]

const DANIEL: Deleter = {
  you: false,
  profile_id: 'daniel',
  name: 'Daniel Berg',
  kind: 'app',
  who: 'daniel|app',
}
const CURSOR: Deleter = {
  ...DANIEL,
  kind: 'mcp_tokens',
  credential_name: 'Cursor',
  who: 'daniel|mcp_tokens:tok-1',
}
const MIRA: Deleter = {
  you: false,
  profile_id: 'mira',
  name: 'Mira Holm',
  kind: 'app',
  who: 'mira|app',
}
/** The viewer's own delete, as a standard user's list holds only these. */
const ME: Deleter = { you: true, profile_id: 'me', name: 'Planner', kind: 'app', who: 'me|app' }

function task(num: number, patch: Partial<DeletedRow> = {}): DeletedRow {
  return {
    id: `item-${num}`,
    org_id: ORG,
    org_name: 'Testbed Labs',
    kind: 'task',
    key: `QN-${num}`,
    title: `Task ${num}`,
    status: 'todo',
    counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
    projects: [],
    path: ['Luma Sensor', 'Firmware'],
    archived: false,
    deleted_at: at(14, 0),
    deleter: DANIEL,
    state: 'ready',
    can_restore: true,
    can_purge: false,
    ...patch,
  }
}
const trial = (patch: Partial<DeletedRow> = {}): DeletedRow =>
  task(0, {
    id: 'item-trial',
    kind: 'project',
    key: 'FTQ',
    title: 'Field trial Q3',
    status: undefined,
    path: [],
    counts: { tasks: 48, archived_tasks: 9, subtasks: 0, sub_projects: 2 },
    deleter: MIRA,
    deleted_at: at(16, 40, 0, 15),
    ...patch,
  })
/** A search hit inside the deleted project Field trial Q3 (trial). */
const hit = (patch: Partial<DeletedMatch> = {}): DeletedMatch => ({
  item_id: 'item-trial',
  item_kind: 'project',
  org_id: ORG,
  org_name: 'Testbed Labs',
  key: 'QN-12',
  title: 'Book test sites in Umeå',
  archived: false,
  path: ['Field trial Q3', 'Site preparation'],
  deleted_at: at(16, 40, 0, 15),
  deleter: MIRA,
  state: 'ready',
  can_restore: true,
  ...patch,
})
/** A search hit of a task deleted on its own on 2 Oct, older than the lists
    the tests deliver hold. */
const taskHit = (patch: Partial<DeletedMatch> = {}): DeletedMatch => ({
  item_id: 'item-old',
  item_kind: 'task',
  org_id: ORG,
  org_name: 'Testbed Labs',
  key: 'QN-77',
  title: 'Calibrate the humidity sensor',
  archived: false,
  path: ['Luma Sensor', 'Firmware'],
  deleted_at: at(9, 0, 0, 2),
  deleter: DANIEL,
  state: 'ready',
  can_restore: true,
  ...patch,
})
/** `n` tasks Daniel deleted with Cursor, 20 seconds apart from 14:05 down. */
const burst = (n: number, from = 100) =>
  Array.from({ length: n }, (_, i) =>
    task(from + i, {
      deleter: CURSOR,
      deleted_at: new Date(Date.parse(at(14, 5)) - i * 20_000).toISOString(),
    }),
  )

/** Who the fixture's person is. `archived lead` leads only an archived
    project. */
type Role = 'admin' | 'lead' | 'archived lead' | 'user'

function fixture(role: Role) {
  const next = plannerFixture()
  const me = next.profiles[0]
  if (role !== 'admin') me.org_role = 'user'
  if (role === 'lead' || role === 'archived lead') next.projects[0].lead_id = me.id
  if (role === 'archived lead') next.projects[0].archived_at = '2026-10-01T08:00:00.000Z'
  return next
}

/** Loads the store. `setup` changes the snapshot first, to add people. */
async function load(role: Role = 'admin', setup?: (snapshot: Snapshot) => void) {
  vi.resetModules()
  snap = fixture(role)
  setup?.(snap)
  ORG = snap.orgs[0].id
  lists = []
  answers = {}
  searches = []
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'snapshot:forMe') next(structuredClone(snap))
    if (name === 'deletedItems:matches') {
      const subscription: Search = { text: args.text, next, fail, live: true }
      searches.push(subscription)
      return () => {
        subscription.live = false
      }
    }
    if (name !== 'deletedItems:list') return () => {}
    const subscription: Subscription = { args, next, fail, live: true }
    lists.push(subscription)
    return () => {
      subscription.live = false
    }
  })
  network.query.mockImplementation(() => Promise.resolve(null))
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'identity:claimMySeats') return Promise.resolve(null)
    return answers[name]?.(args) ?? new Promise(() => {})
  })
  const store = await import('../../store/planner')
  await store.initStore()
}

beforeEach(async () => {
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
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
  network.mutation.mockReset()
  network.query.mockReset()
  network.onUpdate.mockReset()
})

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}
/** Renders the page as Settings does, re-rendering on store changes. */
async function open(role: Role = 'admin', setup?: (snapshot: Snapshot) => void) {
  await load(role, setup)
  const page = await import('./DeletedItems')
  const version = await import('../../store/usePlannerVersion')
  function Live() {
    version.usePlannerVersion()
    return <page.DeletedItemsPage />
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
/** Answers the page's live list subscriptions, as a delivery does. */
function push(items: DeletedRow[], capped = false) {
  for (const s of lists.filter((l) => l.live && l.args.deleted_by === undefined))
    s.next({ items: structuredClone(items), capped })
}
async function deliver(items: DeletedRow[], capped = false) {
  await act(async () => push(items, capped))
  await settle()
}

function find<T extends Element = HTMLElement>(selector: string) {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}
const has = (selector: string) => document.querySelector(selector) !== null
const text = (selector: string) => find(selector).textContent ?? ''
const rowOf = (id: string) => find(`[data-deleted-row="${id}"]`)
const rowIds = () =>
  [...document.querySelectorAll<HTMLElement>('[data-line]')].map((el) => el.dataset.line)
const checkbox = (id: string) => find<HTMLButtonElement>(`[data-deleted-row="${id}"] [data-select]`)
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
const button = (label: string) => {
  const match = buttons().find((b) => b.textContent?.trim() === label)
  if (!match) throw new Error(`Missing button ${label}`)
  return match
}
const calls = (name: string) =>
  network.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === name).map(([, a]) => a)
async function click(element: HTMLElement) {
  await act(async () => element.click())
  await settle()
}
async function search(value: string) {
  const input = find<HTMLInputElement>('[data-deleted-search]')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
/** Waits past the search's 250ms pause. */
const pause = () => act(async () => await new Promise((r) => setTimeout(r, 300)))
/** Types `value`, waits past the pause and answers the search with `matches`. */
async function found(value: string, matches: DeletedMatch[]) {
  await search(value)
  await pause()
  const last = searches[searches.length - 1]
  await act(async () => last.next(matches))
  await settle()
}
/** Picks the Deleted by choice labelled `label`. */
async function deletedByChoice(label: string) {
  const select = find<HTMLSelectElement>('[data-deleted-by]')
  await act(async () => {
    select.value = [...select.options].find((o) => o.text === label)?.value ?? ''
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}
/** Answers the live list narrowed to `profile`, as a delivery does. */
async function deliverNarrowed(profile: string, items: DeletedRow[], capped = false) {
  const list = lists.find((l) => l.live && l.args.deleted_by === profile)
  if (!list) throw new Error(`No list narrowed to ${profile}`)
  await act(async () => list.next({ items: structuredClone(items), capped }))
  await settle()
}

describe('who the page speaks to', () => {
  it('tells each role what it lists, and offers Deleted by to admins and leads only', async () => {
    await open('admin')
    await deliver([task(1)])
    expect(text('.settings-page-title')).toContain(
      'Tasks and projects deleted in your organization.',
    )
    expect(has('[data-deleted-by]')).toBe(true)

    await act(async () => root.unmount())
    root = createRoot(container)
    await open('lead')
    await deliver([task(1)])
    expect(text('.settings-page-title')).toContain(
      'Tasks and projects you deleted, and those deleted in projects you lead.',
    )
    expect(has('[data-deleted-by]')).toBe(true)

    await act(async () => root.unmount())
    root = createRoot(container)
    await open('user')
    await deliver([task(1, { deleter: ME })])
    expect(text('.settings-page-title')).toContain('Tasks and projects you deleted.')
    expect(text('.settings-page-title')).not.toContain('organization')
    expect(has('[data-deleted-by]')).toBe(false)
  })

  it('speaks to a lead whose projects are archived or in Deleted items as a lead', async () => {
    const lead = 'Tasks and projects you deleted, and those deleted in projects you lead.'
    await open('archived lead')
    await deliver([task(1, { deleter: ME })])
    expect(text('.settings-page-title')).toContain(lead)
    expect(has('[data-deleted-by]')).toBe(true)

    await act(async () => root.unmount())
    root = createRoot(container)
    await open('user')
    await deliver([task(1, { deleter: ME })])
    expect(text('.settings-page-title')).not.toContain(lead)
    // only a lead's list holds deletes by other people, here in a project
    // the person led before it went to Deleted items
    await deliver([task(1, { deleter: ME }), trial()])
    expect(text('.settings-page-title')).toContain(lead)
    expect(has('[data-deleted-by]')).toBe(true)
  })

  it('says when it is loading, failed or empty, and tries again', async () => {
    await open()
    expect(text('[data-deleted-items]')).toContain('Loading…')
    await act(async () => lists[0].fail(new Error('offline')))
    expect(text('[role="alert"]')).toContain("Couldn't load deleted items.")
    await click(button('Try again'))
    expect(lists.filter((s) => s.live)).toHaveLength(1)
    expect(lists[0].live).toBe(false)
    await deliver([])
    expect(text('[data-deleted-items]')).toContain('No deleted items.')
    await deliver([task(1)], true)
    expect(text('[data-deleted-items]')).toContain(
      'Not every item is shown. Search to find older ones.',
    )
    await search('nothing like it')
    expect(text('[data-deleted-items]')).toContain('No deleted items match the filter.')
    expect(text('[data-deleted-count]')).toBe('0 of 1 item')
    // the page never names how long items stay
    expect(document.body.textContent).not.toMatch(/30 days|days left/)
  })
})

describe('the rows', () => {
  it('folds a long run of one who, opens it, and keeps it open through a delivery', async () => {
    await open()
    const rows = [...burst(12), task(1, { deleted_at: at(13, 0) })]
    await deliver(rows)
    expect(rowIds()).toEqual([...rows.slice(0, 7).map((r) => r.id), 'item-1'])
    const fold = find('[data-fold]')
    expect(fold.textContent).toContain(
      'and 5 more tasks Daniel Berg deleted via Cursor, today 14:01 to 14:02',
    )
    await click(find('[data-show-all]'))
    expect(rowIds()).toEqual(rows.map((r) => r.id))
    expect(has('[data-show-fewer]')).toBe(true)
    // focus lands on the first row the run shows now
    expect(document.activeElement).toBe(checkbox('item-107'))
    // a newer delete by the same who keeps the run open
    await deliver([task(200, { deleter: CURSOR, deleted_at: at(14, 6) }), ...rows])
    expect(rowIds()).toHaveLength(14)
    await click(find('[data-show-fewer]'))
    expect(rowIds()).toHaveLength(8)
    expect(document.activeElement).toBe(find('[data-show-all]'))
  })

  it('does not fold the same person deleting another way, nor ten rows', async () => {
    await open()
    const mixed = [
      ...burst(6),
      ...burst(6, 200).map((r) => ({ ...r, deleter: DANIEL, deleted_at: at(14, 3) })),
    ]
    await deliver(mixed)
    expect(has('[data-fold]')).toBe(false)
    expect(rowIds()).toHaveLength(12)
    await deliver(burst(10))
    expect(has('[data-fold]')).toBe(false)
  })

  it('shows each kind of row with its place, deleter, reason and time', async () => {
    await open()
    await deliver([
      task(212, {
        deleter: CURSOR,
        deleted_at: at(14, 9),
        counts: { tasks: 3, archived_tasks: 0, subtasks: 2, sub_projects: 0 },
      }),
      trial(),
      task(0, {
        id: 'item-blog',
        kind: 'project',
        title: 'Blog migration',
        status: undefined,
        path: ['Website'],
        counts: { tasks: 12, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
        deleted_at: at(10, 5, 0, 2),
      }),
      task(155, {
        reason: 'Duplicate of QN-150',
        deleted_at: new Date(2026, 8, 21, 15, 47).toISOString(),
      }),
    ])
    const first = rowOf('item-212')
    expect(first.textContent).toContain('QN-212Task 212and 2 subtasks')
    expect(text('[data-deleted-row="item-212"] [data-row-place]')).toBe('Luma Sensor › Firmware')
    expect(text('[data-deleted-row="item-212"] [data-row-who]')).toBe(
      'Daniel Berg via Cursor, personal token',
    )
    expect(text('[data-deleted-row="item-212"] [data-row-time]')).toBe('Today 14:09')
    expect(rowOf('item-trial').textContent).toContain(
      'Field trial Q3with 2 sub-projects and 48 tasks',
    )
    expect(text('[data-deleted-row="item-trial"] [data-row-time]')).toBe('Yesterday 16:40')
    expect(has('[data-deleted-row="item-trial"] [data-row-place]')).toBe(false)
    expect(text('[data-deleted-row="item-blog"] [data-row-place]')).toBe('Sub-project in Website')
    expect(rowOf('item-blog').textContent).toContain('and its 12 tasks')
    expect(text('[data-deleted-row="item-155"] [data-row-note="reason"]')).toBe(
      'Reason “Duplicate of QN-150”',
    )
    expect(text('[data-deleted-row="item-blog"] [data-row-time]')).toBe('2 Oct 10:05')
    expect(text('[data-deleted-row="item-155"] [data-row-time]')).toBe('21 Sep 15:47')
  })

  it('shows a view-only and a redacted row without Restore or a selectable box', async () => {
    await open('user')
    await deliver([
      task(305, {
        path: ['Website', 'Pricing'],
        deleter: { ...DANIEL, you: true },
        can_restore: false,
        blocked: { reason: 'view_only', project: 'Website', lead: 'Aisha Khan' },
      }),
      task(7, {
        redacted: true,
        path: [],
        status: undefined,
        deleter: ME,
        can_restore: false,
        blocked: { reason: 'no_access' },
      }),
      task(8, { deleter: ME }),
    ])
    expect(text('[data-deleted-row="item-305"] [data-row-note="blocked"]')).toBe(
      'You can only view Website now. Ask its lead, Aisha Khan, to restore it.',
    )
    expect(text('[data-deleted-row="item-305"] [data-row-who]')).toBe('You')
    expect(has('[data-deleted-row="item-305"] [data-restore]')).toBe(false)
    expect(checkbox('item-305').disabled).toBe(true)
    expect(text('[data-deleted-row="item-7"] [data-row-place]')).toBe(
      "Deleted with a task in a project you can't open",
    )
    expect(has('[data-deleted-row="item-7"] [data-row-notes]')).toBe(false)
    expect(has('[data-deleted-row="item-7"] [data-restore]')).toBe(false)
    expect(checkbox('item-7').disabled).toBe(true)
    // the restorable row keeps both
    expect(has('[data-deleted-row="item-8"] [data-restore]')).toBe(true)
    expect(checkbox('item-8').disabled).toBe(false)
  })

  it('dims moving and restoring rows, says stuck, and groups organizations only when there are two', async () => {
    await open()
    await deliver([
      task(1, { state: 'moving', can_restore: false }),
      task(2, { state: 'restoring', can_restore: false }),
      task(3, { state: 'stuck', can_restore: false, can_purge: true }),
    ])
    expect(text('[data-deleted-row="item-1"] [data-row-note="state"]')).toBe(
      'Moving to Deleted items…',
    )
    expect(text('[data-deleted-row="item-2"] [data-row-note="state"]')).toBe('Restoring…')
    expect(rowOf('item-1').className).toContain('opacity-60')
    expect(has('[data-deleted-row="item-1"] [data-select]')).toBe(false)
    expect(text('[data-deleted-row="item-3"] [data-row-note="state"]')).toBe(
      "Couldn't finish moving this item. Delete it now, or contact support.",
    )
    expect(has('[data-deleted-row="item-3"] [data-restore]')).toBe(false)
    expect(has('[data-deleted-row="item-3"] [data-row-menu]')).toBe(true)
    expect(has('[data-org-group]')).toBe(false)

    await deliver([
      task(1),
      task(2, { org_id: 'org-other', org_name: 'Aurora Studio', deleted_at: at(14, 30) }),
    ])
    const groups = [...document.querySelectorAll<HTMLElement>('[data-org-group]')]
    expect(groups.map((g) => g.firstElementChild?.textContent)).toEqual([
      'Testbed Labs',
      'Aurora Studio',
    ])
  })
})

describe('selecting and restoring', () => {
  it('restores one row at once and moves focus to the next Restore', async () => {
    await open()
    answers['deletedItems:restore'] = async (args) => {
      // the delivery without the row lands before the answer, as Convex orders them
      push([task(2, { deleted_at: at(14, 5) }), task(3)])
      return { restored: args.ids as string[], refused: [], deferred: [] }
    }
    await deliver([task(1, { deleted_at: at(14, 9) }), task(2, { deleted_at: at(14, 5) }), task(3)])
    const restore = find<HTMLButtonElement>('[data-deleted-row="item-1"] [data-restore]')
    restore.focus()
    await click(restore)
    expect(calls('deletedItems:restore')).toEqual([{ org_id: ORG, ids: ['item-1'] }])
    expect(window.showToast).toHaveBeenCalledWith('Restored QN-1', undefined)
    expect(has('[data-deleted-row="item-1"]')).toBe(false)
    expect(document.activeElement).toBe(find('[data-deleted-row="item-2"] [data-restore]'))
  })

  it('says what a refused restore needs, and changes nothing', async () => {
    await open()
    answers['deletedItems:restore'] = async () => ({
      restored: [],
      refused: [{ id: 'item-1', reason: 'project_archived' }],
      deferred: [],
    })
    await deliver([task(1)])
    await click(find('[data-deleted-row="item-1"] [data-restore]'))
    expect(window.showToast).toHaveBeenCalledWith(
      "Couldn't restore QN-1. Restore its project from Archived projects first.",
      'error',
    )
    expect(text('[data-deleted-row="item-1"] [data-row-note="refused"]')).toBe(
      'Restore its project from Archived projects first.',
    )
  })

  it('selects only restorable rows, and drops a selected row that becomes blocked', async () => {
    await open()
    const blocked = task(3, {
      can_restore: false,
      blocked: { reason: 'project_archived', project: 'Website' },
    })
    await deliver([task(1), task(2), blocked])
    await click(find('[data-select-all]'))
    expect(text('[data-deleted-count]')).toBe('2 selected')
    expect(find('[data-select-all]').getAttribute('data-state')).toBe('checked')
    expect(checkbox('item-3').getAttribute('data-state')).toBe('unchecked')
    // a blocked row's box does nothing
    await click(checkbox('item-3'))
    expect(text('[data-deleted-count]')).toBe('2 selected')
    // someone archived the project of item-2, so it leaves the selection
    await deliver([
      task(1),
      task(2, { can_restore: false, blocked: { reason: 'project_archived', project: 'Docs' } }),
      blocked,
    ])
    expect(text('[data-deleted-count]')).toBe('1 selected')
    expect(text('[data-restore-selected]')).toBe('Restore 1 selected')
    await click(find('[data-clear-selection]'))
    expect(text('[data-deleted-count]')).toBe('3 items')
  })

  it('asks before restoring several, says who deleted them and where they go', async () => {
    await open()
    answers['deletedItems:restore'] = async (args) => ({
      restored: args.ids as string[],
      refused: [],
      deferred: [],
    })
    const three = [
      task(1, { deleter: CURSOR, deleted_at: at(14, 9) }),
      task(2, {
        deleter: CURSOR,
        deleted_at: at(14, 4),
        counts: { tasks: 3, archived_tasks: 0, subtasks: 2, sub_projects: 0 },
      }),
      task(3, { deleter: CURSOR, deleted_at: at(14, 2), path: ['Luma Sensor', 'Hardware'] }),
    ]
    await deliver([...three, trial()])
    for (const r of three) await click(checkbox(r.id))
    await click(find('.deleted-selection-actions [data-restore-selected]'))
    expect(text('[data-modal-shell] h2')).toBe('Restore 3 tasks?')
    const body = text('[data-bulk-restore]')
    expect(body).toContain(
      'Daniel Berg deleted them via Cursor (personal token) today, 14:02 to 14:09. They come back where they were, with comments and attachments.',
    )
    expect(
      [...document.querySelectorAll('[data-destination]')].map((el) => el.textContent),
    ).toEqual(['Luma Sensor › Firmware2 tasks and 2 subtasks', 'Luma Sensor › Hardware1 task'])
    expect(body).toContain('They keep their keys. Labels deleted since then are gone.')
    expect(calls('deletedItems:restore')).toEqual([])
    await click(button('Restore 3 tasks'))
    expect(calls('deletedItems:restore')).toEqual([
      { org_id: ORG, ids: ['item-1', 'item-2', 'item-3'] },
    ])
    expect(window.showToast).toHaveBeenCalledWith('Restored 3 tasks', undefined)
    expect(has('[data-modal-shell]')).toBe(false)
    expect(document.activeElement).toBe(find('[data-select-all]'))
  })

  it('names no deleter when they differ, calls mixed kinds items, and sends 25 at a time', async () => {
    await open()
    const many = burst(30)
    // Mira deleted the project the same day, so no one person did it all
    await deliver([...many, trial({ deleted_at: at(13, 0) })])
    await click(find('[data-select-all]'))
    await click(find('.deleted-selection-actions [data-restore-selected]'))
    expect(text('[data-modal-shell] h2')).toBe('Restore 31 items?')
    expect(text('[data-bulk-restore] p')).toBe(
      'They come back where they were, with comments and attachments.',
    )
    expect(text('[data-destination]')).toBe(
      'Field trial Q3project with 2 sub-projects and 48 tasks',
    )
    answers['deletedItems:restore'] = async (args) => {
      const ids = args.ids as string[]
      // the server refuses one of the second call
      const refused = ids.includes('item-129') ? [{ id: 'item-129', reason: 'conflict' }] : []
      return { restored: ids.filter((id) => id !== 'item-129'), refused, deferred: [] }
    }
    await click(button('Restore 31 items'))
    const sent = calls('deletedItems:restore').map((a) => (a.ids as string[]).length)
    expect(sent).toEqual([25, 6])
    expect(window.showToast).toHaveBeenCalledWith(
      "Restored 30 of 31 items. 1 couldn't be restored.",
      'error',
    )
    // the one that failed stays selected, with its reason
    expect(text('[data-deleted-count]')).toBe('1 selected')
    await click(find('[data-show-all]'))
    expect(text('[data-deleted-row="item-129"] [data-row-note="refused"]')).toBe(
      'Something now uses its key, so it cannot come back.',
    )
  })

  it('keeps the rows when the organization is read-only and says so', async () => {
    await open()
    const { ConvexError } = await import('convex/values')
    answers['deletedItems:restore'] = () =>
      Promise.reject(
        new ConvexError({
          code: 'forbidden',
          reason: 'billing_required',
          message: 'Your organization is read-only until billing is fixed.',
        }),
      )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await deliver([task(1), task(2)])
    await click(find('[data-select-all]'))
    await click(find('.deleted-selection-actions [data-restore-selected]'))
    await click(button('Restore 2 tasks'))
    expect(window.showToast).toHaveBeenCalledWith(
      'Your organization is read-only until billing is fixed.',
      'error',
    )
    expect(text('[data-deleted-count]')).toBe('2 selected')
    // the window stays for another try
    expect(has('[data-bulk-restore]')).toBe(true)
  })
})

describe('items that wait for a deleted project', () => {
  it('restores the project first, then the item once the list shows it restorable', async () => {
    await open()
    const early = task(5, {
      deleted_at: at(9, 0, 0, 14),
      can_restore: false,
      blocked: { reason: 'project_deleted', item_id: 'item-trial' },
    })
    answers['deletedItems:restore'] = async (args) => {
      const ids = args.ids as string[]
      if (ids.includes('item-trial'))
        return { restored: ['item-trial'], refused: [], deferred: ['item-5'] }
      return { restored: ids, refused: [], deferred: [] }
    }
    await deliver([trial(), early])
    expect(text('[data-deleted-row="item-5"] [data-row-note="blocked"]')).toBe(
      'Its project, Field trial Q3, is in Deleted items too.',
    )
    expect(checkbox('item-5').disabled).toBe(true)
    await click(find('[data-deleted-row="item-5"] [data-restore]'))
    expect(text('[data-modal-shell] h2')).toBe('QN-5 is in a deleted project')
    expect(text('[data-project-first]')).toContain(
      'QN-5 was deleted before its project Field trial Q3, which is in Deleted items too.',
    )
    await click(button('Restore Field trial Q3 and QN-5'))
    expect(calls('deletedItems:restore')).toEqual([{ org_id: ORG, ids: ['item-trial', 'item-5'] }])
    expect(window.showToast).toHaveBeenCalledWith('Restored “Field trial Q3”', undefined)
    // while the project is not back yet, nothing more is sent
    await deliver([trial({ state: 'restoring', can_restore: false }), early])
    expect(calls('deletedItems:restore')).toHaveLength(1)
    // the project is back, so the item is restorable now and goes on its own
    await deliver([{ ...early, can_restore: true, blocked: undefined }])
    expect(calls('deletedItems:restore')).toEqual([
      { org_id: ORG, ids: ['item-trial', 'item-5'] },
      { org_id: ORG, ids: ['item-5'] },
    ])
    expect(window.showToast).toHaveBeenLastCalledWith('Restored QN-5', undefined)
  })

  it('sends a deferred item at once when the list showed it restorable before the answer', async () => {
    await open()
    const early = task(5, {
      deleted_at: at(9, 0, 0, 14),
      can_restore: false,
      blocked: { reason: 'project_deleted', item_id: 'item-trial' },
    })
    let answer: (value: Answer) => void = () => {}
    answers['deletedItems:restore'] = (args) => {
      const ids = args.ids as string[]
      if (ids.includes('item-trial')) return new Promise((resolve) => (answer = resolve))
      return Promise.resolve({ restored: ids, refused: [], deferred: [] })
    }
    await deliver([trial(), early])
    await click(find('[data-deleted-row="item-5"] [data-restore]'))
    await click(button('Restore Field trial Q3 and QN-5'))
    // a small project is back within the call, and its list arrives before the answer
    await deliver([{ ...early, can_restore: true, blocked: undefined }])
    await act(async () => answer({ restored: ['item-trial'], refused: [], deferred: ['item-5'] }))
    await settle()
    expect(calls('deletedItems:restore')).toEqual([
      { org_id: ORG, ids: ['item-trial', 'item-5'] },
      { org_id: ORG, ids: ['item-5'] },
    ])
    expect(window.showToast).toHaveBeenLastCalledWith('Restored QN-5', undefined)
  })

  it('forgets a waiting item that left the list', async () => {
    await open()
    answers['deletedItems:restore'] = async () => ({
      restored: ['item-trial'],
      refused: [],
      deferred: ['item-5'],
    })
    const early = task(5, {
      deleted_at: at(9, 0, 0, 14),
      can_restore: false,
      blocked: { reason: 'project_deleted', item_id: 'item-trial' },
    })
    await deliver([trial(), early])
    await click(find('[data-deleted-row="item-5"] [data-restore]'))
    await click(button('Restore Field trial Q3 and QN-5'))
    await deliver([])
    await deliver([{ ...early, can_restore: true, blocked: undefined }])
    expect(calls('deletedItems:restore')).toHaveLength(1)
  })

  it('sends a waiting item when its project is back while another person is shown', async () => {
    await open()
    answers['deletedItems:restore'] = async (args) => {
      const ids = args.ids as string[]
      if (ids.includes('item-trial'))
        return { restored: ['item-trial'], refused: [], deferred: ['item-5'] }
      return { restored: ids, refused: [], deferred: [] }
    }
    const early = task(5, {
      deleted_at: at(9, 0, 0, 14),
      can_restore: false,
      blocked: { reason: 'project_deleted', item_id: 'item-trial' },
    })
    const mira = task(1, { deleter: MIRA })
    await deliver([mira, trial(), early], true)
    await click(find('[data-deleted-row="item-5"] [data-restore]'))
    await click(button('Restore Field trial Q3 and QN-5'))
    // Mira's deletes do not hold Daniel's item, which still waits
    await deletedByChoice('Mira Holm')
    await deliverNarrowed('mira', [mira, trial({ state: 'restoring', can_restore: false })])
    expect(rowIds()).toEqual(['item-1', 'item-trial'])
    // nor does a capped list that stops before it prove it left
    await deliver([mira], true)
    expect(calls('deletedItems:restore')).toHaveLength(1)
    // the project is back, and the main list shows the item restorable
    await deliver([mira, { ...early, can_restore: true, blocked: undefined }], true)
    expect(calls('deletedItems:restore')).toEqual([
      { org_id: ORG, ids: ['item-trial', 'item-5'] },
      { org_id: ORG, ids: ['item-5'] },
    ])
    expect(window.showToast).toHaveBeenLastCalledWith('Restored QN-5', undefined)
  })

  it('sends a waiting item that only a narrowed list holds once that list is back', async () => {
    await open()
    answers['deletedItems:restore'] = async (args) => {
      const ids = args.ids as string[]
      if (ids.includes('item-trial'))
        return { restored: ['item-trial'], refused: [], deferred: ['item-5'] }
      return { restored: ids, refused: [], deferred: [] }
    }
    const mira = task(1, { deleter: MIRA })
    const early = task(5, {
      deleter: MIRA,
      deleted_at: at(9, 0, 0, 14),
      can_restore: false,
      blocked: { reason: 'project_deleted', item_id: 'item-trial' },
    })
    // the capped list holds none of Mira's older deletes
    await deliver([mira, task(2)], true)
    await deletedByChoice('Mira Holm')
    await deliverNarrowed('mira', [mira, trial(), early])
    await click(find('[data-deleted-row="item-5"] [data-restore]'))
    await click(button('Restore Field trial Q3 and QN-5'))
    // no list shown now holds the item, and the capped one is no proof it left
    await deletedByChoice('Deleted by anyone')
    await deliver([mira, task(2)], true)
    expect(calls('deletedItems:restore')).toHaveLength(1)
    await deletedByChoice('Mira Holm')
    await deliverNarrowed('mira', [mira, { ...early, can_restore: true, blocked: undefined }])
    expect(calls('deletedItems:restore')).toEqual([
      { org_id: ORG, ids: ['item-trial', 'item-5'] },
      { org_id: ORG, ids: ['item-5'] },
    ])
  })
})

describe('Deleted by', () => {
  it('filters on the page, and asks the server for one person when the list is capped', async () => {
    await open()
    await deliver([task(1, { deleter: CURSOR }), task(2, { deleter: MIRA }), task(3)])
    const select = find<HTMLSelectElement>('[data-deleted-by]')
    // the admin is in their organization's roster, deletes or not
    expect([...select.options].map((o) => o.text)).toEqual([
      'Deleted by anyone',
      'You',
      'Daniel Berg',
      'Daniel Berg via Cursor',
      'Mira Holm',
    ])
    const choose = async (label: string) => {
      const option = [...select.options].find((o) => o.text === label)
      await act(async () => {
        select.value = option?.value ?? ''
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await settle()
    }
    await choose('Daniel Berg via Cursor')
    expect(rowIds()).toEqual(['item-1'])
    await choose('Daniel Berg')
    expect(rowIds()).toEqual(['item-3', 'item-1'])
    expect(text('[data-deleted-count]')).toBe('2 of 3 items')
    // an uncapped list holds every delete, so nothing more is asked
    expect(lists.filter((l) => l.args.deleted_by !== undefined)).toEqual([])

    await deliver([task(1, { deleter: CURSOR }), task(2, { deleter: MIRA })], true)
    const narrowed = lists.filter((l) => l.live && l.args.deleted_by === 'daniel')
    expect(narrowed).toHaveLength(1)
    expect(text('[data-deleted-items]')).toContain('Loading…')
    await act(async () =>
      narrowed[0].next({
        items: [task(1, { deleter: CURSOR }), task(9, { deleted_at: at(8, 0, 0, 1) })],
        capped: false,
      }),
    )
    await settle()
    expect(rowIds()).toEqual(['item-1', 'item-9'])
    expect(text('[data-deleted-count]')).toBe('2 items')
    await choose('Deleted by anyone')
    expect(narrowed[0].live).toBe(false)
    // the same time: the newer id first, as the server orders them
    expect(rowIds()).toEqual(['item-2', 'item-1'])
  })

  it('offers an admin everyone in the organization, and asks for those a capped list leaves out', async () => {
    const people = (s: Snapshot) => {
      const me = s.profiles[0]
      type Profile = Snapshot['profiles'][number]
      const person = (id: string, name: string, extra: Partial<Profile> = {}): Profile => ({
        ...me,
        id,
        name,
        org_role: 'user',
        auth_user_id: `account-${id}`,
        ...extra,
      })
      s.profiles.push(
        person('daniel', 'Daniel Berg'),
        person('mira', 'Mira Holm'),
        // switched off since, and an agent, which deletes with its key
        person('ines', 'Ines Park', { active: false }),
        person('triage', 'Triage agent', { kind: 'agent', auth_user_id: undefined }),
        // invited and never signed in, so they cannot have deleted anything
        person('noor', 'Noor Ali', { auth_user_id: undefined }),
      )
    }
    const options = () =>
      [...find<HTMLSelectElement>('[data-deleted-by]').options].map((o) => o.text)
    const gone: Deleter = { you: false, kind: 'app', who: '|app' }
    await open('admin', people)
    // the capped list holds none of the admin's, Ines's or the agent's deletes
    await deliver(
      [task(1, { deleter: CURSOR }), task(2, { deleter: MIRA }), task(3, { deleter: gone })],
      true,
    )
    expect(options()).toEqual([
      'Deleted by anyone',
      'You',
      'Daniel Berg',
      'Ines Park',
      'Mira Holm',
      'Triage agent',
      'Someone',
    ])
    await deletedByChoice('Triage agent')
    expect(lists.filter((l) => l.live && l.args.deleted_by !== undefined)).toHaveLength(1)
    await deliverNarrowed('triage', [])
    expect(text('[data-deleted-items]')).toContain('No deleted items match the filter.')
    expect(find<HTMLSelectElement>('[data-deleted-by]').selectedOptions[0]?.text).toBe(
      'Triage agent',
    )
    const ines: Deleter = {
      you: false,
      profile_id: 'ines',
      name: 'Ines Park',
      kind: 'app',
      who: 'ines|app',
    }
    await deletedByChoice('Ines Park')
    await deliverNarrowed('ines', [task(8, { deleter: ines, deleted_at: at(9, 0, 0, 2) })])
    expect(rowIds()).toEqual(['item-8'])

    // a lead's choices come from the list, since the server reads the same
    // ranges for a lead with or without one
    await act(async () => root.unmount())
    root = createRoot(container)
    await open('lead', people)
    await deliver([task(1, { deleter: CURSOR }), task(2, { deleter: MIRA })], true)
    expect(options()).toEqual(['Deleted by anyone', 'Daniel Berg', 'Mira Holm'])
  })
})

describe('Delete now', () => {
  it('lets an admin delete a row for good from its menu', async () => {
    await open()
    answers['deletedItems:purge'] = async (args) => {
      push([task(2, { can_purge: true })])
      return { purged: args.ids as string[], refused: [] }
    }
    await deliver([
      task(155, {
        title: 'Show battery level in the status bar',
        can_purge: true,
        deleted_at: at(14, 9),
      }),
      task(2, { can_purge: true }),
    ])
    await click(find('[data-deleted-row="item-155"] [data-row-menu]'))
    await click(find('[data-delete-now]'))
    expect(text('[data-modal-shell] h2')).toBe('Delete QN-155 for good?')
    // this one cannot be undone, so the whole window is red
    expect(find('[data-modal-shell]').className).toContain('var(--danger)')
    expect(text('[data-purge]')).toBe(
      'Deletes QN-155 Show battery level in the status bar and its comments and attachments. This cannot be undone.',
    )
    expect(calls('deletedItems:purge')).toEqual([])
    await click(button('Delete for good'))
    expect(calls('deletedItems:purge')).toEqual([{ org_id: ORG, ids: ['item-155'] }])
    expect(window.showToast).toHaveBeenCalledWith('Deleted QN-155 for good', undefined)
    expect(has('[data-deleted-row="item-155"]')).toBe(false)
    expect(has('[data-modal-shell]')).toBe(false)
    expect(document.activeElement).toBe(find('[data-deleted-row="item-2"] [data-restore]'))
  })

  it('describes a project, and offers no menu where the server allows no Delete now', async () => {
    await open()
    await deliver([trial({ can_purge: true }), task(2, { can_purge: false })])
    expect(has('[data-deleted-row="item-2"] [data-row-menu]')).toBe(false)
    await click(find('[data-deleted-row="item-trial"] [data-row-menu]'))
    await click(find('[data-delete-now]'))
    expect(text('[data-modal-shell] h2')).toBe('Delete Field trial Q3 for good?')
    expect(text('[data-purge]')).toBe(
      'Deletes Field trial Q3, its 2 sub-projects and 48 tasks with their comments and attachments. This cannot be undone.',
    )
    await click(button('Cancel'))
    expect(calls('deletedItems:purge')).toEqual([])
    expect(has('[data-deleted-row="item-trial"]')).toBe(true)
  })

  it('says a project also deletes the items deleted from it earlier', async () => {
    await open()
    const empty = trial({
      can_purge: true,
      counts: { tasks: 0, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
    })
    const waits = (id: string) => ({
      can_restore: false,
      can_purge: true,
      deleted_at: at(9, 0, 0, 14),
      blocked: { reason: 'project_deleted' as const, item_id: id },
    })
    const blog = task(0, {
      ...waits('item-trial'),
      id: 'item-blog',
      kind: 'project',
      title: 'Blog migration',
      status: undefined,
      path: ['Field trial Q3'],
      counts: { tasks: 0, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
      blocked: { reason: 'parent_deleted', item_id: 'item-trial' },
    })
    const purgeText = async (id: string) => {
      await click(find(`[data-deleted-row="${id}"] [data-row-menu]`))
      await click(find('[data-delete-now]'))
      const said = text('[data-purge]')
      await click(button('Cancel'))
      return said
    }
    // one task waits for the project, and a sub-project with a task of its own
    await deliver([
      empty,
      task(5, waits('item-trial')),
      blog,
      task(6, waits('item-blog')),
      task(7, waits('item-other')),
      task(1, { can_purge: true }),
    ])
    expect(await purgeText('item-trial')).toBe(
      'Deletes Field trial Q3. It also deletes 3 items deleted from the project earlier. This cannot be undone.',
    )
    expect(await purgeText('item-blog')).toBe(
      'Deletes Blog migration. It also deletes 1 item deleted from the project earlier. This cannot be undone.',
    )
    // a capped list may not hold them all, and a stuck row no longer says what it waits for
    await deliver([empty, task(1, { can_purge: true })], true)
    const unsure =
      'Deletes Field trial Q3. It also deletes any items deleted from the project earlier. This cannot be undone.'
    expect(await purgeText('item-trial')).toBe(unsure)
    expect(await purgeText('item-1')).toBe(
      'Deletes QN-1 Task 1 and its comments and attachments. This cannot be undone.',
    )
    await deliver([empty, task(8, { state: 'stuck', can_restore: false, can_purge: true })])
    expect(await purgeText('item-trial')).toBe(unsure)
    await deliver([empty, task(1, { can_purge: true })])
    expect(await purgeText('item-trial')).toBe('Deletes Field trial Q3. This cannot be undone.')
  })
})

describe('searching inside deleted projects', () => {
  it('shows a task found in a deleted project, which restores with its project', async () => {
    await open()
    answers['deletedItems:restore'] = async (args) => ({
      restored: args.ids as string[],
      refused: [],
      deferred: [],
    })
    await deliver([trial(), task(1)])
    await search('Book')
    expect(searches).toEqual([])
    await pause()
    expect(searches.map((s) => s.text)).toEqual(['Book'])
    await act(async () => searches[0].next([hit(), hit({ key: 'QN-99', item_id: 'gone' })]))
    await settle()
    const match = find('[data-deleted-match="QN-12"]')
    expect(text('[data-deleted-match="QN-12"] [data-row-place]')).toBe(
      'Field trial Q3 › Site preparation, deleted with the project',
    )
    expect(text('[data-deleted-match="QN-12"] [data-row-who]')).toBe('Mira Holm')
    // a hit whose project item is not in the list is dropped
    expect(has('[data-deleted-match="QN-99"]')).toBe(false)
    expect(text('[data-deleted-count]')).toBe('1 of 2 items')
    await click(match.querySelector<HTMLElement>('[data-restore]') as HTMLElement)
    expect(text('[data-modal-shell] h2')).toBe('QN-12 is in a deleted project')
    expect(text('[data-project-first]')).toBe(
      'QN-12 was deleted together with its project Field trial Q3. It can only come back with the project.Field trial Q3 comes back with its 2 sub-projects and all 48 tasks, 9 of them archived. They keep their keys.',
    )
    await click(button('Restore Field trial Q3 and QN-12'))
    expect(calls('deletedItems:restore')).toEqual([{ org_id: ORG, ids: ['item-trial'] }])
    expect(window.showToast).toHaveBeenCalledWith('Restored “Field trial Q3”', undefined)
  })

  it('drops a stale answer, and offers only Close when the project cannot come back', async () => {
    await open()
    await deliver([
      trial({
        can_restore: false,
        blocked: { reason: 'not_lead', project: 'Field trial Q3', lead: 'Mira Holm' },
      }),
    ])
    await search('Boo')
    await pause()
    // a new text stops following the old one at once
    await search('Book')
    expect(searches[0].live).toBe(false)
    await pause()
    expect(searches.map((s) => s.text)).toEqual(['Boo', 'Book'])
    await act(async () => searches[1].next([hit({ can_restore: false })]))
    // a late answer for the older text, with a hit the newer text no longer finds
    await act(async () => searches[0].next([hit({ key: 'QN-13', title: 'Boots' })]))
    await settle()
    expect(has('[data-deleted-match="QN-13"]')).toBe(false)
    expect(find('[data-deleted-match="QN-12"] [data-select]').hasAttribute('disabled')).toBe(true)
    await click(find('[data-deleted-match="QN-12"] [data-restore]'))
    expect(text('[data-project-first]')).toContain(
      'Field trial Q3 has its own lead, Mira Holm. Ask them or an organization admin to restore it.',
    )
    expect(
      buttons()
        .filter((b) => b.closest('[data-modal-shell]'))
        .map((b) => b.textContent),
    ).toEqual(['', 'Close'])
    await click(button('Close'))
    expect(calls('deletedItems:restore')).toEqual([])
  })

  it('restores what only the list narrowed to one person holds', async () => {
    await open()
    answers['deletedItems:restore'] = async (args) => ({
      restored: args.ids as string[],
      refused: [],
      deferred: [],
    })
    // the capped list holds none of Mira's older deletes
    await deliver([task(1, { deleter: MIRA }), task(2)], true)
    const select = find<HTMLSelectElement>('[data-deleted-by]')
    await act(async () => {
      select.value = [...select.options].find((o) => o.text === 'Mira Holm')?.value ?? ''
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const narrowed = lists.find((l) => l.live && l.args.deleted_by === 'mira')
    const early = task(5, {
      deleter: MIRA,
      deleted_at: at(9, 0, 0, 14),
      can_restore: false,
      blocked: { reason: 'project_deleted', item_id: 'item-trial' },
    })
    await act(async () =>
      narrowed?.next({ items: [task(1, { deleter: MIRA }), trial(), early], capped: false }),
    )
    await settle()
    expect(text('[data-deleted-row="item-5"] [data-row-note="blocked"]')).toBe(
      'Its project, Field trial Q3, is in Deleted items too.',
    )
    await search('Book')
    await pause()
    await act(async () => searches[0].next([hit()]))
    await settle()
    await click(find('[data-deleted-match="QN-12"] [data-restore]'))
    expect(text('[data-project-first]')).toContain(
      'Field trial Q3 comes back with its 2 sub-projects and all 48 tasks',
    )
    await click(button('Restore Field trial Q3 and QN-12'))
    expect(calls('deletedItems:restore')).toEqual([{ org_id: ORG, ids: ['item-trial'] }])
  })

  it('clears the search on Escape before Settings sees the key', async () => {
    await open()
    const settings = vi.fn()
    window.addEventListener('keydown', settings)
    await deliver([task(1)])
    await search('QN')
    const input = find<HTMLInputElement>('[data-deleted-search]')
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(input.value).toBe('')
    expect(settings).not.toHaveBeenCalled()
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(settings).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', settings)
  })
})

/* ------------------------------------------------ review fixes (gate) */

describe('a restore the server refuses in part', () => {
  for (const order of ['before', 'after'] as const)
    it(`keeps the refused row selected when the list arrives ${order} the answer`, async () => {
      await open()
      await deliver([task(1), task(2), task(3)])
      const blocked = task(2, {
        can_restore: false,
        blocked: { reason: 'project_archived', project: 'Docs' },
      })
      answers['deletedItems:restore'] = async () => {
        // Convex delivers the list that follows a mutation before its answer
        if (order === 'before') push([blocked])
        return {
          restored: ['item-1', 'item-3'],
          refused: [{ id: 'item-2', reason: 'project_archived' }],
          deferred: [],
        }
      }
      await click(find('[data-select-all]'))
      await click(find('.deleted-selection-actions [data-restore-selected]'))
      await click(button('Restore 3 tasks'))
      if (order === 'after') await deliver([blocked])
      expect(window.showToast).toHaveBeenCalledWith(
        "Restored 2 of 3 tasks. 1 couldn't be restored.",
        'error',
      )
      expect(text('[data-deleted-count]')).toBe('1 selected')
      expect(checkbox('item-2').getAttribute('data-state')).toBe('checked')
      expect(text('[data-deleted-row="item-2"] [data-row-note="blocked"]')).toBe(
        'Restore Docs from Archived projects first.',
      )
      // nothing selected can come back now, and the row's box still clears it
      expect(find<HTMLButtonElement>('[data-restore-selected]').disabled).toBe(true)
      await click(checkbox('item-2'))
      expect(text('[data-deleted-count]')).toBe('1 item')
      expect(checkbox('item-2').disabled).toBe(true)
    })
})

describe('restoring the selection', () => {
  it('sends one call per organization', async () => {
    await open()
    answers['deletedItems:restore'] = async (args) => ({
      restored: args.ids as string[],
      refused: [],
      deferred: [],
    })
    const other = { org_id: 'org-other', org_name: 'Aurora Studio' }
    await deliver([task(1), task(2, { ...other, deleted_at: at(14, 30) }), task(3)])
    await click(find('[data-select-all]'))
    await click(find('.deleted-selection-actions [data-restore-selected]'))
    await click(button('Restore 3 tasks'))
    const sent = calls('deletedItems:restore')
      .map((a) => ({ org: a.org_id, ids: [...(a.ids as string[])].sort() }))
      .sort((a, b) => String(a.org).localeCompare(String(b.org)))
    expect(sent).toEqual(
      [
        { org: ORG, ids: ['item-1', 'item-3'] },
        { org: 'org-other', ids: ['item-2'] },
      ].sort((a, b) => a.org.localeCompare(b.org)),
    )
    expect(window.showToast).toHaveBeenCalledWith('Restored 3 tasks', undefined)
  })

  it('gives focus back to Restore N selected when its window is cancelled', async () => {
    await open()
    await deliver([task(1), task(2)])
    await click(find('[data-select-all]'))
    const opener = find<HTMLButtonElement>('.deleted-selection-actions [data-restore-selected]')
    opener.focus()
    await click(opener)
    expect(text('[data-modal-shell] h2')).toBe('Restore 2 tasks?')
    await click(button('Cancel'))
    expect(has('[data-modal-shell]')).toBe(false)
    expect(document.activeElement).toBe(find('.deleted-selection-actions [data-restore-selected]'))
    expect(text('[data-deleted-count]')).toBe('2 selected')
  })

  it('keeps the selection inside the filter', async () => {
    await open()
    await deliver([task(1), task(2), trial()])
    await click(find('[data-select-all]'))
    expect(text('[data-deleted-count]')).toBe('3 selected')
    await click(button('Projects'))
    expect(rowIds()).toEqual(['item-trial'])
    expect(text('[data-deleted-count]')).toBe('1 selected')
    expect(text('[data-restore-selected]')).toBe('Restore 1 selected')
    // the tasks the filter hid did not come back selected with it
    await click(button('All'))
    expect(text('[data-deleted-count]')).toBe('1 selected')
    expect(checkbox('item-1').getAttribute('data-state')).toBe('unchecked')
  })
})

describe('windows that wait for the server', () => {
  it('keep the bulk restore and Delete now windows open while they wait', async () => {
    await open()
    let restored: (answer: Answer) => void = () => {}
    let purged: (answer: Answer) => void = () => {}
    answers['deletedItems:restore'] = () => new Promise((resolve) => (restored = resolve))
    answers['deletedItems:purge'] = () => new Promise((resolve) => (purged = resolve))
    await deliver([task(1, { can_purge: true }), task(2, { can_purge: true })])
    const close = () => find('[data-modal-shell] button[aria-label="Close"]')

    await click(find('[data-select-all]'))
    await click(find('.deleted-selection-actions [data-restore-selected]'))
    await click(button('Restore 2 tasks'))
    expect(button('Restoring…').disabled).toBe(true)
    await click(button('Cancel'))
    await click(close())
    expect(has('[data-bulk-restore]')).toBe(true)
    await act(async () => restored({ restored: ['item-1', 'item-2'], refused: [], deferred: [] }))
    await settle()
    expect(has('[data-bulk-restore]')).toBe(false)

    // a window that waits for nothing closes at once
    await click(find('[data-deleted-row="item-1"] [data-row-menu]'))
    await click(find('[data-delete-now]'))
    await click(button('Cancel'))
    expect(has('[data-purge]')).toBe(false)
    await click(find('[data-deleted-row="item-1"] [data-row-menu]'))
    await click(find('[data-delete-now]'))
    await click(button('Delete for good'))
    expect(button('Deleting…').disabled).toBe(true)
    await click(button('Cancel'))
    await click(close())
    expect(has('[data-purge]')).toBe(true)
    await act(async () => purged({ purged: ['item-1'], refused: [] }))
    await settle()
    expect(has('[data-purge]')).toBe(false)
  })

  it('says Restoring while a project comes back in steps', async () => {
    await open()
    answers['deletedItems:restore'] = async (args) => {
      push([trial({ state: 'restoring', can_restore: false })])
      return { restored: args.ids as string[], refused: [], deferred: [] }
    }
    await deliver([trial()])
    await click(find('[data-deleted-row="item-trial"] [data-restore]'))
    expect(window.showToast).toHaveBeenCalledWith('Restoring “Field trial Q3”…', undefined)
    expect(window.showToast).not.toHaveBeenCalledWith('Restored “Field trial Q3”', undefined)
    expect(text('[data-deleted-row="item-trial"] [data-row-note="state"]')).toBe('Restoring…')
    expect(has('[data-deleted-row="item-trial"] [data-restore]')).toBe(false)
  })

  it('opens the project window for a sub-project whose project is deleted too', async () => {
    await open()
    const website = task(0, {
      id: 'item-web',
      kind: 'project',
      title: 'Website',
      status: undefined,
      path: [],
      counts: { tasks: 30, archived_tasks: 0, subtasks: 0, sub_projects: 1 },
      deleted_at: at(10, 0),
    })
    const blog = task(0, {
      id: 'item-blog',
      kind: 'project',
      title: 'Blog migration',
      status: undefined,
      path: ['Website'],
      counts: { tasks: 12, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
      deleted_at: at(9, 0, 0, 14),
      can_restore: false,
      blocked: { reason: 'parent_deleted', item_id: 'item-web' },
    })
    const archivedParent = task(0, {
      id: 'item-docs',
      kind: 'project',
      title: 'API docs',
      status: undefined,
      path: ['Developer portal'],
      deleted_at: at(8, 0, 0, 14),
      can_restore: false,
      blocked: { reason: 'parent_archived', project: 'Developer portal' },
    })
    await deliver([website, blog, archivedParent])
    expect(text('[data-deleted-row="item-blog"] [data-row-note="blocked"]')).toBe(
      'Its project, Website, is in Deleted items too.',
    )
    // a sub-project whose project is archived has no Restore
    expect(has('[data-deleted-row="item-docs"] [data-restore]')).toBe(false)
    await click(find('[data-deleted-row="item-blog"] [data-restore]'))
    expect(text('[data-modal-shell] h2')).toBe('Blog migration is in a deleted project')
    expect(calls('deletedItems:restore')).toEqual([])
  })
})

describe('search hits follow the list', () => {
  it('shows the live state of the project item a hit belongs to', async () => {
    await open()
    await deliver([trial({ state: 'moving', can_restore: false })])
    await found('Book', [hit({ state: 'moving', can_restore: false })])
    expect(text('[data-deleted-match="QN-12"] [data-row-note="state"]')).toBe(
      'Moving to Deleted items…',
    )
    expect(has('[data-deleted-match="QN-12"] [data-restore]')).toBe(false)
    // the list shows the project item ready before the search answers again
    await deliver([trial()])
    expect(has('[data-deleted-match="QN-12"] [data-row-note="state"]')).toBe(false)
    expect(has('[data-deleted-match="QN-12"] [data-restore]')).toBe(true)
    // and it starts restoring in steps, from its own row or another tab
    await deliver([trial({ state: 'restoring', can_restore: false })])
    expect(text('[data-deleted-match="QN-12"] [data-row-note="state"]')).toBe('Restoring…')
    expect(has('[data-deleted-match="QN-12"] [data-restore]')).toBe(false)
  })

  it('asks before a project ticked through a hit comes back, and restores a task at once', async () => {
    await open()
    answers['deletedItems:restore'] = async (args) => ({
      restored: args.ids as string[],
      refused: [],
      deferred: [],
    })
    await deliver([trial(), task(1)])
    await found('Book', [hit()])
    await click(find('[data-deleted-match="QN-12"] [data-select]'))
    expect(text('[data-deleted-count]')).toBe('1 selected')
    const opener = find<HTMLButtonElement>('.deleted-selection-actions [data-restore-selected]')
    opener.focus()
    await click(opener)
    expect(calls('deletedItems:restore')).toEqual([])
    expect(text('[data-modal-shell] h2')).toBe('QN-12 is in a deleted project')
    await click(button('Cancel'))
    expect(document.activeElement).toBe(find('.deleted-selection-actions [data-restore-selected]'))
    await click(find('.deleted-selection-actions [data-restore-selected]'))
    await click(button('Restore Field trial Q3 and QN-12'))
    expect(calls('deletedItems:restore')).toEqual([{ org_id: ORG, ids: ['item-trial'] }])

    // a task ticked on its own row needs no window
    await search('')
    await deliver([task(1)])
    await click(checkbox('item-1'))
    await click(find('.deleted-selection-actions [data-restore-selected]'))
    expect(has('[data-modal-shell]')).toBe(false)
    expect(calls('deletedItems:restore')).toEqual([
      { org_id: ORG, ids: ['item-trial'] },
      { org_id: ORG, ids: ['item-1'] },
    ])
  })

  it('follows new answers while the text stays, and keeps the hits until one arrives', async () => {
    await open()
    const website = (patch: Partial<DeletedRow> = {}) =>
      trial({
        id: 'item-web',
        key: 'WEB',
        title: 'Website',
        deleter: DANIEL,
        deleted_at: at(14, 30),
        ...patch,
      })
    await deliver([trial({ state: 'moving', can_restore: false })])
    await found('Book', [])
    // the project finishes moving, and the search answers again with its tasks
    await deliver([trial()])
    await pause()
    await act(async () => searches[0].next([hit()]))
    await settle()
    expect(has('[data-deleted-match="QN-12"]')).toBe(true)
    // another project arrives and finishes moving; the hits stay meanwhile
    await deliver([website({ state: 'moving', can_restore: false }), trial()])
    await deliver([website(), trial()])
    await pause()
    expect(has('[data-deleted-match="QN-12"]')).toBe(true)
    const photographer = hit({
      item_id: 'item-web',
      key: 'QN-40',
      title: 'Book a photographer',
      path: ['Website', 'Website'],
      deleted_at: at(14, 30),
      deleter: DANIEL,
    })
    await act(async () => searches[0].next([hit(), photographer]))
    await settle()
    expect(has('[data-deleted-match="QN-12"]')).toBe(true)
    expect(has('[data-deleted-match="QN-40"]')).toBe(true)
    // one subscription answered all of it
    expect(searches.map((s) => [s.text, s.live])).toEqual([['Book', true]])
  })

  it('shows a hit outside a capped list as ready once a new answer says so', async () => {
    await open()
    // the capped list ends before the project item that the search finds
    await deliver([task(1)], true)
    await found('Book', [hit({ state: 'moving', can_restore: false })])
    expect(text('[data-deleted-match="QN-12"] [data-row-note="state"]')).toBe(
      'Moving to Deleted items…',
    )
    expect(has('[data-deleted-match="QN-12"] [data-restore]')).toBe(false)
    // the project finishes moving; no list holds it, but the search answers again
    await act(async () => searches[0].next([hit()]))
    await settle()
    expect(has('[data-deleted-match="QN-12"] [data-row-note="state"]')).toBe(false)
    expect(has('[data-deleted-match="QN-12"] [data-restore]')).toBe(true)
  })

  it('keeps the hits when the search fails, and stops following it on unmount', async () => {
    await open()
    await deliver([trial()])
    await found('Book', [hit()])
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => searches[0].fail(new Error('offline')))
    await settle()
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
    expect(has('[data-deleted-match="QN-12"]')).toBe(true)
    expect(has('[role="alert"]')).toBe(false)
    // the page goes on with the list
    await deliver([trial(), task(1, { title: 'Book a van' })])
    expect(rowIds()).toEqual(['item-1', 'item-trial:QN-12'])
    await act(async () => root.unmount())
    root = createRoot(container)
    expect(searches.map((s) => s.live)).toEqual([false])
  })

  it('drops hits the new text does not hold before its answer, and counts each item once', async () => {
    await open()
    await deliver([trial()])
    await found('Boo', [
      hit(),
      hit({ key: 'QN-13', title: 'Boots for the field team' }),
      hit({ key: 'QN-14', title: 'Book a van' }),
    ])
    // three hits in one project item are one item
    expect(text('[data-deleted-count]')).toBe('1 of 1 item')
    // a longer text keeps the hits that still hold it while its answer is on the way
    await search('Book')
    expect(has('[data-deleted-match="QN-12"]')).toBe(true)
    expect(has('[data-deleted-match="QN-14"]')).toBe(true)
    expect(has('[data-deleted-match="QN-13"]')).toBe(false)
    await search('Zebra')
    expect(has('[data-deleted-match="QN-12"]')).toBe(false)
    expect(text('[data-deleted-items]')).toContain('No deleted items match the filter.')
    expect(text('[data-deleted-count]')).toBe('0 of 1 item')
  })

  it('shows and restores a hit whose project item a capped list stops before', async () => {
    await open()
    answers['deletedItems:restore'] = async (args) => ({
      restored: args.ids as string[],
      refused: [],
      deferred: [],
    })
    // the capped list ends before the older project item that the search finds
    await deliver([task(1, { title: 'Book a van' })], true)
    await found('Book', [hit()])
    expect(rowIds()).toEqual(['item-1', 'item-trial:QN-12'])
    expect(text('[data-deleted-match="QN-12"] [data-row-place]')).toBe(
      'Field trial Q3 › Site preparation, deleted with the project',
    )
    expect(text('[data-deleted-match="QN-12"] [data-row-who]')).toBe('Mira Holm')
    expect(text('[data-deleted-count]')).toBe('2 of 2 items')
    // the hit says where its task sat, but not the name or size of its project
    await click(find('[data-select-all]'))
    await click(find('.deleted-selection-actions [data-restore-selected]'))
    expect(text('[data-modal-shell] h2')).toBe('Restore 2 items?')
    expect(
      [...document.querySelectorAll('[data-destination]')].map((el) => el.textContent),
    ).toEqual([
      'Field trial Q3 › Site preparationproject with QN-12',
      'Luma Sensor › Firmware1 task',
    ])
    await click(button('Cancel'))
    await click(button('Clear'))
    await click(find('[data-deleted-match="QN-12"] [data-restore]'))
    expect(text('[data-modal-shell] h2')).toBe('QN-12 is in a deleted project')
    expect(text('[data-project-first]')).toBe(
      'QN-12 was deleted together with its project. It can only come back with the project.The project comes back with all its tasks. They keep their keys.',
    )
    await click(button('Restore the project and QN-12'))
    expect(calls('deletedItems:restore')).toEqual([{ org_id: ORG, ids: ['item-trial'] }])
    expect(window.showToast).toHaveBeenCalledWith('Restored QN-12 and its project', undefined)
    // no list will drop the restored project item, so its hit goes now
    expect(rowIds()).toEqual(['item-1'])
  })

  it('shows hits when the capped list holds no row at all', async () => {
    await open()
    await deliver([], true)
    expect(text('[data-deleted-items]')).toContain('No deleted items.')
    await found('Book', [hit()])
    expect(rowIds()).toEqual(['item-trial:QN-12'])
    expect(text('[data-deleted-count]')).toBe('1 of 1 item')
  })

  it('shows a hit under an organization that the capped list stopped before', async () => {
    await open()
    await deliver([task(1), task(2, { org_id: 'org-two', org_name: 'Aurora Studio' })], true)
    await found('Book', [
      hit({ org_id: 'org-three', org_name: 'Polar Works' }),
      taskHit({ title: 'Book the calibration lab', org_id: 'org-four', org_name: 'Nordic Works' }),
    ])
    const groups = [...document.querySelectorAll<HTMLElement>('[data-org-group]')]
    expect(groups.map((el) => el.dataset.orgGroup)).toEqual(['org-four', 'org-three'])
    expect(groups.map((g) => g.firstElementChild?.textContent)).toEqual([
      'Nordic Works',
      'Polar Works',
    ])
    expect(groups[0].querySelector('[data-deleted-row="item-old"]')).not.toBeNull()
    expect(groups[1].querySelector('[data-deleted-match="QN-12"]')).not.toBeNull()
  })
})

describe('task items the search finds', () => {
  const restoresAll = () => {
    answers['deletedItems:restore'] = async (args) => ({
      restored: args.ids as string[],
      refused: [],
      deferred: [],
    })
  }

  it('restores a task item that a capped list leaves out from its own row', async () => {
    await open()
    restoresAll()
    // the capped list ends before the older task item
    await deliver([task(1), trial()], true)
    expect(has('[data-deleted-row="item-old"]')).toBe(false)
    await found('QN-77', [taskHit()])
    // an ordinary task row, not a task inside a deleted project
    expect(rowIds()).toEqual(['item-old'])
    expect(has('[data-deleted-match]')).toBe(false)
    expect(rowOf('item-old').textContent).toContain('QN-77Calibrate the humidity sensor')
    expect(text('[data-deleted-row="item-old"] [data-row-place]')).toBe('Luma Sensor › Firmware')
    expect(text('[data-deleted-row="item-old"] [data-row-who]')).toBe('Daniel Berg')
    expect(text('[data-deleted-count]')).toBe('1 of 3 items')
    await click(find('[data-select-all]'))
    expect(checkbox('item-old').getAttribute('data-state')).toBe('checked')
    expect(text('[data-deleted-count]')).toBe('1 selected')
    await click(find('[data-clear-selection]'))
    const restore = find<HTMLButtonElement>('[data-deleted-row="item-old"] [data-restore]')
    restore.focus()
    await click(restore)
    // it comes back at once, without the project window
    expect(calls('deletedItems:restore')).toEqual([{ org_id: ORG, ids: ['item-old'] }])
    expect(window.showToast).toHaveBeenCalledWith('Restored QN-77', undefined)
    // no list will drop it, so its row goes now, and focus with it to the search box
    expect(has('[data-deleted-row="item-old"]')).toBe(false)
    expect(document.activeElement).toBe(find('[data-deleted-search]'))
  })

  it('shows a task item the list holds once, also when the text is in its subtask', async () => {
    await open()
    const parent = task(30, {
      title: 'Ship the firmware',
      counts: { tasks: 3, archived_tasks: 0, subtasks: 2, sub_projects: 0 },
    })
    const ofParent = (key: string, title: string) =>
      taskHit({ item_id: 'item-30', key, title, deleted_at: parent.deleted_at })
    await deliver([parent, task(1)])
    // the root by key, and a subtask of the same item by title
    await found('QN-3', [ofParent('QN-30', 'Ship the firmware'), ofParent('QN-31', 'QN-3 notes')])
    expect(rowIds()).toEqual(['item-30'])
    expect(text('[data-deleted-count]')).toBe('1 of 2 items')
    // the list row's title does not hold the text, its subtask does
    await found('Sign', [ofParent('QN-31', 'Sign the image')])
    expect(rowIds()).toEqual(['item-30'])
    expect(rowOf('item-30').textContent).toContain('QN-30Ship the firmwareand 2 subtasks')
    expect(has('[data-deleted-match]')).toBe(false)
  })

  it('shows a redacted task item the search finds as the redacted row', async () => {
    await open('lead')
    await deliver([task(1, { deleter: ME })], true)
    await found('Sign', [
      taskHit({
        key: 'QN-31',
        title: 'Sign the image',
        path: [],
        redacted: true,
        can_restore: false,
        blocked: { reason: 'no_access' },
      }),
    ])
    expect(rowIds()).toEqual(['item-old'])
    // the task the person can see, and nothing of the root or its project
    expect(rowOf('item-old').textContent).toContain('QN-31Sign the image')
    expect(text('[data-deleted-row="item-old"] [data-row-place]')).toBe(
      "Deleted with a task in a project you can't open",
    )
    expect(has('[data-deleted-row="item-old"] [data-row-notes]')).toBe(false)
    expect(has('[data-deleted-row="item-old"] [data-restore]')).toBe(false)
    expect(checkbox('item-old').disabled).toBe(true)
    await click(checkbox('item-old'))
    expect(find<HTMLButtonElement>('[data-select-all]').disabled).toBe(true)
    expect(text('[data-deleted-count]')).toBe('1 of 2 items')
  })

  it('restores found task items with the selection, and still asks before a project hit', async () => {
    await open()
    restoresAll()
    await deliver([task(1, { title: 'Calibrate the light sensor' }), trial()], true)
    await found('Calibrate', [taskHit(), hit({ title: 'Calibrate the field kit' })])
    expect(rowIds()).toEqual(['item-1', 'item-trial:QN-12', 'item-old'])
    await click(find('[data-select-all]'))
    expect(text('[data-deleted-count]')).toBe('3 selected')
    await click(find('.deleted-selection-actions [data-restore-selected]'))
    expect(text('[data-modal-shell] h2')).toBe('Restore 3 items?')
    // the found task goes back with the listed one in the same project
    expect(
      [...document.querySelectorAll('[data-destination]')].map((el) => el.textContent),
    ).toEqual([
      'Field trial Q3project with 2 sub-projects and 48 tasks',
      'Luma Sensor › Firmware2 tasks',
    ])
    await click(button('Cancel'))
    await click(button('Clear'))
    // the task inside the deleted project still comes back only with it
    await click(find('[data-deleted-match="QN-12"] [data-restore]'))
    expect(text('[data-modal-shell] h2')).toBe('QN-12 is in a deleted project')
    await click(button('Restore Field trial Q3 and QN-12'))
    expect(calls('deletedItems:restore')).toEqual([{ org_id: ORG, ids: ['item-trial'] }])
  })

  it('sends a found task item that waits for its project once the search shows it restorable', async () => {
    await open()
    // the server defers the task while its project comes back in the same call
    answers['deletedItems:restore'] = async (args) => {
      const ids = args.ids as string[]
      const waits = (id: string) => id === 'item-old' && ids.includes('item-trial')
      return {
        restored: ids.filter((id) => !waits(id)),
        refused: [],
        deferred: ids.filter(waits),
      }
    }
    // the capped list holds the project, but not the older task deleted before it
    await deliver([trial()], true)
    const waits = { reason: 'project_deleted' as const, item_id: 'item-trial' }
    await found('QN-77', [taskHit({ can_restore: false, blocked: waits })])
    expect(text('[data-deleted-row="item-old"] [data-row-note="blocked"]')).toBe(
      'Its project, Field trial Q3, is in Deleted items too.',
    )
    await click(find('[data-deleted-row="item-old"] [data-restore]'))
    expect(text('[data-modal-shell] h2')).toBe('QN-77 is in a deleted project')
    await click(button('Restore Field trial Q3 and QN-77'))
    expect(calls('deletedItems:restore')).toEqual([
      { org_id: ORG, ids: ['item-trial', 'item-old'] },
    ])
    // the project is back, and the search answers again
    await deliver([], true)
    await act(async () => searches[0].next([taskHit()]))
    await settle()
    expect(calls('deletedItems:restore')).toEqual([
      { org_id: ORG, ids: ['item-trial', 'item-old'] },
      { org_id: ORG, ids: ['item-old'] },
    ])
  })

  it('folds found task items into a run of the same who', async () => {
    await open()
    const listed = burst(8)
    // four older tasks of the same run that the capped list stops before
    const older = [108, 109, 110, 111].map((num, i) =>
      taskHit({
        item_id: `item-${num}`,
        key: `QN-${num}`,
        title: `Task ${num}`,
        deleter: CURSOR,
        deleted_at: new Date(Date.parse(at(14, 5)) - (8 + i) * 20_000).toISOString(),
      }),
    )
    await deliver(listed, true)
    await found('Task', older)
    expect(rowIds()).toEqual(listed.slice(0, 7).map((r) => r.id))
    expect(text('[data-fold]')).toContain(
      'and 5 more tasks Daniel Berg deleted via Cursor, today 14:01 to 14:02',
    )
    expect(text('[data-deleted-count]')).toBe('12 of 12 items')
    await click(find('[data-select-run]'))
    expect(text('[data-deleted-count]')).toBe('12 selected')
    await click(find('[data-show-all]'))
    expect(rowIds()).toEqual([...listed.map((r) => r.id), ...older.map((m) => m.item_id)])
  })
})
