// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../../components/ui/tooltip'
import {
  answerLabelPages,
  type ForcedLabelPage,
  labelPickerStandIn,
} from '../../store/labelPagesStandIn.setup'
import { plannerFixture, type Snapshot } from '../../store/plannerFixture.setup'

/* Settings › Labels on the real store, its batches answered by the label
   pages' stand-in (store/labelPagesStandIn.setup.ts) over a workspace the
   test holds as the server's, which it can change and answer again as
   Convex reruns the open reads. I am the admin of Testbed Labs. */

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
type Read = {
  args: unknown
  next: (value: unknown) => void
  fail?: (error: unknown) => void
}

let page: typeof import('./LabelsSettings')
let version: typeof import('../../store/usePlannerVersion')
let requests: Pending[]
let toast: ReturnType<typeof vi.fn<(message: string, tone?: string) => void>>
let container: HTMLDivElement
let root: Root
/* What the server holds: its workspace, the states it is asked to force,
   the label reads open on it, the way to publish its workspace, and
   whether it holds back a new read's answer until the next rerun. */
let server: {
  snap: Snapshot
  force: ForcedLabelPage
  reads: Set<Read>
  publish: (snap: Snapshot) => void
  hold: boolean
  /** New label's checks of a typed name (labels.picker), each search, and
      whether they fail */
  checks: string[]
  checkFails: boolean
}

const org = () => server.snap.orgs[0].id

/** A label of my organization, named `name`. */
const labelRow = (snap: Snapshot, id: string, name: string, color = '#335577') => {
  snap.labels.push({
    id,
    org_id: snap.orgs[0].id,
    name,
    name_lower: name.toLowerCase(),
    color,
    created_at: NOW,
  })
}

/** Labels `Label 00` to `Label <n-1>`, ids `l00` on. */
const many = (n: number) => (snap: Snapshot) => {
  for (let i = 0; i < n; i++)
    labelRow(snap, `l${String(i).padStart(2, '0')}`, `Label ${String(i).padStart(2, '0')}`)
}

/** Loads the store from the fixture, which `shape` changes first. */
async function load(shape?: (snap: Snapshot) => void) {
  vi.resetModules()
  const snap = plannerFixture()
  snap.issues.push({
    id: 'task',
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
    num: 4,
    title: 'Calibrate the sensor',
    description: '',
    status: 'progress',
    priority: 'medium',
    paused: false,
    created_at: NOW,
    updated_at: NOW,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  shape?.(snap)
  requests = []
  server = {
    snap,
    force: {},
    reads: new Set(),
    publish: () => {},
    hold: false,
    checks: [],
    checkFails: false,
  }
  network.query.mockImplementation(async (ref, args) => {
    // New label's check of the typed name, one read, never subscribed
    if (getFunctionName(ref) !== 'labels:picker') return null
    server.checks.push(String(args.search ?? ''))
    if (server.checkFails) throw new Error('the check failed')
    return labelPickerStandIn(server.snap, args, { force: server.force })
  })
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'labels:settingsPage') {
      const read: Read = { args, next, fail }
      server.reads.add(read)
      if (!server.hold) answerLabelPages(server.snap, args, next, fail, { force: server.force })
      return () => server.reads.delete(read)
    }
    if (name === 'workspace:whole')
      server.publish = (value) => {
        server.snap = value
        next(structuredClone(value))
      }
    next(structuredClone(server.snap))
    return () => {}
  })
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'identity:claimMySeats') return Promise.resolve(null)
    return new Promise((resolve, reject) => requests.push({ name, args, resolve, reject }))
  })
  const store = await import('../../store/planner')
  await store.initStore()
  page = await import('./LabelsSettings')
  version = await import('../../store/usePlannerVersion')
}

/** Answers every open label read again from the server's workspace, as
    Convex reruns a query whose reads changed. */
const rerun = () =>
  act(async () => {
    for (const read of server.reads)
      answerLabelPages(server.snap, read.args, read.next, read.fail, { force: server.force })
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })

/** Lets the page take every answer on its way. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })

/** Lets timers due now run, as a closing window gives focus back in one. */
const tick = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

/** Publishes the server's workspace with `edit` applied, as another
    session's write reaches every client, and reruns the label reads. */
async function elsewhere(edit: (snap: Snapshot) => void) {
  const next = structuredClone(server.snap)
  edit(next)
  next.delivered_at = '2026-09-15T09:00:00.000Z'
  await act(async () => server.publish(next))
  await rerun()
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
})

/* Re-renders on every store change, as the app's shell does. */
function Live() {
  version.usePlannerVersion()
  return <page.OrgLabelsPage />
}

async function render() {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Live />
      </TooltipProvider>,
    ),
  )
  await settle()
}

const find = <E extends Element = HTMLElement>(selector: string) => {
  const el = document.querySelector<E>(selector)
  if (!el) throw new Error(`no ${selector}`)
  return el
}
const rows = () =>
  [...document.querySelectorAll<HTMLElement>('[data-label-row]')].map((row) => ({
    id: row.dataset.labelRow,
    name: row.querySelector<HTMLInputElement>('[data-label-name]')?.value,
    count: row.querySelector('[data-label-count]')?.textContent,
  }))
const names = () => rows().map((row) => row.name)
const end = () => document.querySelector('[data-labels-end]')?.textContent ?? ''
const state = () => find('[data-org-labels]').dataset.labelsState
const nameField = (id: string) =>
  find<HTMLInputElement>(`[data-label-row="${id}"] [data-label-name]`)
const button = (label: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  )
const toasts = () => toast.mock.calls.map(([message]) => message)
const labelReads = () => [...server.reads].map((read) => read.args as Record<string, unknown>)

async function type(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const rest = () => act(() => new Promise((resolve) => setTimeout(resolve, 300)))
const click = async (el: HTMLElement | undefined) => {
  if (!el) throw new Error('nothing to click')
  await act(async () => el.click())
  await settle()
}
/** Types `value` into label `id`'s name and leaves the field. */
async function rename(id: string, value: string) {
  const field = nameField(id)
  await act(async () => field.focus())
  await type(field, value)
  await act(async () => field.blur())
  await settle()
}
async function answer(name: string, outcome: 'accept' | 'refuse' | Error) {
  const request = requests.find((r) => r.name === name)
  if (!request) throw new Error(`${name} was not sent`)
  requests = requests.filter((r) => r !== request)
  await act(async () => {
    if (outcome === 'accept') request.resolve(null)
    else
      request.reject(
        outcome === 'refuse'
          ? new ConvexError({ code: 'rule', message: 'the server said no' })
          : outcome,
      )
  })
  await settle()
}
async function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await settle()
}

describe('Settings › Labels', () => {
  it("lists the server's batch in its order with each label's active tasks, not the loaded tasks'", async () => {
    await load((snap) => {
      labelRow(snap, 'fw', 'Firmware')
      labelRow(snap, 'hw', 'Hardware')
      labelRow(snap, 'ev', 'Émile check')
      snap.issueLabels.push({ issue_id: 'task', label_id: 'hw' })
    })
    // the server counts tasks this session never loaded
    server.force = { counts: { fw: 12, hw: 1 } }
    await render()
    expect(state()).toBe('ok')
    expect(rows()).toEqual([
      { id: 'fw', name: 'Firmware', count: '12 active tasks' },
      { id: 'hw', name: 'Hardware', count: '1 active task' },
      // the server's byte order puts É after every ASCII letter
      { id: 'ev', name: 'Émile check', count: '0 active tasks' },
    ])
    expect(document.body.textContent).toContain('Showing active tasks, archived projects included.')
    expect(labelReads()).toEqual([{ org_id: org() }])
    expect(end()).toBe('')
  })

  it('says Not counted yet and Counting…, never 0, for a count the server did not give', async () => {
    await load((snap) => {
      labelRow(snap, 'fw', 'Firmware')
      labelRow(snap, 'hw', 'Hardware')
    })
    server.force = { counts: { fw: null } }
    await render()
    expect(rows().map((row) => row.count)).toEqual(['Not counted yet', '0 active tasks'])
    expect(document.querySelector('[data-labels-counting]')).toBeNull()
    server.force = { counting: true }
    await rerun()
    expect(rows().map((row) => row.count)).toEqual(['Counting…', 'Counting…'])
    expect(find('[data-labels-counting]').textContent).toBe(
      'Qivo is counting how many tasks use each label. The counts show when it has finished.',
    )
  })

  it('searches the whole list once typing rests, keeps the list past the limit and says when nothing matches', async () => {
    await load(many(30))
    await render()
    expect(names()).toHaveLength(25)
    const box = find<HTMLInputElement>('[data-labels-search]')
    await type(box, 'label 27')
    // typing has not rested, so the list is the first one still
    expect(names()).toHaveLength(25)
    await rest()
    await settle()
    expect(labelReads()).toEqual([{ org_id: org(), search: 'label 27' }])
    expect(names()).toEqual(['Label 27'])
    await type(box, 'x'.repeat(201))
    await rest()
    await settle()
    expect(names()).toEqual(['Label 27'])
    expect(end()).toBe('A search must be at most 200 characters. Search for fewer words.')
    await type(box, 'nothing like it')
    await rest()
    await settle()
    expect(names()).toEqual([])
    expect(end()).toBe('No labels match.')
    // Escape clears a typed search first
    await act(async () =>
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    await settle()
    expect(box.value).toBe('')
    expect(names()).toHaveLength(25)
  })

  it('says a stopped batch checked part of the list, with and without rows, and never that none match', async () => {
    await load(many(30))
    server.force = { stop: 10 }
    await render()
    expect(names()).toHaveLength(10)
    expect(end()).toContain('Qivo checked part of the list. Load more continues.')
    await type(find<HTMLInputElement>('[data-labels-search]'), 'label 29')
    await rest()
    await settle()
    // the part read, Label 00 to 09, held no match
    expect(names()).toEqual([])
    expect(end()).toContain(
      'Qivo checked part of the list and found no matches there. Load more continues.',
    )
    expect(end()).not.toContain('No labels match.')
  })

  it('loads more to the end over 60 labels, keeping focus on Load more and then giving it to the first new row', async () => {
    await load(many(60))
    await render()
    const more = () => find<HTMLButtonElement>('[data-labels-more]')
    await act(async () => more().focus())
    await click(more())
    expect(names()).toHaveLength(50)
    expect(document.activeElement).toBe(more())
    await click(more())
    expect(names()).toHaveLength(60)
    expect(document.querySelector('[data-labels-more]')).toBeNull()
    expect(document.activeElement).toBe(nameField('l50'))
    expect(end()).toBe('')
    // the batches stay live, pinned between their cursors
    expect(labelReads().map((args) => Object.keys(args))).toEqual([
      ['org_id', 'through'],
      ['org_id', 'after', 'through'],
      ['org_id', 'after'],
    ])
  })

  it('asks for a search once it holds its batches, and Retry after a failed first or later batch', async () => {
    await load(many(60))
    server.force = { batch: 5 }
    await render()
    for (let i = 0; i < 9; i++) {
      const more = document.querySelector<HTMLButtonElement>('[data-labels-more]')
      if (more) await click(more)
    }
    // eight batches of five
    expect(names()).toHaveLength(40)
    expect(end()).toBe('Search to find more labels.')
    await load(many(30))
    server.force = { fail: true }
    await render()
    expect(state()).toBe('failed')
    expect(end()).toContain("Couldn't load labels.")
    expect(end()).not.toContain('No labels yet.')
    server.force = {}
    await click(button('Retry'))
    expect(names()).toHaveLength(25)
    server.force = { fail: true }
    await click(find('[data-labels-more]'))
    expect(end()).toContain("Couldn't load more labels.")
    expect(names()).toHaveLength(25)
    // the end line's Retry reads every batch that failed
    server.force = {}
    await click(button('Retry', find('[data-labels-end]')))
    expect(names()).toHaveLength(30)
  })

  it('says the list failed, not a Load more, when its only batch fails on a rerun', async () => {
    await load(many(30))
    await render()
    server.force = { fail: true }
    await rerun()
    expect(state()).toBe('failed')
    // the batch keeps its rows, and Retry starts the list again
    expect(names()).toHaveLength(25)
    expect(end()).toBe("Couldn't load labels.Retry")
    server.force = {}
    await click(button('Retry', find('[data-labels-end]')))
    expect(state()).toBe('ok')
    expect(names()).toHaveLength(25)
  })

  it('keeps focus on the Retry that takes Load more’s place, and moves it to no row while a split reads its halves', async () => {
    await load(many(30))
    server.force = { batch: 5 }
    await render()
    const more = () => find<HTMLButtonElement>('[data-labels-more]')
    await click(more())
    expect(names()).toHaveLength(10)
    // labels made inside the pinned first batch, more than one read of it
    // holds, so it splits, and its halves answer on the next rerun
    await act(async () => more().focus())
    server.hold = true
    await elsewhere((snap) => {
      for (let i = 0; i < 20; i++) labelRow(snap, `m${i}`, `Label 00 ${i + 10}`)
    })
    expect(end()).toBe('Loading labels…')
    expect(document.activeElement?.closest('[data-label-row]') ?? null).toBeNull()
    expect(document.activeElement).not.toBe(find('[data-labels-search]'))
    server.hold = false
    await rerun()
    expect(names()).toHaveLength(30)
    // a Load more whose batch fails leaves focus on the Retry in its place
    await act(async () => more().focus())
    server.force = { batch: 5, fail: true }
    await click(more())
    expect(end()).toBe("Couldn't load more labels.Retry")
    expect(document.activeElement).toBe(button('Retry', find('[data-labels-end]')))
  })

  it('reads nothing for someone who is not an admin, and shows a refusal as a failure', async () => {
    await load((snap) => {
      snap.profiles[0].org_role = 'user'
      labelRow(snap, 'fw', 'Firmware')
    })
    await render()
    expect(labelReads()).toEqual([])
    expect(document.body.textContent).toContain('Only organization admins can manage labels.')
    expect(document.querySelector('[data-label-row]')).toBeNull()
    // an admin the server no longer takes for one
    await load((snap) => labelRow(snap, 'fw', 'Firmware'))
    server.snap.profiles[0].org_role = 'user'
    await render()
    expect(state()).toBe('failed')
    expect(end()).toContain("Couldn't load labels.")
    expect(document.body.textContent).not.toContain('No labels yet.')
  })

  it('says what a delete reaches in its window, hides the row at once and brings it back on a refusal', async () => {
    await load((snap) => {
      labelRow(snap, 'fw', 'Firmware')
      labelRow(snap, 'hw', 'Hardware')
      labelRow(snap, 'qa', 'Quality')
    })
    server.force = { counts: { fw: 12, hw: 0, qa: null } }
    await render()
    const sentence = async (id: string) => {
      await click(find(`[data-delete-label="${id}"]`))
      const text = find('[data-label-delete-sentence]').textContent
      await click(button('Cancel'))
      return text
    }
    expect(await sentence('fw')).toBe(
      'Used by 12 active tasks. Deleting this label removes it from all tasks, including archived tasks. This cannot be undone.',
    )
    expect(await sentence('hw')).toBe(
      'Used by no active tasks. Deleting this label removes it from all tasks, including archived tasks. This cannot be undone.',
    )
    expect(await sentence('qa')).toBe(
      'Deleting this label removes it from all tasks, including archived tasks. This cannot be undone.',
    )
    expect(requests).toEqual([])
    await click(find('[data-delete-label="hw"]'))
    expect(button('Delete')?.closest('[data-modal-shell]')).not.toBeNull()
    await click(button('Delete'))
    expect(requests.map((r) => r.name)).toEqual(['labels:remove'])
    expect(names()).toEqual(['Firmware', 'Quality'])
    // focus goes to the next row's name
    expect(document.activeElement).toBe(nameField('qa'))
    await answer('labels:remove', 'refuse')
    expect(names()).toEqual(['Firmware', 'Hardware', 'Quality'])
    await click(find('[data-delete-label="hw"]'))
    await click(button('Delete'))
    await answer('labels:remove', 'accept')
    expect(toasts()).toContain('Label “Hardware” deleted')
    expect(names()).toEqual(['Firmware', 'Quality'])
  })

  it('gives focus back to the Delete button when a later window closes without deleting', async () => {
    await load((snap) => {
      labelRow(snap, 'fw', 'Firmware')
      labelRow(snap, 'hw', 'Hardware')
      labelRow(snap, 'qa', 'Quality')
    })
    await render()
    const deleteOf = (id: string) => find<HTMLButtonElement>(`[data-delete-label="${id}"]`)
    /** Presses label `id`'s Delete with focus on it, as a keyboard user does. */
    const ask = async (id: string) => {
      await act(async () => deleteOf(id).focus())
      await click(deleteOf(id))
    }
    await ask('hw')
    await click(button('Delete'))
    await answer('labels:remove', 'accept')
    await tick()
    expect(document.activeElement).toBe(nameField('qa'))
    await ask('fw')
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    await click(button('Cancel'))
    await tick()
    // the row stays, and the window gives focus back to the Delete button
    // that opened it, with no move to another row or the search box first
    expect(focus.mock.contexts).toHaveLength(1)
    expect(focus.mock.contexts[0]).toBe(deleteOf('fw'))
    expect(document.activeElement).toBe(deleteOf('fw'))
  })

  it('shows a label it made past the loaded rows as Added until a batch holds it', async () => {
    await load(many(30))
    await render()
    await type(find<HTMLInputElement>('input[placeholder="New label name"]'), 'Zeta release')
    // the name's check answers once typing rests
    await rest()
    await settle()
    await click(button('Add label'))
    expect(requests.map((r) => r.name)).toEqual(['labels:create'])
    const id = requests[0]?.args.id as string
    await answer('labels:create', 'accept')
    expect(toasts()).toContain('Label “Zeta release” created')
    expect(rows()[0]).toEqual({ id, name: 'Zeta release', count: 'Added' })
    expect(find(`[data-label-row="${id}"] [data-label-kept]`).textContent).toBe('Added')
    // the server holds it, behind Load more
    await elsewhere((snap) => labelRow(snap, id, 'Zeta release'))
    expect(rows()[0]?.count).toBe('Added')
    await click(find('[data-labels-more]'))
    expect(rows().at(-1)).toEqual({ id, name: 'Zeta release', count: '0 active tasks' })
    expect(document.querySelector('[data-label-kept]')).toBeNull()
    // the server's `exact` knows every name, loaded or not, in any case
    await type(find<HTMLInputElement>('input[placeholder="New label name"]'), 'label 03')
    await rest()
    await settle()
    expect(button('Add label')?.disabled).toBe(true)
    expect(find('[data-label-name-check]').textContent).toBe(
      'A label with that name already exists',
    )
  })

  it('checks a new name once on the server’s exact, and keeps Add off until the answer for the text on screen is free', async () => {
    await load((snap) => labelRow(snap, 'fw', 'Firmware'))
    await render()
    const input = find<HTMLInputElement>('input[placeholder="New label name"]')
    await type(input, 'FIRMWARE')
    // on its way: Add off, and the page says so beside it
    expect(button('Add label')?.disabled).toBe(true)
    expect(find('[data-label-name-check]').textContent).toBe('Checking the name…')
    await rest()
    await settle()
    expect(server.checks).toEqual(['FIRMWARE'])
    expect(button('Add label')?.disabled).toBe(true)
    expect(find('[data-label-name-check="taken"]').textContent).toBe(
      'A label with that name already exists',
    )
    // a free name turns Add on once its answer is in, and only then
    await type(input, 'Firmware 2')
    expect(button('Add label')?.disabled).toBe(true)
    await rest()
    await settle()
    expect(server.checks).toEqual(['FIRMWARE', 'Firmware 2'])
    expect(button('Add label')?.disabled).toBe(false)
    expect(document.querySelector('[data-label-name-check]')).toBeNull()
    await click(button('Add label'))
    // the create carries a palette color picked from its id
    const { labelColorFor } = await import('../../lib/labelColors')
    const sent = requests.find((r) => r.name === 'labels:create')
    expect(sent?.args).toMatchObject({ name: 'Firmware 2' })
    expect(sent?.args.color).toBe(labelColorFor(String(sent?.args.id)))
  })

  it('leaves the name to the server after a failed check, its refusal toasted with the typed name kept', async () => {
    await load((snap) => labelRow(snap, 'fw', 'Firmware'))
    await render()
    server.checkFails = true
    const input = find<HTMLInputElement>('input[placeholder="New label name"]')
    await type(input, 'firmware')
    await rest()
    await settle()
    // a failed check never says the name is free or taken; Add stays on
    expect(button('Add label')?.disabled).toBe(false)
    expect(document.querySelector('[data-label-name-check]')).toBeNull()
    await click(button('Add label'))
    await answer(
      'labels:create',
      new ConvexError({ code: 'rule', message: 'a label with that name already exists' }),
    )
    expect(toasts().some((t) => t.startsWith('A label with that name already exists'))).toBe(true)
    expect(input.value).toBe('firmware')
  })

  it('shows and writes a label the store does not hold from the page’s answer, sending what the row showed', async () => {
    await load((snap) => labelRow(snap, 'fw', 'Firmware'))
    // another admin's new label reaches the answer before the catalogue
    labelRow(server.snap, 'new', 'New from elsewhere', '#0891B2')
    await render()
    expect(names()).toEqual(['Firmware', 'New from elsewhere'])
    // nothing waits for the store
    expect(nameField('new').disabled).toBe(false)
    expect(document.querySelector('[data-label-waiting]')).toBeNull()
    expect(find<HTMLButtonElement>('[data-delete-label="new"]').disabled).toBe(false)
    await rename('new', 'Renamed elsewhere')
    expect(requests.at(-1)).toMatchObject({
      name: 'labels:update',
      args: {
        org_id: org(),
        id: 'new',
        patch: { name: 'Renamed elsewhere' },
        expected: { name: 'New from elsewhere' },
      },
    })
    await answer('labels:update', 'accept')
    // the row shows what the page saved until the answer holds it
    expect(nameField('new').value).toBe('Renamed elsewhere')
    await click(find<HTMLButtonElement>('[data-delete-label="new"]'))
    await click(button('Delete', find('[data-modal-shell]')))
    expect(requests.at(-1)).toMatchObject({
      name: 'labels:remove',
      args: {
        org_id: org(),
        id: 'new',
        expected: { name: 'Renamed elsewhere', color: '#0891B2' },
      },
    })
  })

  it('keeps a refused rename and recolor of a label the store does not hold unsaved, and sends what the answer shows after them', async () => {
    await load((snap) => labelRow(snap, 'fw', 'Firmware'))
    // another admin's label reaches the answer before the catalogue
    labelRow(server.snap, 'new', 'New from elsewhere', '#0891B2')
    await render()
    const refusal = () =>
      new ConvexError({ code: 'rule', message: 'a label with that name already exists' })
    await rename('new', 'Firmware')
    expect(requests.at(-1)).toMatchObject({
      name: 'labels:update',
      args: { id: 'new', patch: { name: 'Firmware' }, expected: { name: 'New from elsewhere' } },
    })
    await answer('labels:update', refusal())
    // the typed text stays, unsaved, and the row still names the label as
    // the answer does
    expect(nameField('new').value).toBe('Firmware')
    expect(nameField('new').getAttribute('aria-label')).toBe('Name of label New from elsewhere')
    const { hasUnsaved } = await import('../../lib/leaveGuard')
    expect(hasUnsaved()).toBe(true)
    // a refused recolor leaves the answer's color
    await click(find('[aria-label="Change color for New from elsewhere"]'))
    await click(find('[aria-label="Label colors"] [aria-label="Red"]'))
    expect(requests.at(-1)).toMatchObject({
      name: 'labels:update',
      args: { id: 'new', patch: { color: '#F0555D' }, expected: { color: '#0891B2' } },
    })
    await answer('labels:update', 'refuse')
    // Delete sends the name and color the row shows, the answer's
    await click(find<HTMLButtonElement>('[data-delete-label="new"]'))
    await click(button('Delete', find('[data-modal-shell]')))
    expect(requests.at(-1)).toMatchObject({
      name: 'labels:remove',
      args: { id: 'new', expected: { name: 'New from elsewhere', color: '#0891B2' } },
    })
  })
})

describe('a label name on the draft model', () => {
  const field = (id = 'fw') => nameField(id)
  const fieldChanged = () =>
    new ConvexError({
      code: 'conflict',
      reason: 'field_changed',
      message: 'name changed since you read it',
      changes: [{ record: 'label', id: 'fw', field: 'name', by: null, at: NOW }],
    })

  it('shows a rename made elsewhere while typing, saves nothing until Keep mine, then sends the saved name as seen', async () => {
    await load((snap) => labelRow(snap, 'fw', 'Firmware'))
    await render()
    await act(async () => field().focus())
    await type(field(), 'Firmware 2')
    await elsewhere((snap) => {
      snap.labels[0].name = 'Firmware B'
      snap.labels[0].name_lower = 'firmware b'
    })
    expect(field().value).toBe('Firmware 2')
    expect(find('[data-draft-conflict]').textContent).toContain(
      'Changed elsewhere to “Firmware B”.',
    )
    expect(field().getAttribute('aria-describedby')).toBe(find('[data-draft-conflict]').id)
    await act(async () => field().blur())
    await settle()
    expect(requests).toEqual([])
    await click(find('[data-draft-keep-mine]'))
    await act(async () => field().blur())
    await settle()
    expect(requests).toMatchObject([
      {
        name: 'labels:update',
        args: { id: 'fw', patch: { name: 'Firmware 2' }, expected: { name: 'Firmware B' } },
      },
    ])
  })

  it('drops the draft on Use saved, takes its own rename as no conflict, and keeps a refused text', async () => {
    await load((snap) => labelRow(snap, 'fw', 'Firmware'))
    await render()
    await act(async () => field().focus())
    await type(field(), 'Firmware 2')
    await elsewhere((snap) => {
      snap.labels[0].name = 'Firmware B'
    })
    await click(find('[data-draft-use-saved]'))
    expect(field().value).toBe('Firmware B')
    // its own rename, painted and then delivered, is no conflict
    await rename('fw', 'Firmware C')
    expect(requests.at(-1)?.args).toMatchObject({ expected: { name: 'Firmware B' } })
    await answer('labels:update', 'accept')
    await elsewhere((snap) => {
      snap.labels[0].name = 'Firmware C'
    })
    expect(document.querySelector('[data-draft-conflict]')?.textContent ?? '').toBe('')
    expect(field().value).toBe('Firmware C')
    // a refusal over someone else's change keeps the text
    await rename('fw', 'Firmware D')
    await answer('labels:update', fieldChanged())
    expect(field().value).toBe('Firmware D')
    // a refusal keeps it too
    await rename('fw', 'Firmware E')
    await answer('labels:update', 'refuse')
    expect(field().value).toBe('Firmware E')
  })

  // Changed with the roster cache stage: a rename to a name another label
  // holds goes to the server, which refuses it, and the text stays
  it('keeps a name over the cap unsent, and one another label holds typed after the server refuses it', async () => {
    await load((snap) => {
      labelRow(snap, 'fw', 'Firmware')
      labelRow(snap, 'hw', 'Hardware')
    })
    await render()
    await rename('fw', 'f'.repeat(41))
    expect(field().value).toHaveLength(41)
    expect(toasts()).toEqual(['A label name must be at most 40 characters. Shorten it.'])
    expect(requests).toEqual([])
    await rename('fw', 'hardware')
    expect(requests.map((r) => r.name)).toEqual(['labels:update'])
    await answer(
      'labels:update',
      new ConvexError({ code: 'rule', message: 'a label with that name already exists' }),
    )
    expect(field().value).toBe('hardware')
    expect(toasts().some((t) => t.startsWith('A label with that name already exists'))).toBe(true)
    const { hasUnsaved } = await import('../../lib/leaveGuard')
    expect(hasUnsaved()).toBe(true)
  })

  it('keeps a row with an unsaved name, and its text, when a search hides it', async () => {
    await load(many(30))
    await render()
    await act(async () => nameField('l03').focus())
    await type(nameField('l03'), 'Label 03 draft')
    await act(async () => nameField('l03').blur())
    // the rename waits on the server; then a search leaves it out
    await type(find<HTMLInputElement>('[data-labels-search]'), 'label 29')
    await rest()
    await settle()
    expect(rows()).toEqual([
      { id: 'l03', name: 'Label 03 draft', count: 'Not in this list' },
      { id: 'l29', name: 'Label 29', count: '0 active tasks' },
    ])
  })

  it('keeps a row with a name it never sent, and its text, when a search hides it', async () => {
    await load(many(30))
    await render()
    // a name over the cap stays typed and unsent
    const long = 'f'.repeat(41)
    await rename('l03', long)
    expect(requests).toEqual([])
    await type(find<HTMLInputElement>('[data-labels-search]'), 'label 29')
    await rest()
    await settle()
    expect(rows()).toEqual([
      { id: 'l03', name: long, count: 'Not in this list' },
      { id: 'l29', name: 'Label 29', count: '0 active tasks' },
    ])
  })
})

describe('leaving the page and hiding the tab', () => {
  it('stops every label read while hidden, reads the same batches on return and leaves none behind', async () => {
    await load(many(30))
    await render()
    await click(find('[data-labels-more]'))
    const asked = labelReads()
    expect(asked).toHaveLength(2)
    await setVisibility('hidden')
    expect(labelReads()).toEqual([])
    expect(names()).toHaveLength(30)
    await setVisibility('visible')
    expect(labelReads()).toEqual(asked)
    await settle()
    expect(state()).toBe('ok')
    await act(async () => root.unmount())
    root = createRoot(container)
    expect(labelReads()).toEqual([])
  })
})
