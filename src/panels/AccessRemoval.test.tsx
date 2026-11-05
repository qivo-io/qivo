// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { CONFIRM_IGNORE_MS } from '../lib/useConfirmArm'
import type { AccessRemoval, ReassignChoices, RemovalAnswer } from '../store/planner'
import { plannerFixture } from '../store/plannerFixture.setup'

/* The removal window and its press on the real store, fed one snapshot.
   The signed-in Planner is an organization admin; Leo edits the project and
   is assigned to one open task in it. The network double answers the
   server's preview (accessRemovals.preview) with `preview`, its Reassign
   picker (accessRemovals.reassignChoices) with `choices`, and records each
   read and write; a write is refused with `refusal` when one is set. */

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
type Args = Record<string, unknown>

const AT = '2026-09-14T08:00:00.000Z'
const UNCHECKED = "Couldn't check which tasks this removal affects. Nothing was removed."

let P: Planner
let snap: ReturnType<typeof plannerFixture>
let deliver: (snapshot: ReturnType<typeof plannerFixture>) => void
let container: HTMLDivElement
let root: Root
let work: string
let refusal: unknown
// what the server's two reads answer, by their arguments
let preview: (args: Args) => Promise<unknown>
let choices: (args: Args) => Promise<unknown>

/** A preview the server answers (accessRemovals.preview), from its own
    type: Leo loses sight of his task in Work, both choices allowed,
    unless `o` says otherwise. */
function answer(
  o: Partial<Omit<RemovalAnswer, 'keep' | 'reassign'>> & {
    keep?: Partial<RemovalAnswer['keep']>
    reassign?: Partial<RemovalAnswer['reassign']>
  } = {},
): RemovalAnswer {
  const { keep, reassign, ...rest } = o
  return {
    state: 'ok',
    pending: true,
    leave_only: false,
    people: [{ id: 'leo', name: 'Leo Berg', kind: 'person', org_role: 'user' }],
    tasks: 1,
    items: [
      {
        task_id: 't1',
        num: 1,
        title: 'Ship it',
        project_id: work,
        holder_id: 'leo',
        role: 'assignee',
      },
    ],
    items_total: 1,
    hidden: 0,
    projects: [{ id: work, name: 'Work', key: 'TEST', parent_id: null }],
    ...rest,
    keep: {
      targets: [work],
      changers: [],
      allowed: true,
      refusal: null,
      offered: true,
      permitted: true,
      ...keep,
    },
    reassign: { allowed: true, refusal: null, permitted: true, ...reassign },
  }
}

/** One batch of the Reassign picker, from the server's type. */
const batch = (names: string[], next: string | null = null, stopped = false): ReassignChoices => ({
  state: 'ready',
  rows: names.map((name) => ({
    id: name.toLowerCase().replace(/\W+/g, '-'),
    name,
    org_role: 'user',
    kind: 'person',
    active: true,
    pending: false,
  })),
  next,
  stopped,
})

/* `viaTeam` gives Leo his access through the Crew team, one of two teams,
   instead of a grant. With `ada`, Ada Berg, who holds no task, has a User
   grant of her own. */
async function load({ viaTeam = false, ada = false } = {}) {
  vi.resetModules()
  snap = plannerFixture()
  const org = snap.orgs[0].id
  work = snap.projects[0].id
  snap.projects[0].type = 'meta'
  snap.projects[0].name = 'Work'
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
    snap.teamAccess.push({ project_id: work, team_id: 'crew', level: 'user' })
  } else snap.access.push({ project_id: work, profile_id: 'leo', level: 'user' })
  if (ada) {
    snap.profiles.push({
      ...snap.profiles[0],
      id: 'ada-berg',
      auth_user_id: 'account-ada',
      name: 'Ada Berg',
      org_role: 'user',
    })
    snap.access.push({ project_id: work, profile_id: 'ada-berg', level: 'user' })
  }
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
  network.query.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'accessRemovals:preview') return preview(args)
    if (name === 'accessRemovals:reassignChoices') return choices(args)
    return Promise.resolve(null)
  })
  network.onUpdate.mockImplementation((ref, _args, next) => {
    if (getFunctionName(ref) === 'workspace:whole') {
      deliver = (snapshot) => next(structuredClone(snapshot))
      deliver(snap)
    }
    return () => {}
  })
  network.mutation.mockImplementation((_ref, args) =>
    refusal && args.on_held_tasks !== undefined ? Promise.reject(refusal) : Promise.resolve(null),
  )
  const store = await import('../store/planner')
  P = store.P
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
  vi.spyOn(console, 'error').mockImplementation(() => {})
  window.showToast = vi.fn()
  refusal = null
  preview = async () => answer()
  choices = async () => batch(['Ada Berg', 'Dan Berg'])
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
  for (let i = 0; i < 8; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}
/* Waits out the search delay (250 ms) and the read it sends. */
const rest = async () => {
  await act(async () => await new Promise((r) => setTimeout(r, 300)))
  await settle()
}
const writes = () =>
  network.mutation.mock.calls
    .map(([ref, args]) => [getFunctionName(ref), args.on_held_tasks])
    .filter(([name]) => name !== 'identity:claimMySeats')
const reads = (name: string) =>
  network.query.mock.calls.filter(([ref]) => getFunctionName(ref) === name).map(([, a]) => a)
function find<T extends Element = HTMLElement>(selector: string, scope: ParentNode = document) {
  const element = scope.querySelector<T>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}
const shellButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-modal-shell] button')].find(
    (b) => b.textContent === label,
  )
async function click(element: HTMLElement | null | undefined) {
  if (!element) throw new Error('Missing element')
  await act(async () => element.click())
  await settle()
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const windowText = () => document.querySelector('[data-access-removal]')?.textContent ?? ''
const pickerButton = () => find<HTMLButtonElement>('[data-reassign-to]')
const pickerNames = () =>
  [...document.querySelectorAll('[data-reassign-choice]')].map((b) => b.textContent)
const pickerText = () => document.querySelector('[data-reassign-people]')?.textContent ?? ''

const leoGrant = (): AccessRemoval => ({ kind: 'userGrant', projectId: work, userId: 'leo' })

/* Opens the window for removing Leo from the project with `shown`, as the
   press does once the preview asks, in a root of its own. */
async function open(shown: RemovalAnswer = answer(), change: AccessRemoval = leoGrant()) {
  const dialogs = await import('./Modals')
  const onClose = vi.fn()
  await act(async () => root.unmount())
  root = createRoot(container)
  await act(async () =>
    root.render(
      <TooltipProvider>
        <dialogs.AccessRemovalModal change={change} answer={shown} onClose={onClose} />
      </TooltipProvider>,
    ),
  )
  await settle()
  return onClose
}

describe('the removal window from the server preview', () => {
  it('shows the names, places and tasks of the answer, never the tasks the workspace holds', async () => {
    await open(
      answer({
        people: [
          { id: 'leo', name: 'Leo Berg', kind: 'person', org_role: 'user' },
          { id: 'ada-berg', name: 'Ada Berg', kind: 'person', org_role: 'user' },
        ],
        tasks: 2,
        items: [
          {
            task_id: 'x1',
            num: 41,
            title: 'Only on the server',
            project_id: work,
            holder_id: 'leo',
            role: 'assignee',
          },
          {
            task_id: 'x2',
            num: 42,
            title: 'Reviewed there',
            project_id: work,
            holder_id: 'ada-berg',
            role: 'reviewer',
          },
        ],
        items_total: 2,
      }),
    )
    expect(windowText()).toContain(
      'Leo Berg and Ada Berg are assigned to or reviewing 2 tasks in Work.',
    )
    const rows = [...document.querySelectorAll('[data-access-removal-task]')].map(
      (r) => r.textContent,
    )
    expect(rows).toEqual([
      'QN-41Only on the serverLeo, Assignee',
      'QN-42Reviewed thereAda, Reviewer',
    ])
    // the workspace's own task is not listed
    expect(windowText()).not.toContain('Ship it')
    expect(reads('accessRemovals:reassignChoices')).toEqual([])
  })

  it('says how many more tasks it does not list and how many it cannot show', async () => {
    const items = Array.from({ length: 120 }, (_, i) => ({
      task_id: `t${i}`,
      num: i + 1,
      title: `Task ${i}`,
      project_id: work,
      holder_id: 'leo',
      role: 'assignee' as const,
    }))
    await open(answer({ tasks: 127, hidden: 2, items, items_total: 125 }))
    expect(windowText()).toContain('and 5 more tasks')
    expect(find('[data-access-removal-hidden]').textContent).toBe(
      "2 tasks in projects you can't see",
    )
  })

  it('offers only Reassign for a removed Viewer grant', async () => {
    await open(
      answer({
        keep: {
          offered: false,
          allowed: false,
          refusal: 'a Viewer grant cannot be kept as Viewer; leave the tasks or reassign them',
        },
      }),
    )
    expect(document.querySelector('[data-access-removal-keep]')).toBeNull()
    expect(document.querySelector('[data-access-removal] input[type="radio"]')).toBeNull()
    expect(shellButton('Reassign and remove')?.disabled).toBe(false)
  })

  it("disables a choice the server refuses, with the server's sentence, and both with only Cancel", async () => {
    await open(
      answer({
        keep: { allowed: false, refusal: 'no permission to manage users on this project' },
      }),
    )
    const keep = find('[data-access-removal-keep]')
    expect(keep.textContent).toContain('No permission to manage users on this project.')
    expect(find<HTMLInputElement>('input', keep).disabled).toBe(true)
    // Reassign is chosen first
    expect(shellButton('Reassign and remove')?.disabled).toBe(false)
    await open(
      answer({
        keep: { allowed: false, refusal: 'no permission to manage users on this project' },
        reassign: {
          allowed: false,
          refusal:
            'a removal can reassign at most 120 tasks at once, fewer when the change is too large for one request. Reassign some of the tasks first.',
        },
      }),
    )
    expect(find('[data-access-removal-reassign]').textContent).toContain(
      'A removal can reassign at most 120 tasks at once',
    )
    expect(pickerButton().disabled).toBe(true)
    expect(shellButton('Reassign and remove')?.disabled).toBe(true)
    expect(shellButton('Cancel')?.disabled).toBe(false)
  })
})

describe('saving the removal window', () => {
  it('checks again before it saves, and saves the choice for the answer it showed', async () => {
    const onClose = await open()
    await click(shellButton('Change to Viewer'))
    expect(reads('accessRemovals:preview')).toHaveLength(1)
    expect(writes()).toEqual([['projects:removeAccess', 'keep_as_viewer']])
    expect(onClose).toHaveBeenCalled()
    expect(P.levelOn(work, 'leo')).toBe('viewer')
  })

  it('says Saving… from the press, and keeps the choice on screen while it checks', async () => {
    let answered: (value: unknown) => void = () => {}
    preview = () => new Promise((resolve) => (answered = resolve))
    await open()
    await click(shellButton('Change to Viewer'))
    expect(shellButton('Saving…')).toBeDefined()
    const radios = [
      ...document.querySelectorAll<HTMLInputElement>('[data-access-removal] input[type="radio"]'),
    ]
    expect(radios.map((r) => r.disabled)).toEqual([true, true])
    expect(pickerButton().disabled).toBe(true)
    await click(radios[1])
    expect(radios.map((r) => r.checked)).toEqual([true, false])
    expect(writes()).toEqual([])
    await act(async () => answered(answer()))
    await settle()
    expect(writes()).toEqual([['projects:removeAccess', 'keep_as_viewer']])
  })

  it('moves the choice to Reassign when the answer it shows again refuses Keep as Viewer', async () => {
    await open()
    preview = async () =>
      answer({ keep: { allowed: false, refusal: 'no permission to manage users on this project' } })
    await click(shellButton('Change to Viewer'))
    expect(windowText()).toContain('Access or tasks changed while this window was open.')
    const radios = [
      ...document.querySelectorAll<HTMLInputElement>('[data-access-removal] input[type="radio"]'),
    ]
    expect(radios.map((r) => r.checked)).toEqual([false, true])
    expect(shellButton('Reassign and remove')).toBeDefined()
    expect(writes()).toEqual([])
  })

  it('removes nothing and stays open when the check fails or cannot be read', async () => {
    for (const fails of [
      () => Promise.reject(new Error('offline')),
      async () => ({
        ...answer(),
        keep: { targets: [], changers: [], allowed: true, refusal: null },
      }),
    ]) {
      preview = fails
      const onClose = await open()
      await click(shellButton('Change to Viewer'))
      expect(onClose).not.toHaveBeenCalled()
      expect(window.showToast).toHaveBeenLastCalledWith(UNCHECKED, 'error')
      expect(shellButton('Change to Viewer')?.disabled).toBe(false)
    }
    expect(writes()).toEqual([])
  })

  it('closes with a sentence when the access is gone or the server refuses, and stays when it is too large', async () => {
    for (const [said, gone] of [
      ['Leo Berg no longer has this access. Nothing was changed.', { state: 'unavailable' }],
      ['Leo Berg no longer has this access. Nothing was changed.', answer({ pending: false })],
      [
        'Only organization admins can do that.',
        { state: 'refused', message: 'only organization admins can do that' },
      ],
    ] as const) {
      preview = async () => gone
      const onClose = await open()
      await click(shellButton('Change to Viewer'))
      expect(onClose).toHaveBeenCalled()
      expect(window.showToast).toHaveBeenLastCalledWith(
        said,
        gone.state === 'refused' ? 'error' : 'info',
      )
    }
    preview = async () => ({ state: 'too_large', message: 'a removal can check only so much' })
    const onClose = await open()
    await click(shellButton('Change to Viewer'))
    expect(onClose).not.toHaveBeenCalled()
    expect(window.showToast).toHaveBeenLastCalledWith('A removal can check only so much.', 'error')
    expect(writes()).toEqual([])
  })

  it('removes and leaves the tasks with a notice when the organization turned read-only for its admin', async () => {
    const onClose = await open()
    preview = async () =>
      answer({ leave_only: true, keep: { allowed: false }, reassign: { allowed: false } })
    await click(shellButton('Change to Viewer'))
    expect(onClose).toHaveBeenCalled()
    expect(writes()).toEqual([['projects:removeAccess', 'leave']])
    expect(window.showToast).toHaveBeenLastCalledWith(
      'Leo Berg can no longer see a task they are assigned to or reviewing. A project lead can reassign it.',
      'info',
    )
    expect(P.levelOn(work, 'leo')).toBeNull()
  })

  it('takes the plain removal when nobody loses sight of a task any more', async () => {
    const onClose = await open()
    preview = async () => answer({ tasks: 0, people: [], items: [], items_total: 0 })
    await click(shellButton('Change to Viewer'))
    expect(writes()).toEqual([['projects:removeAccess', 'leave']])
    expect(onClose).toHaveBeenCalled()
  })

  it('asks again when the tasks changed, and ignores the click right after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    await open()
    const changed = answer({
      tasks: 2,
      items: [
        ...answer().items,
        {
          task_id: 't9',
          num: 9,
          title: 'New since',
          project_id: work,
          holder_id: 'leo',
          role: 'assignee',
        },
      ],
      items_total: 2,
    })
    preview = async () => changed
    await click(shellButton('Change to Viewer'))
    expect(windowText()).toContain(
      'Access or tasks changed while this window was open. Check them and choose again.',
    )
    expect(windowText()).toContain('New since')
    expect(writes()).toEqual([])
    // a double click does not apply to the answer nobody has read yet
    await click(shellButton('Change to Viewer'))
    expect(reads('accessRemovals:preview')).toHaveLength(1)
    vi.setSystemTime(Date.now() + 1000)
    await click(shellButton('Change to Viewer'))
    expect(writes()).toEqual([['projects:removeAccess', 'keep_as_viewer']])
  })

  it('asks again when the holders of tasks it does not list or what they can still change differ', async () => {
    // Ada's task sits in a project the caller cannot see, so the window
    // names her and counts the task without listing it
    const leo = answer().people[0]
    const ada = { id: 'ada-berg', name: 'Ada Berg', kind: 'person', org_role: 'user' } as const
    const shown = answer({ people: [leo, ada], tasks: 2, hidden: 1 })
    for (const now of [
      // that task went from Ada to Carl, whom Keep as Viewer would grant Viewer
      answer({ people: [leo, { ...ada, id: 'carl', name: 'Carl Berg' }], tasks: 2, hidden: 1 }),
      // Ada can still change Work once the access is gone
      answer({
        people: [leo, ada],
        tasks: 2,
        hidden: 1,
        keep: { changers: [{ id: 'ada-berg', projects: [work], more: 0 }] },
      }),
    ]) {
      preview = async () => now
      const onClose = await open(shown)
      await click(shellButton('Change to Viewer'))
      expect(windowText()).toContain(
        'Access or tasks changed while this window was open. Check them and choose again.',
      )
      expect(onClose).not.toHaveBeenCalled()
    }
    expect(writes()).toEqual([])
  })

  it('asks the server whether the chosen person can still take the tasks, and asks again with Unassigned when not', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    await load({ ada: true })
    await open()
    await click(pickerButton())
    await click(find('[data-reassign-choice="ada-berg"]'))
    expect(pickerButton().getAttribute('aria-label')).toBe('New assignee: Ada Berg')
    preview = async (args) =>
      answer({ reassign: { holder_eligible: args.reassign_to === 'ada-berg' ? false : true } })
    await click(shellButton('Reassign and remove'))
    expect(reads('accessRemovals:preview').at(-1)).toMatchObject({ reassign_to: 'ada-berg' })
    expect(windowText()).toContain('Access or tasks changed')
    expect(pickerButton().getAttribute('aria-label')).toBe('New assignee: Unassigned')
    expect(writes()).toEqual([])
    vi.setSystemTime(Date.now() + 1000)
    preview = async () => answer()
    await click(shellButton('Reassign and remove'))
    expect(writes()).toEqual([['projects:removeAccess', { reassign_to: null }]])
  })

  it('hands the tasks to the chosen person the server accepts', async () => {
    await load({ ada: true })
    const onClose = await open()
    await click(pickerButton())
    await click(find('[data-reassign-choice="ada-berg"]'))
    preview = async () => answer({ reassign: { holder_eligible: true } })
    await click(shellButton('Reassign and remove'))
    expect(writes()).toEqual([['projects:removeAccess', { reassign_to: 'ada-berg' }]])
    expect(onClose).toHaveBeenCalled()
  })

  it('reads the preview again after a refused write: stays with a new answer, closes on a refusal', async () => {
    let onClose = await open()
    refusal = new ConvexError({ code: 'rule', message: 'refused', reason: 'held_tasks' })
    preview = async (args) =>
      args.reassign_to === undefined && writes().length > 0
        ? answer({ tasks: 1, items: [{ ...answer().items[0], title: 'Still held' }] })
        : answer()
    await click(shellButton('Change to Viewer'))
    expect(onClose).not.toHaveBeenCalled()
    expect(writes()).toEqual([['projects:removeAccess', 'keep_as_viewer']])
    expect(windowText()).toContain('Still held')
    onClose = await open()
    preview = async () =>
      writes().length > 1
        ? { state: 'refused', message: 'This organization is read-only.' }
        : answer()
    await click(shellButton('Change to Viewer'))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('the Reassign picker', () => {
  it('reads one batch when it opens, none with the window, and drops them when it closes', async () => {
    await open()
    expect(reads('accessRemovals:reassignChoices')).toEqual([])
    await click(pickerButton())
    expect(reads('accessRemovals:reassignChoices')).toEqual([
      { org_id: snap.orgs[0].id, change: { kind: 'user_grant', project_id: work, user_id: 'leo' } },
    ])
    expect(pickerNames()).toEqual(['Unassigned', 'Ada Berg', 'Dan Berg'])
    await click(find('[data-reassign-choice=""]'))
    expect(pickerButton().getAttribute('aria-label')).toBe('New assignee: Unassigned')
    // Reassign is chosen with the pick
    expect(shellButton('Reassign and remove')).toBeDefined()
    await click(pickerButton())
    expect(reads('accessRemovals:reassignChoices')).toHaveLength(2)
  })

  it('starts again for a settled search, and keeps the chosen person named when a search does not hold them', async () => {
    choices = async (args) =>
      args.search === 'zz'
        ? batch([])
        : args.search === 'dan'
          ? batch(['Dan Berg'])
          : batch(['Ada Berg', 'Dan Berg'])
    await open()
    await click(pickerButton())
    await click(find('[data-reassign-choice="ada-berg"]'))
    await click(pickerButton())
    await type(find<HTMLInputElement>('[data-reassign-search]'), 'dan')
    await rest()
    expect(reads('accessRemovals:reassignChoices').at(-1)).toMatchObject({ search: 'dan' })
    expect(pickerNames()).toEqual(['Unassigned', 'Dan Berg'])
    await type(find<HTMLInputElement>('[data-reassign-search]'), 'zz')
    await rest()
    expect(pickerText()).toContain('No one matches.')
    expect(pickerButton().getAttribute('aria-label')).toBe('New assignee: Ada Berg')
  })

  it('loads more after the last batch, says when a batch stopped, and never reads a stopped batch as no match', async () => {
    choices = async (args) =>
      args.after === undefined
        ? batch(['Ada Berg'], 'one', true)
        : args.after === 'one'
          ? batch([], 'two', true)
          : batch(['Dan Berg'])
    await open()
    await click(pickerButton())
    expect(pickerText()).toContain('Showing the people found so far.')
    await click(find('[data-reassign-more]'))
    expect(reads('accessRemovals:reassignChoices').at(-1)).toMatchObject({ after: 'one' })
    expect(pickerText()).not.toContain('No one matches.')
    expect(pickerText()).toContain('Load more')
    await click(find('[data-reassign-more]'))
    expect(pickerNames()).toEqual(['Unassigned', 'Ada Berg', 'Dan Berg'])
    expect(pickerText()).not.toContain('Load more')
  })

  it('says why it lists nobody, and offers Try again after a failure', async () => {
    for (const [held, said] of [
      [{ state: 'not_ready' }, "People can't be listed yet."],
      [
        { state: 'refused', message: 'no write access to this project' },
        'No write access to this project.',
      ],
      [{ state: 'unavailable' }, 'This removal can no longer be checked.'],
    ] as const) {
      choices = async () => held
      await open()
      await click(pickerButton())
      expect(find('[data-reassign-held]').textContent).toBe(said)
      expect(pickerText()).not.toContain('No one matches.')
    }
    choices = () => Promise.reject(new Error('offline'))
    await open()
    await click(pickerButton())
    const alert = find('[data-reassign-people] [role="alert"]')
    expect(alert.textContent).toContain("Couldn't load people.")
    choices = async () => batch(['Ada Berg'])
    const before = reads('accessRemovals:reassignChoices').length
    await click([...alert.querySelectorAll('button')].find((b) => b.textContent === 'Try again'))
    expect(reads('accessRemovals:reassignChoices')).toHaveLength(before + 1)
    expect(pickerNames()).toEqual(['Unassigned', 'Ada Berg'])
  })

  it('says why a Load more lists nobody, rather than a failure that Try again repeats', async () => {
    choices = async (args) =>
      args.after === undefined
        ? batch(['Ada Berg'], 'one')
        : { state: 'refused', message: 'no write access to this project' }
    await open()
    await click(pickerButton())
    await click(find('[data-reassign-more]'))
    expect(find('[data-reassign-held]').textContent).toBe('No write access to this project.')
    expect(pickerText()).not.toContain("Couldn't load people.")
    expect(pickerNames()).toEqual(['Unassigned', 'Ada Berg'])
  })

  it('asks for a search past 500 people', async () => {
    let n = 0
    choices = async () =>
      batch(
        Array.from({ length: 25 }, () => `Person ${String(n++).padStart(3, '0')}`),
        `c${n}`,
      )
    await open()
    await click(pickerButton())
    for (let i = 1; i < 20; i++) await click(find('[data-reassign-more]'))
    expect(pickerNames()).toHaveLength(501)
    expect(pickerText()).toContain('Search to narrow the list.')
    expect(document.querySelector('[data-reassign-more]')).toBeNull()
  })

  it('clears the search on Escape, then closes the list, never the window', async () => {
    const onClose = await open()
    await click(pickerButton())
    const search = find<HTMLInputElement>('[data-reassign-search]')
    search.focus()
    await type(search, 'da')
    const pressEscape = async () => {
      await act(async () =>
        (document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        ),
      )
      await settle()
    }
    await pressEscape()
    expect(document.querySelector('[data-reassign-people]')).not.toBeNull()
    expect(find<HTMLInputElement>('[data-reassign-search]').value).toBe('')
    await pressEscape()
    expect(document.querySelector('[data-reassign-people]')).toBeNull()
    expect(document.querySelector('[data-access-removal]')).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
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
    await click(shellButton('Change to Viewer'))
    // Cancel while the removal saves is refused, and the Back step stays
    await click(shellButton('Cancel'))
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

  it('closes the open picker on Back before the window', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    )
    const pageHistory = await import('../lib/pageHistory')
    const removeHistory = pageHistory.installPageHistory()
    onTestFinished(pageHistory.listenBackLayers())
    onTestFinished(removeHistory)
    history.pushState(null, '', '/before')
    history.pushState(null, '', '/settings')
    const onClose = await open()
    await click(pickerButton())
    expect(document.querySelector('[data-reassign-people]')).not.toBeNull()
    await act(async () => {
      history.back()
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    await settle()
    expect(document.querySelector('[data-reassign-people]')).toBeNull()
    expect(document.querySelector('[data-access-removal]')).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('the press on the Settings pages', () => {
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
  const remove = (id: string) =>
    document.querySelector<HTMLButtonElement>(
      `[data-project-access-user="${id}"] [data-project-access-remove]`,
    )
  async function projectPage() {
    const settings = await import('./settings/ProjectSettings')
    await show(() => <settings.ProjectPage projectId={work} setPage={vi.fn()} />)
  }

  it.each([
    [
      "a person's grant",
      {},
      async () => {
        await projectPage()
        return () => remove('leo')
      },
    ],
    [
      'a team member',
      { viaTeam: true },
      async () => {
        const settings = await import('./settings/TeamSettings')
        await show(() => <settings.TeamPage teamId="crew" setPage={vi.fn()} />)
        return () =>
          document.querySelector<HTMLButtonElement>(
            '[data-settings-team-member="leo"] [data-team-member-remove]',
          )
      },
    ],
    [
      'a team',
      { viaTeam: true },
      async () => {
        const settings = await import('./settings/TeamSettings')
        await show(() => <settings.OrgTeamsPage setPage={vi.fn()} />)
        return () =>
          document.querySelector<HTMLButtonElement>('[data-team-row="crew"] [data-team-delete]')
      },
    ],
  ])(
    'shows that removing %s is being checked, and sends nothing on a second press',
    async (_, options, page) => {
      await load(options)
      vi.useFakeTimers({ toFake: ['Date'] })
      onTestFinished(() => {
        vi.useRealTimers()
      })
      let answered: (value: unknown) => void = () => {}
      preview = () => new Promise((resolve) => (answered = resolve))
      const control = await page()
      await press(control())
      // a member's Remove and a team's Delete ask for a second click
      if (!reads('accessRemovals:preview').length) {
        vi.setSystemTime(Date.now() + CONFIRM_IGNORE_MS)
        await press(control())
      }
      expect(reads('accessRemovals:preview')).toHaveLength(1)
      const busy = control()
      expect(busy?.disabled).toBe(true)
      expect(busy?.getAttribute('aria-busy')).toBe('true')
      await act(async () => busy?.click())
      await settle()
      expect(reads('accessRemovals:preview')).toHaveLength(1)
      await act(async () => answered(answer()))
      await settle()
      expect(document.querySelector('[data-access-removal]')).not.toBeNull()
      expect(control()?.disabled).toBe(false)
      expect(writes()).toEqual([])
    },
  )

  it('says so and sends nothing when another row is pressed while a removal is being checked', async () => {
    await load({ ada: true })
    let answered: (value: unknown) => void = () => {}
    preview = () => new Promise((resolve) => (answered = resolve))
    await projectPage()
    await press(remove('leo'))
    expect(remove('ada-berg')?.disabled).toBe(false)
    await press(remove('ada-berg'))
    expect(window.showToast).toHaveBeenLastCalledWith(
      'Another removal is still being checked. Try again once it finishes.',
      'info',
    )
    expect(reads('accessRemovals:preview')).toHaveLength(1)
    await act(async () => answered(answer()))
    await settle()
    expect(windowText()).toContain('Leo Berg is assigned to or reviewing 1 task')
    expect(writes()).toEqual([])
  })

  it("gives focus to the row's own Remove after Change to Viewer, and to the next row's once the row leaves", async () => {
    await load({ ada: true })
    await projectPage()
    await press(remove('leo'))
    await press(shellButton('Change to Viewer'))
    expect(document.querySelector('[data-modal-shell]')).toBeNull()
    expect(P.levelOn(work, 'leo')).toBe('viewer')
    expect(document.activeElement).toBe(remove('leo'))
    // his grant is Viewer now, which Keep as Viewer cannot keep; Ada is
    // listed before Leo, so she is the row before his
    preview = async () =>
      answer({
        keep: {
          offered: false,
          allowed: false,
          refusal: 'a Viewer grant cannot be kept as Viewer; leave the tasks or reassign them',
        },
      })
    await press(remove('leo'))
    await press(shellButton('Reassign and remove'))
    expect(document.querySelector('[data-modal-shell]')).toBeNull()
    expect(remove('leo')).toBeNull()
    expect(document.activeElement).toBe(remove('ada-berg'))
  })

  it('gives focus to the empty list once someone else removed the access meanwhile', async () => {
    await load()
    await projectPage()
    await press(remove('leo'))
    snap.access = snap.access.filter((a) => a.profile_id !== 'leo')
    await act(async () => deliver({ ...snap, delivered_at: '2026-09-15T09:00:00.000Z' }))
    preview = async () => ({ state: 'ok', ...answer(), pending: false })
    await press(shellButton('Change to Viewer'))
    expect(window.showToast).toHaveBeenCalledWith(
      'Leo Berg no longer has this access. Nothing was changed.',
      'info',
    )
    expect(document.querySelector('[data-modal-shell]')).toBeNull()
    expect(document.activeElement?.textContent).toBe('No individual users added.')
  })

  it('gives focus back to the pressed Remove when the check fails, and removes nothing', async () => {
    await load({ ada: true })
    await projectPage()
    preview = () => Promise.reject(new Error('offline'))
    await press(remove('leo'))
    expect(window.showToast).toHaveBeenLastCalledWith(UNCHECKED, 'error')
    expect(document.querySelector('[data-modal-shell]')).toBeNull()
    expect(writes()).toEqual([])
    expect(document.activeElement).toBe(remove('leo'))
  })

  it.each([
    [
      "a person's grant",
      { ada: true },
      async () => {
        await projectPage()
        return { press: remove('leo'), left: () => remove('leo'), next: () => remove('ada-berg') }
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
      // nobody loses sight of a task, so nothing asks first
      await load(options)
      preview = async () => answer({ tasks: 0, people: [], items: [], items_total: 0 })
      vi.useFakeTimers({ toFake: ['Date'] })
      onTestFinished(() => {
        vi.useRealTimers()
      })
      const { press: button, left, next } = await open()
      await press(button)
      // a member's Remove and a team's Delete ask for a second click
      if (left() && !reads('accessRemovals:preview').length) {
        vi.setSystemTime(Date.now() + CONFIRM_IGNORE_MS)
        await press(button)
      }
      expect(document.querySelector('[data-modal-shell]')).toBeNull()
      expect(left()).toBeNull()
      expect(document.activeElement).toBe(next())
      expect(writes().map(([, held]) => held)).toEqual(['leave'])
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
