// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../../convex/lib/limits'
import type { RelationCandidate, RelationKind } from '../../convex/lib/relationPicker'
import { TooltipProvider } from '../components/ui/tooltip'
import { limitSentence } from '../lib/fieldLimits'
import { parentBlock, subtaskBlock } from '../lib/relationCandidates'
import { linkBlock } from '../lib/taskCaps'
import type { RelatedTaskVM } from '../store/planner'
import { plannerFixture } from '../store/plannerFixture.setup'

/* The task window's relation picker on the real store, its batches
   (taskWindow.relationCandidates) held until each test answers them, so
   answers can come late, out of order or not at all. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => {
  const { liveOver } = await import('../store/guard/liveDouble.setup')
  return { convex: network, live: liveOver(network) }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

/* One read the picker sent, with its answers. */
type Read = {
  args: Record<string, unknown>
  answer: (value: unknown) => Promise<void>
  fail: () => Promise<void>
  refuse: (code: string, message: string) => Promise<void>
}

const AT = '2026-09-14T08:00:00.000Z'
const TASK = { uuid: 'open-task', org: '', project: 'work' }

let container: HTMLDivElement
let root: Root
let reads: Read[]
let RelationPicker: typeof import('./RelationPicker')['RelationPicker']

/* A row the server offers. */
const row = (n: number, over: Partial<RelationCandidate> = {}): RelationCandidate => ({
  id: `task-${n}`,
  org_id: TASK.org,
  project_id: 'work',
  num: n,
  title: `Task ${n}`,
  status: 'todo',
  priority: 'medium',
  paused: false,
  created_at: AT,
  updated_at: AT,
  status_at: AT,
  level: 'lead',
  ...over,
})
const batch = (rows: RelationCandidate[], next: string | null = null, extra = {}) => ({
  state: 'ok',
  rows,
  next,
  all_projects: null,
  stopped: false,
  blocked: null,
  ...extra,
})
/* A task of the window's own lists. */
const relation = (n: number, title = `Task ${n}`): RelatedTaskVM & { type?: string } => ({
  uuid: `task-${n}`,
  handle: `QN-${n}`,
  org: TASK.org,
  num: n,
  title,
  project: 'work',
  status: 'todo',
  owner: undefined,
  isGroup: false,
  done: false,
  held: false,
  level: 'lead',
  remaining: undefined,
})

async function load() {
  vi.resetModules()
  const snap = plannerFixture()
  TASK.org = snap.orgs[0].id
  reads = []
  network.onUpdate.mockImplementation((ref, _args, next) => {
    if (getFunctionName(ref) === 'workspace:whole') next(structuredClone(snap))
    return () => {}
  })
  network.mutation.mockResolvedValue(null)
  network.query.mockImplementation((ref, args) => {
    if (getFunctionName(ref) !== 'taskWindow:relationCandidates') return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      reads.push({
        args,
        answer: async (value) => {
          await act(async () => resolve(value))
        },
        fail: async () => {
          await act(async () => reject(new Error('Too many index ranges read')))
        },
        refuse: async (code, message) => {
          await act(async () => reject(new ConvexError({ code, message })))
        },
      })
    })
  })
  const store = await import('../store/planner')
  await store.initStore()
  ;({ RelationPicker } = await import('./RelationPicker'))
}

type Options = {
  kind?: RelationKind
  task?: typeof TASK
  current?: (RelatedTaskVM & { type?: string })[]
  note?: string | null
  locked?: boolean
  toggle?: (...args: unknown[]) => Promise<boolean> | boolean
  onCreate?: (title: string) => void
}
const picks = vi.fn<(...args: unknown[]) => Promise<boolean> | boolean>()
const created = vi.fn<(title: string) => void>()

async function show(o: Options = {}) {
  picks.mockImplementation(o.toggle ?? (() => true))
  await act(async () =>
    root.render(
      <TooltipProvider>
        <RelationPicker
          kind={o.kind ?? 'subtask'}
          task={o.task ?? TASK}
          anchor={{ x: 100, y: 100 }}
          onDone={vi.fn()}
          placeholder="Add subtasks: ID or title…"
          current={{ rows: o.current ?? [], note: o.note ?? null, locked: o.locked }}
          seenOf={(c) =>
            c.current
              ? { on: true, busy: false, parent: { id: TASK.uuid, hidden: false } }
              : { on: false, busy: false, parent: { id: null, hidden: false } }
          }
          toggle={(...args) => picks(...args)}
          createLabel="Create new subtask:"
          onCreate={'onCreate' in o ? o.onCreate : created}
        />
      </TooltipProvider>,
    ),
  )
}
const hide = () => act(async () => root.render(<TooltipProvider>{null}</TooltipProvider>))

const picker = () => document.querySelector<HTMLElement>('[data-relation-picker]')
const state = () => picker()?.dataset.pickerState
const rowIds = () =>
  [...document.querySelectorAll<HTMLElement>('[data-picker-row]')].map((r) => r.dataset.pickerRow)
const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-picker-row="${id}"]`)
const text = () => picker()?.textContent ?? ''
const input = () => {
  const found = picker()?.querySelector('input')
  if (!found) throw new Error('missing the search box')
  return found
}
/* Types `value` into the search box as a person does. */
const typeInto = (value: string) =>
  act(async () => {
    const field = input()
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
/* Lets typing rest past the search delay. */
const rest = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 300)))
const enter = () =>
  act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
const click = (element: Element | null | undefined) =>
  act(async () => {
    if (!(element instanceof HTMLElement)) throw new Error('nothing to click')
    element.click()
  })
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
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
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  window.showToast = vi.fn()
  picks.mockReset()
  created.mockReset()
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

describe('the relation picker', { timeout: 20_000 }, () => {
  it('reads at once without a text and once typing rests, and drops an older text’s answer', async () => {
    await load()
    await show()
    expect(reads.map((r) => r.args)).toEqual([
      { org_id: TASK.org, issue_id: TASK.uuid, kind: 'subtask' },
    ])
    expect(state()).toBe('loading')
    expect(text()).toContain('Loading tasks…')
    await typeInto('ma')
    await typeInto('mast')
    // nothing goes before typing rests
    expect(reads).toHaveLength(1)
    await rest()
    expect(reads.map((r) => r.args.search)).toEqual([undefined, 'mast'])
    await reads[1].answer(batch([row(2, { title: 'Build the mast' })]))
    // the empty text's answer comes last, and lands nowhere
    await reads[0].answer(batch([row(1)]))
    expect(rowIds()).toEqual(['task-2'])
    expect(state()).toBe('ready')
  })

  it('acts on Enter only for the typed text once its list has ended', async () => {
    await load()
    await show()
    await reads[0].answer(batch([row(1), row(2)]))
    // Enter without a text picks nothing
    await enter()
    expect(picks).not.toHaveBeenCalled()
    // a list that goes on proves no single match
    await typeInto('task')
    await rest()
    await reads[1].answer(batch([row(1)], 'more'))
    await enter()
    expect(picks).not.toHaveBeenCalled()
    // Enter pressed while the answer is on its way acts once it arrives
    await typeInto('task 2')
    await enter()
    await rest()
    expect(picks).not.toHaveBeenCalled()
    await reads[2].answer(batch([row(2)]))
    expect(picks).toHaveBeenCalledTimes(1)
    expect(picks.mock.calls[0]?.[0]).toMatchObject({ uuid: 'task-2' })
    // an ended empty list creates
    await typeInto('fresh step')
    await rest()
    await reads[3].answer(batch([]))
    await enter()
    expect(created).toHaveBeenCalledWith('fresh step')
  })

  it('picks the task a typed task ID names whatever the list’s end', async () => {
    await load()
    await show({ kind: 'link' })
    await typeInto('QN-45')
    await rest()
    await reads[1].answer(batch([row(45, { exact: true })], 'more'))
    await enter()
    expect(picks.mock.calls[0]?.[0]).toMatchObject({ uuid: 'task-45' })
  })

  it('reads one Load more at a time, says Loading… on its button, and adds the batch', async () => {
    await load()
    await show()
    await reads[0].answer(batch([row(1)], 'cursor-1'))
    expect(state()).toBe('ready')
    const more = document.querySelector<HTMLButtonElement>('[data-picker-more]')
    await click(more)
    await click(more)
    expect(reads.map((r) => r.args.cursor)).toEqual([undefined, 'cursor-1'])
    expect(state()).toBe('more')
    expect(more?.getAttribute('aria-disabled')).toBe('true')
    expect(more?.textContent).toBe('Loading…')
    await reads[1].answer(batch([row(2)]))
    expect(rowIds()).toEqual(['task-1', 'task-2'])
    expect(picker()?.dataset.pickerEnd).toBe('')
    expect(document.querySelector('[data-picker-more]')).toBeNull()
  })

  it('offers Retry after a failed first batch and after a failed Load more, keeping the rows', async () => {
    await load()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await show()
    await reads[0].fail()
    expect(state()).toBe('failed')
    expect(text()).toContain("Couldn't load tasks.")
    await click(button('Retry'))
    expect(reads).toHaveLength(2)
    await reads[1].answer(batch([row(1)], 'cursor-1'))
    await click(document.querySelector('[data-picker-more]'))
    await reads[2].fail()
    expect(text()).toContain("Couldn't load more tasks.")
    expect(rowIds()).toEqual(['task-1'])
    await click(button('Retry'))
    expect(reads[3].args.cursor).toBe('cursor-1')
  })

  it('says when Qivo checked part of the tasks, and asks for a search past 200 rows', async () => {
    await load()
    await show()
    await reads[0].answer(batch([], 'cursor-0', { stopped: true }))
    expect(document.querySelector('[data-picker-stopped]')?.textContent).toBe(
      'Qivo checked part of the tasks. Load more continues.',
    )
    // no claim of an empty list while the batch stopped
    expect(text()).not.toContain('No eligible tasks.')
    for (let b = 0; b < 8; b++) {
      await click(document.querySelector('[data-picker-more]'))
      await reads[b + 1].answer(
        batch(
          Array.from({ length: 25 }, (_, n) => row(100 + b * 25 + n)),
          `cursor-${b + 1}`,
        ),
      )
    }
    expect(rowIds()).toHaveLength(200)
    expect(text()).toContain('Search to find more tasks.')
    expect(document.querySelector('[data-picker-more]')).toBeNull()
  })

  it('says No matching tasks only once the list ended, beside the create row', async () => {
    await load()
    await show()
    await reads[0].answer(batch([]))
    expect(text()).toContain('No eligible tasks.')
    await typeInto('zzz')
    await rest()
    // on its way: no word yet, and no create row
    expect(text()).not.toContain('No matching tasks.')
    expect(document.querySelector('[data-picker-create]')).toBeNull()
    await reads[1].answer(batch([], 'cursor-1'))
    expect(text()).not.toContain('No matching tasks.')
    await click(document.querySelector('[data-picker-more]'))
    await reads[2].answer(batch([]))
    expect(text()).toContain('No matching tasks.')
    expect(document.querySelector('[data-picker-create]')?.textContent).toContain('“zzz”')
  })

  it('goes on into all your projects only when the person chooses it', async () => {
    await load()
    await show({ kind: 'link' })
    await typeInto('rare')
    await rest()
    await reads[1].answer(batch([], null, { all_projects: 'all-1' }))
    expect(text()).toContain('No matching tasks in this project.')
    expect(text()).not.toContain('No matching tasks.')
    expect(reads).toHaveLength(2)
    await click(document.querySelector('[data-picker-all]'))
    expect(reads[2].args).toMatchObject({ kind: 'link', search: 'rare', cursor: 'all-1' })
    await reads[2].answer(batch([row(70, { title: 'A rare part' })]))
    expect(rowIds()).toEqual(['task-70'])
  })

  it('claims no end and creates nothing on Enter while the current relations are not whole', async () => {
    await load()
    await show({ note: 'Loading the current subtasks…' })
    await reads[0].answer(batch([]))
    expect(text()).not.toContain('No eligible tasks.')
    await typeInto('mount the board')
    await rest()
    await reads[1].answer(batch([]))
    // the note says why, in place of a claim that nothing matches
    expect(text()).toContain('Loading the current subtasks…')
    expect(text()).not.toContain('No matching tasks.')
    expect(picker()?.dataset.pickerEnd).toBeUndefined()
    await enter()
    expect(created).not.toHaveBeenCalled()
    // the same at the family's end of Linked tasks
    await hide()
    await load()
    await show({ kind: 'link', note: 'Some current linked tasks could not be loaded.' })
    await typeInto('wire')
    await rest()
    await reads[1].answer(batch([], null, { all_projects: 'all-1' }))
    expect(text()).not.toContain('No matching tasks in this project.')
    await enter()
    expect(created).not.toHaveBeenCalled()
    // a typed task ID still picks the task the server found by its number
    await typeInto('QN-45')
    await rest()
    await reads[2].answer(batch([row(45, { exact: true })], 'more'))
    await enter()
    expect(picks.mock.calls[0]?.[0]).toMatchObject({ uuid: 'task-45' })
    // once whole, the list ends
    await show({ kind: 'link', note: null })
    expect(picker()?.dataset.pickerEnd).toBeUndefined()
    await typeInto('wire')
    await rest()
    await reads[3].answer(batch([]))
    expect(picker()?.dataset.pickerEnd).toBe('')
    expect(text()).toContain('No matching tasks.')
  })

  it('shows the current rows checked and takes no press while their removal waits', async () => {
    await load()
    await show({
      kind: 'link',
      current: [{ ...relation(45, 'Mount the board'), type: 'blocks' }],
      note: 'Some current linked tasks could not be loaded.',
      locked: true,
    })
    await reads[0].answer(batch([row(46)]))
    expect(rowIds()).toEqual(['task-45', 'task-46'])
    const locked = rowOf('task-45') as HTMLButtonElement | null
    expect(locked?.getAttribute('aria-pressed')).toBe('true')
    expect(locked?.disabled).toBe(true)
    await click(locked)
    expect(picks).not.toHaveBeenCalled()
    // a candidate still takes its pick
    await click(rowOf('task-46'))
    expect(picks.mock.calls[0]?.[0]).toMatchObject({ uuid: 'task-46' })
  })

  it('reads the list again from its start once the task moves to another project', async () => {
    await load()
    await show({ kind: 'link' })
    await reads[0].answer(batch([row(1)], 'cursor-1'))
    expect(rowIds()).toEqual(['task-1'])
    // the server refuses a cursor read before the move, so the list starts
    // again rather than asking with it
    await show({ kind: 'link', task: { ...TASK, project: 'bench' } })
    expect(reads).toHaveLength(2)
    expect(reads[1].args).toEqual({ org_id: TASK.org, issue_id: TASK.uuid, kind: 'link' })
    expect(state()).toBe('loading')
    await reads[1].answer(batch([row(2)]))
    expect(rowIds()).toEqual(['task-2'])
  })

  it('shows the search limit’s sentence and reads nothing for a longer text, and the create rules', async () => {
    await load()
    await show()
    await reads[0].answer(batch([row(1, { title: 'Order parts' })]))
    await typeInto('x'.repeat(LIMITS.search.max + 1))
    await rest()
    expect(reads).toHaveLength(1)
    expect(text()).toContain(limitSentence(LIMITS.search))
    expect(rowIds()).toEqual([])
    // a title may be longer than a search
    expect(document.querySelector('[data-picker-create]')).not.toBeNull()
    await typeInto('x'.repeat(LIMITS.title.max + 1))
    expect(document.querySelector('[data-picker-refusal]')?.textContent).toBe(
      limitSentence(LIMITS.title),
    )
    // a row of the current text with exactly that title hides the create row
    await typeInto('order parts')
    await rest()
    await reads[1].answer(batch([row(1, { title: 'Order parts' })]))
    expect(document.querySelector('[data-picker-create]')).toBeNull()
    await typeInto('order')
    await rest()
    await reads[2].answer(batch([row(1, { title: 'Order parts' })]))
    expect(document.querySelector('[data-picker-create]')).not.toBeNull()
  })

  it('lists the window’s current relations first, once each, matched by the text', async () => {
    await load()
    await show({
      current: [relation(45, 'Mount the board')],
      note: 'Loading the current subtasks…',
    })
    await reads[0].answer(batch([row(45), row(46)]))
    expect(rowIds()).toEqual(['task-45', 'task-46'])
    expect(rowOf('task-45')?.dataset.pickerCurrent).toBe('')
    expect(rowOf('task-45')?.getAttribute('aria-pressed')).toBe('true')
    expect(rowOf('task-46')?.getAttribute('aria-pressed')).toBe('false')
    expect(text()).toContain('Loading the current subtasks…')
    await typeInto('order')
    expect(rowIds()).toEqual([])
    await typeInto('board')
    expect(rowIds()).toEqual(['task-45'])
  })

  it('toggles a pick at once, busy until its write answers, back on a refusal, and sends what the row now shows', async () => {
    await load()
    let settle: (ok: boolean) => void = () => {}
    await show({ toggle: () => new Promise<boolean>((resolve) => (settle = resolve)) })
    await reads[0].answer(batch([row(46, { parent_id: 'old' })]))
    await click(rowOf('task-46'))
    expect(rowOf('task-46')?.getAttribute('aria-pressed')).toBe('true')
    expect(rowOf('task-46')?.dataset.pickerBusy).toBe('')
    // a second press while busy sends nothing
    await click(rowOf('task-46'))
    expect(picks).toHaveBeenCalledTimes(1)
    await act(async () => settle(false))
    expect(rowOf('task-46')?.getAttribute('aria-pressed')).toBe('false')
    expect(rowOf('task-46')?.dataset.pickerBusy).toBeUndefined()
    await click(rowOf('task-46'))
    await act(async () => settle(true))
    expect(rowOf('task-46')?.getAttribute('aria-pressed')).toBe('true')
    // the next press takes it off with the open task as the parent it shows
    await click(rowOf('task-46'))
    expect(picks.mock.calls.at(-1)?.slice(1)).toEqual([
      false,
      { on: true, busy: false, parent: { id: TASK.uuid, hidden: false }, link: null },
    ])
  })

  it('drops an answer once the picker closed', async () => {
    await load()
    await show()
    await hide()
    await show()
    expect(reads).toHaveLength(2)
    await reads[0].answer(batch([row(1)]))
    expect(rowIds()).toEqual([])
    expect(state()).toBe('loading')
  })

  it('says each answer that lists nothing in its own sentence, with no create row beside a block', async () => {
    const cases: [RelationKind, unknown, string, string][] = [
      ['subtask', { state: 'unavailable' }, 'unavailable', 'Qivo cannot list tasks for this task.'],
      [
        'subtask',
        { state: 'unavailable', reason: 'access_unchecked', message: 'qivo could not check this' },
        'unavailable',
        'Qivo could not check this.',
      ],
      ['parent', { state: 'refused', message: 'no write access' }, 'refused', 'No write access.'],
      [
        'link',
        { state: 'over_budget' },
        'over_budget',
        "Qivo could not list tasks here within the picker's limits.",
      ],
      [
        'subtask',
        batch([], null, { blocked: 'full' }),
        'ready',
        subtaskBlock({ id: '', org: '', project: '', children: Array(100).fill('x') }) ?? '',
      ],
      [
        'subtask',
        batch([], null, { blocked: 'is_subtask' }),
        'ready',
        'A subtask cannot have subtasks',
      ],
      [
        'parent',
        batch([], null, { blocked: 'has_subtasks' }),
        'ready',
        parentBlock({ id: '', org: '', project: '', hasHiddenSubtasks: true }) ?? '',
      ],
      [
        'link',
        batch([], null, { blocked: 'full' }),
        'ready',
        linkBlock(Array(LIMITS.links.max)) ?? '',
      ],
    ]
    for (const [kind, answer, mark, sentence] of cases) {
      await load()
      await show({ kind })
      await typeInto('new task')
      await rest()
      await reads[1].answer(answer)
      expect(state(), sentence).toBe(mark)
      expect(text(), sentence).toContain(sentence)
      expect(document.querySelector('[data-picker-create]'), sentence).toBeNull()
      await hide()
    }
    // a search the server refuses says the server's sentence
    await load()
    await show()
    await typeInto('stale')
    await rest()
    await reads[1].refuse('bad_request', 'This list changed. Search again to go on.')
    expect(state()).toBe('refused')
    expect(text()).toContain('This list changed. Search again to go on.')
  })

  it('fits a phone: the popup takes the width less its gutters', async () => {
    await load()
    vi.stubGlobal('innerWidth', 320)
    await show()
    const surface = picker()?.closest<HTMLElement>('[data-floating-surface]')
    expect(surface?.style.width).toBe('296px')
  })
})
