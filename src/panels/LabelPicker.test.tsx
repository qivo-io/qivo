// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The label picker on the real store, in an organization without labels:
   Enter creates the typed label and puts it on the task. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

type Planner = typeof import('../store/planner')['P']
type Detail = typeof import('./IssueDetail')

const NOW = '2026-09-14T08:00:00.000Z'

let P: Planner
let detail: Detail
let container: HTMLDivElement
let root: Root
/* How the server answers each mutation by name; unlisted ones resolve null. */
let answers: Record<string, () => Promise<unknown>>
let sent: string[]

beforeEach(async () => {
  vi.resetModules()
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
  const snap: Snapshot = plannerFixture()
  snap.issues.push({
    id: crypto.randomUUID(),
    org_id: snap.orgs[0].id,
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
  network.query.mockResolvedValue(null)
  network.onUpdate.mockImplementation((ref, _args, next) => {
    if (getFunctionName(ref) === 'snapshot:forMe') next(structuredClone(snap))
    return () => {}
  })
  network.mutation.mockImplementation((ref) => {
    const name = getFunctionName(ref)
    sent.push(name)
    const answer = answers[name]
    return answer ? answer() : Promise.resolve(null)
  })
  const store = await import('../store/planner')
  P = store.P
  await store.initStore()
  detail = await import('./IssueDetail')
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

/* Opens the picker for the task and returns its search field. */
async function open(): Promise<HTMLInputElement> {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <detail.LabelPickerPopup it={task()} anchor={{ x: 0, y: 0 }} onDone={vi.fn()} />
      </TooltipProvider>,
    ),
  )
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Add labels…"]')
  if (!input) throw new Error('no search field')
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

const enter = (input: HTMLInputElement) =>
  act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })

describe('the label picker', () => {
  it('ignores a second Enter in the emptied field after creating the first label', async () => {
    const input = await open()
    await type(input, 'Bench')
    await enter(input)
    expect(input.value).toBe('')
    expect(P.labels.map((l) => l.name)).toEqual(['Bench'])
    await enter(input)
    expect(sent.filter((name) => name === 'labels:toggle')).toHaveLength(1)
    expect(task().labels).toEqual([P.labels[0].id])
  })

  it('still picks the one label a typed search matches', async () => {
    const input = await open()
    await type(input, 'Bench')
    await enter(input)
    await type(input, 'ben')
    await enter(input)
    expect(sent.filter((name) => name === 'labels:toggle')).toHaveLength(2)
    expect(task().labels).toEqual([])
  })

  it('toasts only the refused create, not the attach the server refuses with it', async () => {
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
    await type(input, 'Bench')
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
    answers['labels:toggle'] = () =>
      Promise.reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    const input = await open()
    await type(input, 'Bench')
    await enter(input)
    expect(vi.mocked(window.showToast).mock.calls).toEqual([
      ["You don't have permission for that. Change reverted.", 'error'],
    ])
  })
})
