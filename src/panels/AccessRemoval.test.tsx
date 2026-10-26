// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { BILLING_READ_ONLY } from '../../convex/lib/billingAccess'
import { TooltipProvider } from '../components/ui/tooltip'
import { CONFIRM_IGNORE_MS } from '../lib/useConfirmArm'
import type { AccessRemoval } from '../store/planner'
import { plannerFixture } from '../store/plannerFixture.setup'

/* The removal window on the real store, fed one snapshot. The signed-in
   Planner is an organization admin; Leo edits the project and is assigned
   to one open task in it. billing.status answers `writable`. The network
   records each write and, as the server does for an admin, refuses every
   removal but one that leaves the tasks with `refusal` when one is set. */

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

const AT = '2026-09-14T08:00:00.000Z'
const READ_ONLY = new ConvexError({
  code: 'forbidden',
  reason: 'billing_required',
  message: 'This organization is read-only.',
})

let P: Planner
let snap: ReturnType<typeof plannerFixture>
let deliver: (snapshot: ReturnType<typeof plannerFixture>) => void
let container: HTMLDivElement
let root: Root
let work: string
let writable: boolean
let status: () => void
let refusal: unknown

/* `lead` signs the Planner in as the project's lead who is not an
   organization admin, which the server refuses every removal while the
   organization is read-only. `tasks` is how many open tasks Leo holds, and
   `level` his grant. With `viaTeam`, Leo's grant comes from the Crew team,
   one of two teams, instead. With `ada`, Ada Berg, who holds no task, has a
   User grant of her own. */
async function load({
  lead = false,
  tasks = 1,
  level = 'user',
  viaTeam = false,
  ada = false,
}: {
  lead?: boolean
  tasks?: number
  level?: 'user' | 'viewer'
  viaTeam?: boolean
  ada?: boolean
} = {}) {
  vi.resetModules()
  snap = plannerFixture()
  const org = snap.orgs[0].id
  work = snap.projects[0].id
  snap.projects[0].type = 'meta'
  if (lead) {
    snap.profiles[0].org_role = 'user'
    snap.projects[0].lead_id = snap.profiles[0].id
  }
  snap.profiles.push({
    ...snap.profiles[0],
    id: 'leo',
    auth_user_id: 'account-leo',
    name: 'Leo Berg',
    org_role: 'user',
  })
  if (viaTeam) {
    for (const id of ['crew', 'bench'])
      snap.teams.push({
        id,
        org_id: org,
        name: id === 'crew' ? 'Crew' : 'Bench',
        track_delay_default: false,
        created_at: AT,
      })
    snap.teamMembers.push({ team_id: 'crew', profile_id: 'leo', is_leader: false })
    snap.teamAccess.push({ project_id: work, team_id: 'crew', level })
  } else snap.access.push({ project_id: work, profile_id: 'leo', level })
  if (ada) {
    snap.profiles.push({
      ...snap.profiles[0],
      id: 'ada',
      auth_user_id: 'account-ada',
      name: 'Ada Berg',
      org_role: 'user',
    })
    snap.access.push({ project_id: work, profile_id: 'ada', level: 'user' })
  }
  for (let n = 1; n <= tasks; n++)
    snap.issues.push({
      id: `t${n}`,
      org_id: org,
      project_id: work,
      num: n,
      title: n === 1 ? 'Ship it' : `Task ${n}`,
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
    if (name === 'workspace:whole') {
      deliver = (snapshot) => next(structuredClone(snapshot))
      deliver(snap)
    }
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

/* Opens the window for removing Leo from the project, as project settings
   do, or for another `change`. */
async function open(change: AccessRemoval = { kind: 'userGrant', projectId: work, userId: 'leo' }) {
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

  it('closes after the server refuses a lead who is not an admin, and refuses the next removal up front', async () => {
    await load({ lead: true })
    const onClose = await open()
    refusal = READ_ONLY
    await submit()
    expect(onClose).toHaveBeenCalled()
    expect(writes()).toEqual([['projects:removeAccess', 'keep_as_viewer']])
    expect(window.showToast).toHaveBeenLastCalledWith(
      'This organization is read-only. Change reverted.',
      'error',
    )
    expect(P.startRemoval({ kind: 'userGrant', projectId: work, userId: 'leo' })).toBe(false)
    expect(window.showToast).toHaveBeenLastCalledWith('This organization is read-only.', 'error')
    expect(writes()).toHaveLength(1)
    expect(P.levelOn(work, 'leo')).toBe('user')
  })

  it('closes with the read-only sentence when billing.status turns read-only for a lead who is not an admin', async () => {
    await load({ lead: true })
    const onClose = await open()
    writable = false
    status()
    await submit()
    expect(onClose).toHaveBeenCalled()
    expect(writes()).toEqual([])
    expect(window.showToast).toHaveBeenCalledTimes(1)
    expect(window.showToast).toHaveBeenLastCalledWith(BILLING_READ_ONLY, 'error')
    expect(P.levelOn(work, 'leo')).toBe('user')
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

describe('the removal window on a phone', () => {
  it('keeps its Back step through a Cancel pressed while it saves, and Back closes it after a refused save', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    )
    // the page's history and the layers' listener, as main.tsx and App add them
    const pageHistory = await import('../lib/pageHistory')
    const removeHistory = pageHistory.installPageHistory()
    onTestFinished(pageHistory.listenBackLayers())
    onTestFinished(removeHistory)
    history.pushState(null, '', '/before')
    history.pushState(null, '', '/settings')
    let refuse = (_: unknown) => {}
    network.mutation.mockImplementation((_ref, args) =>
      args.on_held_tasks === undefined
        ? Promise.resolve(null)
        : new Promise((_, reject) => {
            refuse = reject
          }),
    )
    const onClose = await open()
    expect(history.state?.qivoLayer).toBeTruthy()
    await submit()
    // Cancel while the removal saves is refused, and the Back step stays
    const cancel = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-modal-shell] button'),
    ].find((b) => b.textContent === 'Cancel')
    await act(async () => cancel?.click())
    await settle()
    expect(onClose).not.toHaveBeenCalled()
    expect(history.state?.qivoLayer).toBeTruthy()
    // the server refuses for another reason, so the window stays open
    await act(async () =>
      refuse(new ConvexError({ code: 'rule', message: 'refused', reason: 'held_tasks' })),
    )
    await settle()
    expect(document.querySelector('[data-access-removal]')).toBeTruthy()
    // and Back closes the window, not the page
    await act(async () => {
      history.back()
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    await settle()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(location.pathname).toBe('/settings')
  })
})

describe('the reassign cap in the removal window', () => {
  const reassignCard = () =>
    [...document.querySelectorAll('[data-access-removal] label')].at(-1)?.textContent ?? ''

  it('says so when it lists more tasks than one removal reassigns', async () => {
    await load({ tasks: 121 })
    await open()
    expect(reassignCard()).toContain(
      'One removal reassigns at most 120 tasks, so keep Leo as a Viewer or reassign some of these tasks first.',
    )
  })

  it('says nothing of the cap at the cap', async () => {
    await load({ tasks: 120 })
    await open()
    expect(reassignCard()).toContain('Reviewer roles move to the same person.')
    expect(reassignCard()).not.toContain('at most')
  })

  it('says so when deleting a team, which settles its tasks in the same write', async () => {
    await load({ tasks: 121, viaTeam: true })
    await open({ kind: 'deleteTeam', teamId: 'crew' })
    expect(document.querySelector('[data-access-removal]')?.textContent).toContain('121 tasks')
    expect(reassignCard()).toContain(
      'One removal reassigns at most 120 tasks, so keep Leo as a Viewer or reassign some of these tasks first.',
    )
  })

  it('offers only reassigning some tasks first when the grant is already Viewer', async () => {
    await load({ tasks: 121, level: 'viewer' })
    await open()
    expect(reassignCard()).toContain(
      'One removal reassigns at most 120 tasks, so reassign some of these tasks first.',
    )
  })
})

describe('focus once the removal window closes', () => {
  /* Renders `page` on the live store, as Settings does. */
  async function show(page: () => React.ReactNode) {
    const version = await import('../store/usePlannerVersion')
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
  const press = async (button: HTMLButtonElement | null | undefined) => {
    if (!button) throw new Error('Missing button')
    button.focus()
    await act(async () => button.click())
    await settle()
  }
  const shellButton = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[data-modal-shell] button')].find(
      (b) => b.textContent === label,
    )
  const remove = (id: string) =>
    document.querySelector<HTMLButtonElement>(
      `[data-project-access-user="${id}"] [data-project-access-remove]`,
    )
  async function projectPage() {
    const settings = await import('./settings/ProjectSettings')
    await show(() => <settings.ProjectPage projectId={work} setPage={vi.fn()} />)
  }

  it("gives focus to the row's own Remove after Change to Viewer, and to the next row's once the row leaves", async () => {
    await load({ ada: true })
    await projectPage()
    await press(remove('leo'))
    await press(shellButton('Change to Viewer'))
    expect(document.querySelector('[data-modal-shell]')).toBeNull()
    expect(P.levelOn(work, 'leo')).toBe('viewer')
    expect(document.activeElement).toBe(remove('leo'))
    // Ada is listed before Leo, so she is the row before his
    await press(remove('leo'))
    await press(shellButton('Reassign and remove'))
    expect(document.querySelector('[data-modal-shell]')).toBeNull()
    expect(remove('leo')).toBeNull()
    expect(document.activeElement).toBe(remove('ada'))
  })

  it('gives focus to the empty list once someone else removed the access meanwhile', async () => {
    await load()
    await projectPage()
    await press(remove('leo'))
    snap.access = snap.access.filter((a) => a.profile_id !== 'leo')
    await act(async () => deliver({ ...snap, delivered_at: '2026-09-15T09:00:00.000Z' }))
    await press(shellButton('Change to Viewer'))
    expect(window.showToast).toHaveBeenCalledWith(
      'Leo Berg no longer has this access. Nothing was changed.',
      'info',
    )
    expect(document.querySelector('[data-modal-shell]')).toBeNull()
    expect(document.activeElement?.textContent).toBe('No individual users added.')
  })

  it.each([
    [
      "a person's grant",
      { ada: true },
      async () => {
        await projectPage()
        return { press: remove('leo'), left: () => remove('leo'), next: () => remove('ada') }
      },
    ],
    [
      'a team member',
      { viaTeam: true },
      async () => {
        const settings = await import('./settings/TeamSettings')
        await show(() => <settings.TeamPage teamId="crew" setPage={vi.fn()} />)
        const row = '[data-settings-team-member="leo"]'
        return {
          press: document.querySelector<HTMLButtonElement>(`${row} [data-team-member-remove]`),
          left: () => document.querySelector(row),
          next: () => document.querySelector('[data-team-members-none]'),
        }
      },
    ],
    [
      'a team',
      { viaTeam: true },
      async () => {
        const settings = await import('./settings/TeamSettings')
        await show(() => <settings.OrgTeamsPage setPage={vi.fn()} />)
        return {
          press: document.querySelector<HTMLButtonElement>(
            '[data-team-row="crew"] [data-team-delete]',
          ),
          left: () => document.querySelector('[data-team-row="crew"]'),
          next: () => document.querySelector('[data-team-row="bench"] [data-team-open]'),
        }
      },
    ],
  ])(
    'gives focus to the same targets when removing %s needs no window',
    async (_, options, open) => {
      // nobody holds a task, so nothing asks first
      await load({ ...options, tasks: 0 })
      vi.useFakeTimers({ toFake: ['Date'] })
      onTestFinished(() => {
        vi.useRealTimers()
      })
      const { press: button, left, next } = await open()
      await press(button)
      // a member's Remove and a team's Delete ask for a second click
      if (left()) {
        vi.setSystemTime(Date.now() + CONFIRM_IGNORE_MS)
        await press(button)
      }
      expect(document.querySelector('[data-modal-shell]')).toBeNull()
      expect(left()).toBeNull()
      expect(document.activeElement).toBe(next())
    },
  )

  it("gives focus to the empty list's line once the last member leaves a team", async () => {
    await load({ viaTeam: true })
    vi.useFakeTimers({ toFake: ['Date'] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const settings = await import('./settings/TeamSettings')
    await show(() => <settings.TeamPage teamId="crew" setPage={vi.fn()} />)
    const leave = document.querySelector<HTMLButtonElement>(
      '[data-settings-team-member="leo"] [data-team-member-remove]',
    )
    await press(leave)
    vi.setSystemTime(Date.now() + CONFIRM_IGNORE_MS)
    await press(leave)
    await press(shellButton('Keep as Viewer and remove'))
    expect(document.querySelector('[data-modal-shell]')).toBeNull()
    expect(document.querySelector('[data-settings-team-member="leo"]')).toBeNull()
    expect(document.activeElement?.textContent).toBe('No members yet.')
  })

  it("gives focus to the next team's name once a deleted team leaves, as the last team's Delete is disabled", async () => {
    await load({ viaTeam: true })
    vi.useFakeTimers({ toFake: ['Date'] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const settings = await import('./settings/TeamSettings')
    await show(() => <settings.OrgTeamsPage setPage={vi.fn()} />)
    const del = document.querySelector<HTMLButtonElement>(
      '[data-team-row="crew"] [data-team-delete]',
    )
    await press(del)
    vi.setSystemTime(Date.now() + CONFIRM_IGNORE_MS)
    await press(del)
    await press(shellButton('Keep as Viewer and delete'))
    expect(document.querySelector('[data-modal-shell]')).toBeNull()
    expect(document.querySelector('[data-team-row="crew"]')).toBeNull()
    expect(document.querySelector('[data-team-row="bench"] [data-team-delete]')).toHaveProperty(
      'disabled',
      true,
    )
    expect(document.activeElement).toBe(
      document.querySelector('[data-team-row="bench"] [data-team-open]'),
    )
  })
})
