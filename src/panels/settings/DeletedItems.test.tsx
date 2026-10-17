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

type Answer = { restored?: string[]; purged?: string[]; refused?: { id: string; reason: string }[] }
type Subscription = {
  args: { deleted_by?: string }
  next: (value: unknown) => void
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
let searches: { text: string; resolve: (rows: DeletedMatch[]) => void }[]

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
/** `n` tasks Daniel deleted with Cursor, 20 seconds apart from 14:05 down. */
const burst = (n: number, from = 100) =>
  Array.from({ length: n }, (_, i) =>
    task(from + i, {
      deleter: CURSOR,
      deleted_at: new Date(Date.parse(at(14, 5)) - i * 20_000).toISOString(),
    }),
  )

function fixture(role: 'admin' | 'lead' | 'user') {
  const next = plannerFixture()
  const me = next.profiles[0]
  if (role !== 'admin') me.org_role = 'user'
  if (role === 'lead') next.projects[0].lead_id = me.id
  return next
}

async function load(role: 'admin' | 'lead' | 'user' = 'admin') {
  vi.resetModules()
  snap = fixture(role)
  ORG = snap.orgs[0].id
  lists = []
  answers = {}
  searches = []
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'snapshot:forMe') next(structuredClone(snap))
    if (name !== 'deletedItems:list') return () => {}
    const subscription: Subscription = { args, next, fail, live: true }
    lists.push(subscription)
    return () => {
      subscription.live = false
    }
  })
  network.query.mockImplementation((ref, args) => {
    if (getFunctionName(ref) !== 'deletedItems:matches') return Promise.resolve(null)
    return new Promise((resolve) => searches.push({ text: args.text, resolve }))
  })
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
async function open(role: 'admin' | 'lead' | 'user' = 'admin') {
  await load(role)
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
    await deliver([task(1)])
    expect(text('.settings-page-title')).toContain('Tasks and projects you deleted.')
    expect(text('.settings-page-title')).not.toContain('organization')
    expect(has('[data-deleted-by]')).toBe(false)
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
    expect(text('[data-deleted-items]')).toContain('Showing the newest 2,000 items.')
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
        can_restore: false,
        blocked: { reason: 'no_access' },
      }),
      task(8),
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
    // someone archived the project of item-2: it leaves the selection
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
    // the project is back: the item is restorable now and goes on its own
    await deliver([{ ...early, can_restore: true, blocked: undefined }])
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
})

describe('Deleted by', () => {
  it('filters on the page, and asks the server for one person when the list is capped', async () => {
    await open()
    await deliver([task(1, { deleter: CURSOR }), task(2, { deleter: MIRA }), task(3)])
    const select = find<HTMLSelectElement>('[data-deleted-by]')
    expect([...select.options].map((o) => o.text)).toEqual([
      'Deleted by anyone',
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
})

describe('searching inside deleted projects', () => {
  const hit = (patch: Partial<DeletedMatch> = {}): DeletedMatch => ({
    item_id: 'item-trial',
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
    await act(async () => searches[0].resolve([hit(), hit({ key: 'QN-99', item_id: 'gone' })]))
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
    await search('Book')
    await pause()
    expect(searches.map((s) => s.text)).toEqual(['Boo', 'Book'])
    await act(async () => searches[1].resolve([hit({ can_restore: false })]))
    // the older search answers last, with a hit the newer text no longer finds
    await act(async () => searches[0].resolve([hit({ key: 'QN-13', title: 'Boots' })]))
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
