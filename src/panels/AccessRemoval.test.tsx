// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture } from '../store/plannerFixture.setup'

/* The removal window on the real store, fed one snapshot. The signed-in
   Planner is an organization admin; Leo edits the project and is assigned
   to one open task in it. billing.status answers `writable`. The network
   records each write and, as the server does for an admin, refuses every
   removal but one that leaves the tasks with `refusal` when one is set. */

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

const AT = '2026-09-14T08:00:00.000Z'
const READ_ONLY = new ConvexError({
  code: 'forbidden',
  reason: 'billing_required',
  message: 'This organization is read-only.',
})

let P: Planner
let container: HTMLDivElement
let root: Root
let work: string
let writable: boolean
let status: () => void
let refusal: unknown

async function load() {
  vi.resetModules()
  const snap = plannerFixture()
  const org = snap.orgs[0].id
  work = snap.projects[0].id
  snap.projects[0].type = 'meta'
  snap.profiles.push({
    ...snap.profiles[0],
    id: 'leo',
    auth_user_id: 'account-leo',
    name: 'Leo Berg',
    org_role: 'user',
  })
  snap.access.push({ project_id: work, profile_id: 'leo', level: 'user' })
  snap.issues.push({
    id: 't1',
    org_id: org,
    project_id: work,
    num: 1,
    title: 'Ship it',
    description: '',
    status: 'todo',
    priority: 'low',
    paused: false,
    assignee_id: 'leo',
    created_at: AT,
    updated_at: AT,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  network.query.mockResolvedValue(null)
  network.onUpdate.mockImplementation((ref, _args, next) => {
    const name = getFunctionName(ref)
    if (name === 'snapshot:forMe') next(structuredClone(snap))
    if (name === 'billing:status') {
      status = () => next({ writable })
      status()
    }
    return () => {}
  })
  network.mutation.mockImplementation((_ref, args) =>
    refusal && args.on_held_tasks !== undefined && args.on_held_tasks !== 'leave'
      ? Promise.reject(refusal)
      : Promise.resolve(null),
  )
  const store = await import('../store/planner')
  P = store.P
  await store.initStore()
  // as the settings pages that start removals do
  P.watchWriteBlock(org)
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
  vi.spyOn(console, 'error').mockImplementation(() => {})
  window.showToast = vi.fn()
  writable = true
  refusal = null
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
  network.mutation.mockReset()
  network.query.mockReset()
  network.onUpdate.mockReset()
})

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}
const writes = () =>
  network.mutation.mock.calls
    .map(([ref, args]) => [getFunctionName(ref), args.on_held_tasks])
    .filter(([name]) => name !== 'identity:claimMySeats')
const submit = async () => {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>('[data-modal-shell] button'),
  ].find((b) => b.textContent === 'Change to Viewer')
  if (!button) throw new Error('Missing Change to Viewer')
  await act(async () => button.click())
  await settle()
}

/* Opens the window for removing Leo from the project, as project settings do. */
async function open() {
  const change = { kind: 'userGrant', projectId: work, userId: 'leo' } as const
  expect(P.startRemoval(change)).toBe(true)
  const dialogs = await import('./Modals')
  const onClose = vi.fn()
  await act(async () =>
    root.render(
      <TooltipProvider>
        <dialogs.AccessRemovalModal change={change} onClose={onClose} />
      </TooltipProvider>,
    ),
  )
  await settle()
  return onClose
}

const NOTICE =
  'Leo Berg can no longer see a task they are assigned to or reviewing. A project lead can reassign it.'

describe('the removal window when the organization turns read-only', () => {
  it('removes and leaves the tasks after the server refuses a choice as read-only', async () => {
    const onClose = await open()
    // access ended at a set time, which billing.status has not said yet
    refusal = READ_ONLY
    await submit()
    expect(onClose).toHaveBeenCalled()
    expect(writes()).toEqual([
      ['projects:removeAccess', 'keep_as_viewer'],
      ['projects:removeAccess', 'leave'],
    ])
    expect(window.showToast).toHaveBeenCalledWith(
      'This organization is read-only. Change reverted.',
      'error',
    )
    expect(window.showToast).toHaveBeenLastCalledWith(NOTICE, 'info')
    expect(P.levelOn(work, 'leo')).toBeNull()
  })

  it('removes and leaves the tasks when billing.status turns read-only while it is open', async () => {
    const onClose = await open()
    writable = false
    status()
    await submit()
    expect(onClose).toHaveBeenCalled()
    expect(writes()).toEqual([['projects:removeAccess', 'leave']])
    expect(window.showToast).toHaveBeenLastCalledWith(NOTICE, 'info')
    expect(P.levelOn(work, 'leo')).toBeNull()
  })

  it('stays open with its list after a refusal for any other reason', async () => {
    const onClose = await open()
    refusal = new ConvexError({ code: 'rule', message: 'refused', reason: 'held_tasks' })
    await submit()
    expect(onClose).not.toHaveBeenCalled()
    expect(writes()).toEqual([['projects:removeAccess', 'keep_as_viewer']])
    expect(document.querySelector('[data-access-removal]')?.textContent).toContain('Ship it')
  })
})
