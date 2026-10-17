// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The Move window on the real store. WEB holds the FE and BE sub-projects,
   HW holds FW. The open task has no subtask in this view, as when its only
   subtasks are archived, so the dialog asks the server whether a move to
   another top-level project carries any. */

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
type Modals = typeof import('./Modals')

const NOW = '2026-09-14T08:00:00.000Z'
const NOTE = 'Its subtasks move with it, archived ones included.'

let P: Planner
let dialogs: Modals
let container: HTMLDivElement
let root: Root
let ids: Record<'be' | 'fw', string>
/* The server's answer to moveCarriesSubtasks, and the arguments it was asked with. */
let carries: boolean
let asked: Record<string, unknown>[]

async function load() {
  vi.resetModules()
  const snap: Snapshot = plannerFixture()
  const org = snap.orgs[0].id
  const base = snap.projects[0]
  const project = (key: string, num: number, extra = {}) => ({
    ...base,
    id: crypto.randomUUID(),
    key,
    num,
    name: key,
    ...extra,
  })
  const web = project('WEB', 1, { type: 'meta' as const })
  const hw = project('HW', 2, { type: 'meta' as const })
  const fe = project('FE', 3, { parent_id: web.id })
  const be = project('BE', 4, { parent_id: web.id })
  const fw = project('FW', 5, { parent_id: hw.id })
  snap.projects = [web, hw, fe, be, fw]
  ids = { be: be.id, fw: fw.id }
  snap.issues.push({
    id: 'lone',
    org_id: org,
    project_id: fe.id,
    num: 1,
    title: 'Lone task',
    description: '',
    status: 'todo',
    priority: 'low',
    paused: false,
    created_at: NOW,
    updated_at: NOW,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  network.onUpdate.mockImplementation((ref, _args, next) => {
    if (getFunctionName(ref) === 'snapshot:forMe') next(structuredClone(snap))
    return () => {}
  })
  network.query.mockImplementation((ref, args) => {
    if (getFunctionName(ref) !== 'issues:moveCarriesSubtasks') return Promise.resolve(null)
    asked.push(args)
    return Promise.resolve(carries)
  })
  network.mutation.mockImplementation((ref) => {
    if (getFunctionName(ref) === 'identity:claimMySeats') return Promise.resolve(null)
    return new Promise(() => {})
  })
  const store = await import('../store/planner')
  P = store.P
  await store.initStore()
  dialogs = await import('./Modals')
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  window.showToast = vi.fn()
  asked = []
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function openFor(key: string) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <dialogs.MoveIssueModal issueId={key} onClose={vi.fn()} onMove={vi.fn()} />
      </TooltipProvider>,
    ),
  )
}

async function chooseTarget(projectId: string) {
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Move to"]')
  if (!select) throw new Error('Missing the Move to select')
  await act(async () => {
    select.value = projectId
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const notes = () => [...document.querySelectorAll('[data-move-note]')].map((n) => n.textContent)

describe('Move window', () => {
  it('says the subtasks move when the server knows of ones this view lacks', async () => {
    carries = true
    await load()
    const lone = P.issues.find((it) => it.uuid === 'lone')!
    await openFor(lone.id)
    await chooseTarget(ids.fw)
    expect(notes()).toEqual([NOTE])
    expect(asked).toEqual([{ org_id: lone.org, id: 'lone', project_id: ids.fw }])
  })

  it('says nothing when none would move, and asks only across top-level projects', async () => {
    carries = false
    await load()
    const lone = P.issues.find((it) => it.uuid === 'lone')!
    await openFor(lone.id)
    await chooseTarget(ids.fw)
    expect(notes()).toEqual([])
    await chooseTarget(ids.be)
    expect(notes()).toEqual([])
    expect(asked.map((a) => a.project_id)).toEqual([ids.fw])
  })
})
