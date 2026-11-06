// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LABEL_RIGHTS_UNCHECKED, LIMITS } from '../../convex/lib/limits'
import { TooltipProvider } from '../components/ui/tooltip'
import { limitSentence, sentence } from '../lib/fieldLimits'
import {
  type ForcedLabelPage,
  type LabelPageArgs,
  labelPickerStandIn,
  labelsByIdsStandIn,
} from '../store/labelPagesStandIn.setup'
import type { IssueVM } from '../store/planner'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The task label picker (LabelPicker.tsx) on the real store. Its batches
   (labels:picker) and the window's reads of labels by id (labels:byIds)
   are answered by the stand-ins over what the server holds, which may hold
   labels the store was not sent. A picker read answers at once unless a
   test holds the reads, and then waits until the test lets it through.
   The server takes creates and toggles as the real one stores them. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('../store/guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

type Planner = typeof import('../store/planner')['P']
type Picker = typeof import('./LabelPicker')
type Label = Snapshot['labels'][number]

const NOW = '2026-09-14T08:00:00.000Z'

let P: Planner
let picker: Picker
let container: HTMLDivElement
let root: Root
/* How the server answers each mutation by name, where a test says so. */
let answers: Record<string, () => Promise<unknown>>
let sent: { name: string; args: Record<string, unknown> }[]
let org: string
/* The store's workspace, and what the server holds besides. */
let snap: Snapshot
let server: Snapshot
let force: ForcedLabelPage
/* The picker's reads, in order, each with how to let it through. */
let reads: { args: LabelPageArgs; settle: () => Promise<void> }[]
/* Whether picker reads wait for the test (hold) and whether the next one
   is refused with a sentence. */
let holding: boolean
let refuseNext: string | null
/* The window's read of a task the workspace does not hold. */
let windowRead: ((value: unknown) => void) | null
/* Publishes the workspace again, as Convex delivers a write's transition
   before the write's answer. */
let publish: () => void

/* A label of the organization named `name`. */
const label = (name: string, extra: Partial<Label> = {}): Label => ({
  id: `label-${name.toLowerCase().replace(/\W+/g, '-')}`,
  org_id: org,
  name,
  name_lower: name.toLowerCase(),
  color: '#4C9AFF',
  created_at: NOW,
  ...extra,
})

/* Loads the store over `snap` with the task "Calibrate the sensor" and
   `labels` in the catalogue, the server holding them and `serverOnly`, and
   the task carrying `on`. */
async function load(o: { labels?: Label[]; serverOnly?: Label[]; on?: string[] } = {}) {
  vi.resetModules()
  snap = plannerFixture()
  org = snap.orgs[0].id
  const taskId = crypto.randomUUID()
  snap.issues.push({
    id: taskId,
    org_id: org,
    project_id: snap.projects[0].id,
    num: 1,
    title: 'Calibrate the sensor',
    description: '',
    status: 'todo',
    priority: 'low',
    paused: false,
    created_at: NOW,
    updated_at: NOW,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  const labels = (o.labels ?? []).map((l) => ({ ...l, org_id: org }))
  const serverOnly = (o.serverOnly ?? []).map((l) => ({ ...l, org_id: org }))
  snap.labels.push(...labels)
  for (const id of o.on ?? []) snap.issueLabels.push({ issue_id: taskId, label_id: id })
  server = structuredClone(snap)
  server.labels.push(...serverOnly)
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      publish = () => next(structuredClone(snap))
      publish()
    }
    if (name === 'taskWindow:task') windowRead = next
    if (name === 'labels:byIds')
      try {
        next(labelsByIdsStandIn(server, args))
      } catch (e) {
        fail?.(e)
      }
    return () => {}
  })
  const store = await import('../store/planner')
  P = store.P
  await store.initStore()
  picker = await import('./LabelPicker')
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // the popup follows its own size
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.spyOn(console, 'error').mockImplementation(() => {})
  window.showToast = vi.fn()
  answers = {}
  sent = []
  force = {}
  reads = []
  holding = false
  refuseNext = null
  windowRead = null
  publish = () => {}
  network.query.mockImplementation((ref, args: LabelPageArgs) => {
    if (getFunctionName(ref) !== 'labels:picker') return Promise.resolve(null)
    const refusal = refuseNext
    refuseNext = null
    const answer = () => {
      if (refusal) throw new ConvexError({ code: 'bad_request', message: refusal })
      return structuredClone(labelPickerStandIn(server, args, { force }))
    }
    return new Promise((resolve, reject) => {
      const settle = () =>
        act(async () => {
          try {
            resolve(answer())
          } catch (e) {
            reject(e)
          }
        })
      reads.push({ args, settle })
      if (!holding)
        try {
          resolve(answer())
        } catch (e) {
          reject(e)
        }
    })
  })
  // the server stores creates and toggles, in what it holds and in the
  // workspace it sends, and answers as a test names
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    sent.push({ name, args })
    const answer = answers[name]
    if (answer) return answer()
    for (const held of [server, snap]) {
      if (name === 'labels:create')
        held.labels.push({
          id: args.id,
          org_id: args.org_id,
          name: args.name,
          name_lower: String(args.name).toLowerCase(),
          color: args.color,
          created_at: NOW,
        })
      if (name === 'labels:toggle') {
        held.issueLabels = held.issueLabels.filter(
          (il) => !(il.issue_id === args.issue_id && il.label_id === args.label_id),
        )
        if (args.on) held.issueLabels.push({ issue_id: args.issue_id, label_id: args.label_id })
      }
    }
    if (name === 'labels:create' || name === 'labels:toggle') publish()
    return Promise.resolve(null)
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const task = () => P.issues[0]

/* Opens the picker for the task `of` answers, the store's task by default,
   as the window renders it again with the task's model after each change
   of the store, and returns its search field. */
async function open(of: () => IssueVM | undefined = task): Promise<HTMLInputElement> {
  const { usePlannerVersion } = await import('../store/usePlannerVersion')
  function Window() {
    usePlannerVersion()
    const it = of()
    return it ? <picker.LabelPickerPopup it={it} anchor={{ x: 0, y: 0 }} onDone={vi.fn()} /> : null
  }
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Window />
      </TooltipProvider>,
    ),
  )
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Search labels"]')
  if (!input) throw new Error('no search field')
  expect(input.placeholder).toBe('Add labels…')
  return input
}

/* Types into the React-controlled field. */
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
/* Lets typing rest past the search delay. */
const rest = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 300)))
/* Types `value` and lets it rest, so its answer arrives unless held. */
const search = async (input: HTMLInputElement, value: string) => {
  await type(input, value)
  await rest()
}
const enter = (input: HTMLInputElement) =>
  act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
const click = (element: Element | null | undefined) =>
  act(async () => {
    if (!(element instanceof HTMLElement)) throw new Error('nothing to click')
    element.click()
  })

const pop = () => document.querySelector<HTMLElement>('[data-label-picker]')
const text = () => pop()?.textContent ?? ''
/* The rows on screen, by name or the waiting line, with their marks. */
const rows = () =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-label-option]')].map((row) => ({
    id: row.dataset.labelOption,
    name: row.textContent,
    on: row.getAttribute('aria-pressed') === 'true',
    current: row.hasAttribute('data-label-current'),
    disabled: row.disabled,
  }))
const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-label-option="${id}"]`)
const toggles = () => sent.filter((s) => s.name === 'labels:toggle').map((s) => s.args)
const createRow = () => document.querySelector('[data-label-create]')

/* `n` labels named Label 00 to Label n-1. */
const many = (n: number) =>
  Array.from({ length: n }, (_, i) => label(`Label ${String(i).padStart(2, '0')}`))

describe('the label picker', () => {
  it('reads nothing before it opens, then the organization alone, and a typed search after its rest', async () => {
    await load({ labels: many(3) })
    expect(reads).toEqual([])
    const input = await open()
    expect(reads.map((r) => r.args)).toEqual([{ org_id: org }])
    await type(input, 'abel 01')
    expect(reads).toHaveLength(1)
    await rest()
    expect(reads.map((r) => r.args)).toEqual([{ org_id: org }, { org_id: org, search: 'abel 01' }])
    expect(rows().map((r) => r.name)).toEqual(['Label 01'])
  })

  it("lists the task's labels first, checked, also one no batch holds and one the store does not hold", async () => {
    const labels = many(30)
    const far = label('Zeta far')
    await load({ labels, serverOnly: [far], on: [labels[3].id, labels[28].id, far.id] })
    await open()
    const shown = rows()
    // the task's own, in the task's order, then the first batch less those
    expect(shown.slice(0, 3)).toEqual([
      { id: labels[3].id, name: 'Label 03', on: true, current: true, disabled: false },
      { id: labels[28].id, name: 'Label 28', on: true, current: true, disabled: false },
      { id: far.id, name: 'Zeta far', on: true, current: true, disabled: false },
    ])
    expect(shown.slice(3).map((r) => r.name)).toEqual(
      labels.slice(0, 25).flatMap((l, i) => (i === 3 ? [] : [l.name])),
    )
    expect(new Set(shown.map((r) => r.id)).size).toBe(shown.length)
    expect(shown.slice(3).every((r) => !r.on && !r.current)).toBe(true)
    // each comes off with a press, the one the store does not hold too
    await click(rowOf(far.id))
    await click(rowOf(labels[28].id))
    expect(toggles()).toEqual([
      { org_id: org, issue_id: task().uuid, label_id: far.id, on: false },
      { org_id: org, issue_id: task().uuid, label_id: labels[28].id, on: false },
    ])
    expect(task().labels).toEqual([labels[3].id])
  })

  it('puts on a label only a batch holds, and shows it checked at the top at once', async () => {
    const far = label('Zeta far')
    await load({ labels: many(2), serverOnly: [far] })
    await open()
    await click(rowOf(far.id))
    expect(toggles()).toEqual([{ org_id: org, issue_id: task().uuid, label_id: far.id, on: true }])
    expect(task().labels).toEqual([far.id])
    expect(rows()[0]).toMatchObject({ id: far.id, name: 'Zeta far', on: true, current: true })
  })

  it('loads more after a stopped batch, saying it showed the labels found so far, and moves focus to the first new row', async () => {
    await load({ labels: many(30) })
    force = { stop: 5 }
    await open()
    expect(rows()).toHaveLength(5)
    expect(text()).toContain('Showing the labels found so far.')
    expect(pop()?.hasAttribute('data-picker-end')).toBe(false)
    const more = document.querySelector<HTMLButtonElement>('[data-picker-more]')
    more?.focus()
    await click(more)
    expect(reads.at(-1)?.args.after).toBeTruthy()
    expect(rows()).toHaveLength(10)
    expect(document.activeElement).toBe(rowOf(rows()[5].id ?? ''))
  })

  it('moves focus after Load more to the first new row, past a task label the batch begins with', async () => {
    const labels = many(12)
    await load({ labels, on: [labels[5].id] })
    force = { batch: 5 }
    await open()
    expect(rows().map((r) => r.name)).toEqual([
      'Label 05',
      'Label 00',
      'Label 01',
      'Label 02',
      'Label 03',
      'Label 04',
    ])
    const more = document.querySelector<HTMLButtonElement>('[data-picker-more]')
    more?.focus()
    await click(more)
    // the new batch begins with Label 05, which shows at the top already
    expect(reads.at(-1)?.args.after).toBeTruthy()
    expect(rows().slice(6).map((r) => r.name)).toEqual([
      'Label 06',
      'Label 07',
      'Label 08',
      'Label 09',
    ])
    expect(document.activeElement).toBe(rowOf(labels[6].id))
  })

  it('gathers at most PICKER_CAPS.labels, then asks for a search', async () => {
    await load({ labels: many(30) })
    // the picker's own copy of the module, which load imported afresh
    const { PICKER_CAPS } = await import('../lib/pickerCaps')
    const was = PICKER_CAPS.labels
    PICKER_CAPS.labels = 25
    try {
      await open()
      expect(rows()).toHaveLength(25)
      expect(document.querySelector('[data-picker-more]')).toBeNull()
      expect(text()).toContain('Search to narrow the list.')
    } finally {
      PICKER_CAPS.labels = was
    }
  })

  it("says it couldn't load labels, with Try again, and never that there are none", async () => {
    await load({ labels: many(3) })
    force = { fail: true }
    await open()
    expect(text()).toContain("Couldn't load labels.")
    expect(text()).not.toContain('No labels yet.')
    force = {}
    const retry = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Try again',
    )
    await click(retry)
    expect(rows()).toHaveLength(3)
  })

  it("shows the server's sentence for a refused search", async () => {
    await load({ labels: many(3) })
    const input = await open()
    refuseNext = 'after and through must be cursors from an earlier answer of this list'
    await search(input, 'abel')
    expect(document.querySelector('[data-picker-held]')?.textContent).toBe(
      sentence('after and through must be cursors from an earlier answer of this list'),
    )
  })

  it('says No matching labels only at the real end with no task label shown', async () => {
    const old = label('Old name')
    await load({ labels: [...many(3), old], on: [old.id] })
    // the server renamed it, so its batches never hold "old"
    server.labels = server.labels.filter((l) => l.id !== old.id)
    const input = await open()
    await search(input, 'nothing')
    expect(text()).toContain('No matching labels.')
    expect(pop()?.hasAttribute('data-picker-end')).toBe(true)
    // the task's label, which the server's list does not hold, shows alone
    await search(input, 'old')
    expect(rows().map((r) => r.name)).toEqual(['Old name'])
    expect(text()).not.toContain('No matching labels.')
    // a stopped batch is no end
    force = { stop: 1 }
    await search(input, 'still nothing')
    expect(text()).not.toContain('No matching labels.')
    expect(text()).toContain('Showing the labels found so far.')
  })

  it("disables a full task's other labels with the cap's sentence, and its labels still come off", async () => {
    const labels = many(LIMITS.labels.max + 2)
    const on = labels.slice(0, LIMITS.labels.max).map((l) => l.id)
    await load({ labels, on })
    await open()
    const cap = limitSentence(LIMITS.labels)
    expect(text()).toContain(cap)
    const off = rows().filter((r) => !r.on)
    expect(off.length).toBeGreaterThan(0)
    expect(off.every((r) => r.disabled)).toBe(true)
    await click(rowOf(on[0]))
    expect(toggles()).toEqual([{ org_id: org, issue_id: task().uuid, label_id: on[0], on: false }])
  })
})

describe("the label picker's Create new label", () => {
  it("shows only once the typed name's answer says it is free and allowed", async () => {
    await load({ labels: many(3) })
    const input = await open()
    holding = true
    await search(input, 'Bench')
    // the answer for the typed name is on its way
    expect(createRow()).toBeNull()
    await reads.at(-1)?.settle()
    expect(createRow()?.textContent).toBe('Create new label:“Bench”')
    // a name a label holds in any case
    await search(input, 'LABEL 01')
    await reads.at(-1)?.settle()
    expect(rows().map((r) => r.name)).toContain('Label 01')
    expect(createRow()).toBeNull()
  })

  it('offers nothing without the right, and says why when the check could not finish', async () => {
    await load({ labels: many(3) })
    force = { canCreate: false }
    const input = await open()
    await search(input, 'Bench')
    expect(createRow()).toBeNull()
    expect(document.querySelector('[data-label-create-unchecked]')).toBeNull()
    force = { canCreate: null }
    await search(input, 'Bench rig')
    expect(createRow()).toBeNull()
    expect(document.querySelector('[data-label-create-unchecked]')?.textContent).toBe(
      sentence(LABEL_RIGHTS_UNCHECKED),
    )
  })

  it('ignores a second Enter in the emptied field after creating the first label', async () => {
    await load()
    const input = await open()
    await type(input, 'Bench')
    await enter(input)
    await rest()
    expect(input.value).toBe('')
    expect(P.labels.map((l) => l.name)).toEqual(['Bench'])
    await enter(input)
    expect(sent.filter((s) => s.name === 'labels:toggle')).toHaveLength(1)
    expect(task().labels).toEqual([P.labels[0].id])
    // the new label shows checked at the top
    expect(rows()[0]).toMatchObject({ name: 'Bench', on: true, current: true })
  })

  it('still picks the one label a typed search matches', async () => {
    await load()
    const input = await open()
    await type(input, 'Bench')
    await enter(input)
    await rest()
    await type(input, 'ben')
    await enter(input)
    await rest()
    expect(sent.filter((s) => s.name === 'labels:toggle')).toHaveLength(2)
    expect(task().labels).toEqual([])
  })

  it('toasts only the refused create, not the attach the server refuses with it', async () => {
    await load()
    answers['labels:create'] = () =>
      Promise.reject(new ConvexError({ code: 'rule', message: 'a label named Bench exists' }))
    answers['labels:toggle'] = () =>
      Promise.reject(
        new ConvexError({
          code: 'rule',
          message: 'label and task must belong to the same organization',
        }),
      )
    const input = await open()
    await search(input, 'Bench')
    await enter(input)
    expect(vi.mocked(window.showToast).mock.calls).toEqual([
      ['A label named Bench exists. Change reverted.', 'error'],
    ])
    expect(P.labels).toEqual([])
    expect(task().labels).toEqual([])
    // the refused name comes back for another try
    expect(input.value).toBe('Bench')
  })

  it('still toasts a refused attach of a label the server created', async () => {
    await load()
    answers['labels:toggle'] = () =>
      Promise.reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    const input = await open()
    await search(input, 'Bench')
    await enter(input)
    expect(vi.mocked(window.showToast).mock.calls).toEqual([
      ["You don't have permission for that. Change reverted.", 'error'],
    ])
  })
})

describe("the label picker's Enter", () => {
  it('picks the one row once the list ended, and creates only at a real end with no row', async () => {
    await load({ labels: many(30) })
    const input = await open()
    await search(input, 'abel 29')
    await enter(input)
    expect(toggles()).toEqual([
      { org_id: org, issue_id: task().uuid, label_id: many(30)[29].id, on: true },
    ])
    expect(input.value).toBe('')
    // two rows: nothing
    await search(input, 'abel 1')
    await enter(input)
    expect(toggles()).toHaveLength(1)
    // no row: a new label
    await search(input, 'Brand new')
    await enter(input)
    expect(sent.map((s) => s.name).filter((n) => n.startsWith('labels:'))).toEqual([
      'labels:toggle',
      'labels:create',
      'labels:toggle',
    ])
  })

  it('never picks from a stopped list, but picks the exact name the server found at once', async () => {
    await load({ labels: many(30) })
    force = { stop: 1 }
    const input = await open()
    await search(input, 'abel 29')
    await enter(input)
    expect(toggles()).toEqual([])
    // the name is free by the server's lookup, so it may be created with a
    // press, but Enter waits for an end the list never reached
    expect(createRow()).not.toBeNull()
    expect(sent.filter((s) => s.name === 'labels:create')).toEqual([])
    // the exact name is a lookup, not a batch, and lists first
    await search(input, 'label 29')
    expect(rows()[0]?.name).toBe('Label 29')
    await enter(input)
    expect(toggles()).toEqual([
      { org_id: org, issue_id: task().uuid, label_id: many(30)[29].id, on: true },
    ])
  })

  it('acts once the answer for the typed text arrives, and drops an Enter whose text changed', async () => {
    await load({ labels: [...many(30), label('Zeta')] })
    const input = await open()
    holding = true
    await type(input, 'abel 29')
    await enter(input)
    await rest()
    expect(toggles()).toEqual([])
    await reads.at(-1)?.settle()
    expect(toggles()).toHaveLength(1)
    // an Enter for one text, then another text with one match
    await type(input, 'abel 2')
    await enter(input)
    await type(input, 'zeta')
    await rest()
    await reads.at(-1)?.settle()
    expect(toggles()).toHaveLength(1)
    // an empty field's Enter does nothing
    await type(input, '')
    await enter(input)
    await rest()
    for (const read of reads) await read.settle()
    expect(toggles()).toHaveLength(1)
  })
})

describe('the label picker of a task the window shows from its own answer', () => {
  /* Shows task "far" from the window's answer, carrying `labels`. */
  async function shownFar(labels: string[] = []) {
    P.watchComments('far', org)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    await act(async () => {
      windowRead?.({
        state: 'ok',
        task: {
          id: 'far',
          org_id: org,
          project_id: P.projects[0].id,
          num: 40,
          title: 'Tune the antenna',
          description: '',
          status: 'todo',
          priority: 'low',
          paused: false,
          created_at: NOW,
          updated_at: NOW,
          has_subtasks: false,
          has_hidden_subtasks: false,
          has_hidden_parent: false,
        },
        level: 'lead',
        labels: labels.map((label_id) => ({ issue_id: 'far', label_id })),
        follow: null,
        parent: null,
        subtasks: { rows: [], complete: true },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const shown = P.taskDetail('far')?.view
    if (!shown) throw new Error('the window shows no task from its answer')
    return shown
  }

  it('creates a label and puts it on the task from its answer', async () => {
    await load()
    await shownFar()
    const input = await open(() => P.taskDetail('far')?.view)
    await search(input, 'Bench')
    await enter(input)
    expect(sent.map((s) => s.name).filter((name) => name !== 'identity:claimMySeats')).toEqual([
      'labels:create',
      'labels:toggle',
    ])
    const made = P.labels.find((l) => l.name === 'Bench')
    expect(P.taskDetail('far')?.view?.labels).toEqual([made?.id])
  })

  it('puts on and takes off a label the store does not hold', async () => {
    const far = label('Zeta far')
    await load({ labels: many(2), serverOnly: [far] })
    await shownFar()
    await open(() => P.taskDetail('far')?.view)
    await click(rowOf(far.id))
    expect(toggles()).toEqual([{ org_id: org, issue_id: 'far', label_id: far.id, on: true }])
    expect(P.taskDetail('far')?.view?.labels).toEqual([far.id])
    expect(rows()[0]).toMatchObject({ id: far.id, name: 'Zeta far', on: true, current: true })
    await click(rowOf(far.id))
    expect(toggles().at(-1)).toEqual({ org_id: org, issue_id: 'far', label_id: far.id, on: false })
    expect(P.taskDetail('far')?.view?.labels).toEqual([])
  })
})

describe("the store's label toggles", () => {
  it('send for a label the store does not hold, and take the paint back on a refusal', async () => {
    const far = label('Zeta far')
    await load({ serverOnly: [far] })
    answers['labels:toggle'] = () =>
      Promise.reject(
        new ConvexError({
          code: 'rule',
          message: 'label and task must belong to the same organization',
        }),
      )
    await act(async () => P.toggleIssueLabel(task().id, far.id))
    expect(toggles()).toEqual([{ org_id: org, issue_id: task().uuid, label_id: far.id, on: true }])
    expect(task().labels).toEqual([])
    expect(vi.mocked(window.showToast).mock.calls).toEqual([
      ['Label and task must belong to the same organization. Change reverted.', 'error'],
    ])
  })
})
