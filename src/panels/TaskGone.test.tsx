// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The task window when someone else archives or deletes its task while it
   is open (IssueDetail TaskGone), on the real store. Deliveries come by
   hand, and the archive answers what `archive` holds, through `lookup`
   when a test answers otherwise. */

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

const AT = '2026-09-14T08:00:00.000Z'

type Task = Snapshot['issues'][number]

let container: HTMLDivElement
let root: Root
let snap: Snapshot
let deliver: (snapshot: Snapshot) => void
// the archived rows the archive answers with
let archive: Task[]
// the archive's answer to issues.archivedTask, from `archive` unless a test sets it
let lookup: (id: string) => Promise<unknown>
let onClose: ReturnType<typeof vi.fn<() => void>>

/* Opens task-a's window as `role` in the organization, with `level` on the
   project when the role is not admin, floating or in the Inbox's pane. */
async function open(
  role: 'admin' | 'user' = 'admin',
  level?: 'viewer' | 'user',
  place: 'window' | 'inbox' = 'window',
) {
  vi.resetModules()
  snap = plannerFixture()
  snap.profiles[0].org_role = role
  if (level)
    snap.access.push({ project_id: snap.projects[0].id, profile_id: snap.profiles[0].id, level })
  snap.issues.push({
    id: 'task-a',
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
    num: 27,
    title: 'Run the soak test',
    description: 'Measure the drift.',
    status: 'progress',
    priority: 'medium',
    paused: false,
    created_at: AT,
    updated_at: AT,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  archive = []
  lookup = async (id) => {
    const row = archive.find((task) => task.id === id)
    return row ? { ...row, is_group: false } : null
  }
  network.onUpdate.mockImplementation((ref, _args, next) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      deliver = (snapshot) => next(structuredClone(snapshot))
      deliver(snap)
    } else if (name === 'snapshot:commentThread') next({ comments: [], earlier: false, events: [] })
    return () => {}
  })
  network.query.mockReset()
  network.query.mockImplementation(async (ref, args) =>
    getFunctionName(ref) === 'issues:archivedTask' ? lookup(args.id) : null,
  )
  network.mutation.mockReset()
  network.mutation.mockImplementation(async (ref) =>
    getFunctionName(ref) === 'issues:unarchive' ? {} : null,
  )
  const store = await import('../store/planner')
  await store.initStore()
  const { IssueDetail } = await import('./IssueDetail')
  const task = store.P.issues.find((it) => it.uuid === 'task-a')
  if (!task) throw new Error('missing the task')
  onClose = vi.fn<() => void>()
  const { Inbox } = await import('./Inbox')
  const { usePlannerVersion } = await import('../store/usePlannerVersion')
  /** The Inbox as App holds it, its pane on the task the address names, and
      closing it the move to no task. */
  function InboxHost() {
    usePlannerVersion()
    const [openIssue, setOpenIssue] = useState<string | null>(task.id)
    const openTask = (handle: string | null) => {
      if (handle === null) onClose()
      setOpenIssue(handle)
    }
    return (
      <Inbox
        showOnBoard={vi.fn()}
        onExit={vi.fn()}
        openTask={openTask}
        openIssue={openIssue}
        onPlanOnRoadmap={vi.fn()}
      />
    )
  }
  await act(async () =>
    root.render(
      <TooltipProvider>
        {place === 'inbox' ? (
          <InboxHost />
        ) : (
          <IssueDetail issueId={task.id} onClose={onClose} onOpen={vi.fn()} />
        )}
      </TooltipProvider>,
    ),
  )
  return task
}

/* The delivery after someone else archived or deleted task-a, which drops
   it, with the task in the archive once it is archived. */
async function leave({ archived }: { archived: boolean }) {
  const [task] = snap.issues.splice(0, 1)
  if (archived) archive = [{ ...task, archived_at: '2026-09-14T09:00:00.000Z' }]
  await act(async () => deliver(snap))
}

/* leave, then waits for the window to say what happened. */
async function dropTask(how: { archived: boolean }) {
  await leave(how)
  await act(async () => {
    await vi.waitFor(() => {
      if (!document.querySelector('[data-task-gone]')?.textContent?.match(/archived|here|check/))
        throw new Error('the window has not said what happened yet')
    })
  })
}

/* The delivery after a restore, which brings task-a back. */
async function bringBack() {
  snap.issues.push({ ...archive[0], archived_at: undefined })
  await act(async () => deliver(snap))
}

async function click(element: HTMLElement | null | undefined) {
  if (!element) throw new Error('nothing to click')
  await act(async () => element.click())
}

/* Types `value` into `field` as a person would, through its input event. */
async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
// what the note adds when a reason typed for the task went unused
const UNUSED = 'The reason you typed for it was not used. Copy it to keep it.'
const modalButton = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-modal-shell] button')].find(
    (b) => b.textContent === name,
  )

/* Opens the task's Archive or delete window from its menu, once the window
   took focus, which would close a menu opened before. */
async function openFate() {
  await act(async () => {
    await vi.waitFor(() => {
      if (document.activeElement !== dialog()) throw new Error('the window has no focus yet')
    })
  })
  await click(document.querySelector<HTMLElement>('[aria-label="Task actions"]'))
  await click(document.querySelector<HTMLElement>('[data-task-fate]'))
}
const note = () => document.querySelector<HTMLElement>('[data-task-gone] [role="status"]')
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-task-gone] button')].find(
    (b) => b.textContent === name,
  )
const asked = (name: string) =>
  network.query.mock.calls.filter(([ref]) => getFunctionName(ref) === name).map(([, args]) => args)

beforeEach(() => {
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the task window when its task leaves the board', { timeout: 20_000 }, () => {
  it('says someone archived it, and restores it into the window', async () => {
    const task = await open()
    expect(dialog()?.textContent).toContain('Run the soak test')
    await dropTask({ archived: true })
    // the window stays, rather than turning invisible
    expect(dialog()?.getAttribute('aria-hidden')).toBeNull()
    expect(note()?.textContent).toBe(
      `${task.key} was archived. Restore it to bring it back to the board.`,
    )
    // no reason was typed, so the note keeps none
    expect(document.querySelector('[data-task-gone-reason]')).toBeNull()
    expect(asked('issues:archivedTask')).toEqual([{ id: 'task-a' }])

    await click(button('Restore'))
    const restores = network.mutation.mock.calls.filter(
      ([ref]) => getFunctionName(ref) === 'issues:unarchive',
    )
    expect(restores.map(([, args]) => args)).toEqual([{ org_id: snap.orgs[0].id, id: 'task-a' }])
    expect(window.showToast).toHaveBeenCalledWith(`Restored ${task.key}`)
    expect(button('Restoring…')?.disabled).toBe(true)
    // the restored task comes back with the next delivery
    await bringBack()
    expect(document.querySelector('[data-task-gone]')).toBeNull()
    expect(dialog()?.textContent).toContain('Run the soak test')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('finds the task by its id, not on a page of archive search results', async () => {
    const task = await open()
    // a search page of the archive that the task's subtasks fill, as when
    // they are archived with it
    network.query.mockImplementation(async (ref, args) => {
      const name = getFunctionName(ref)
      if (name === 'issues:archivedTask') return lookup(args.id)
      if (name !== 'issues:archivedPage') return null
      const rows = Array.from({ length: 10 }, (_, i) => ({
        ...archive[0],
        id: `subtask-${i}`,
        num: 270 + i,
        is_group: false,
      }))
      return { rows, next_cursor: 'more', scanned: 10 }
    })
    await dropTask({ archived: true })
    expect(note()?.textContent).toBe(
      `${task.key} was archived. Restore it to bring it back to the board.`,
    )
    expect(button('Restore')).toBeDefined()
  })

  it('names who can restore it to someone who can only read the project', async () => {
    const task = await open('user', 'viewer')
    await dropTask({ archived: true })
    expect(note()?.textContent).toBe(
      `${task.key} was archived. Someone who can edit its project can restore it from Archived tasks.`,
    )
    expect(button('Restore')).toBeUndefined()
  })

  it('says a task that is not in the archive is no longer here, and closes', async () => {
    const task = await open()
    await dropTask({ archived: false })
    expect(dialog()?.getAttribute('aria-hidden')).toBeNull()
    expect(note()?.textContent).toBe(
      `${task.key} is no longer here. It was deleted, or you can no longer open it.`,
    )
    // on the window or the note, as the window's own focus may come first
    expect(document.activeElement?.closest('button')).toBeNull()
    await click(button('Close'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('says it could not check the archive, and finds the task on Retry', async () => {
    const task = await open()
    const answer = lookup
    lookup = () => Promise.reject(new Error('the connection dropped'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await dropTask({ archived: true })
    expect(note()?.textContent).toBe(
      `${task.key} is no longer on the board. Couldn't check the archive.`,
    )
    // neither a deleted task's sentence nor a Restore it cannot back up
    expect(button('Restore')).toBeUndefined()
    lookup = answer
    await click(button('Retry'))
    await act(async () => {
      await vi.waitFor(() => {
        if (!note()?.textContent?.includes('was archived')) throw new Error('still checking')
      })
    })
    expect(note()?.textContent).toBe(
      `${task.key} was archived. Restore it to bring it back to the board.`,
    )
    expect(button('Retry')).toBeUndefined()
    expect(button('Restore')).toBeDefined()
    expect(document.activeElement).toBe(note())
    expect(asked('issues:archivedTask')).toEqual([{ id: 'task-a' }, { id: 'task-a' }])
  })

  it('offers Restore again when the restore is refused', async () => {
    const task = await open()
    network.mutation.mockImplementation(async (ref) => {
      if (getFunctionName(ref) === 'issues:unarchive') throw new Error('the server refused it')
      return null
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await dropTask({ archived: true })
    await click(button('Restore'))
    await act(async () => {
      await vi.waitFor(() => {
        if (!button('Restore')) throw new Error('still restoring')
      })
    })
    expect(button('Restore')?.disabled).toBe(false)
    expect(window.showToast).not.toHaveBeenCalledWith(`Restored ${task.key}`)
    expect(note()?.textContent).toBe(
      `${task.key} was archived. Restore it to bring it back to the board.`,
    )
  })

  it('moves focus from the task to the note, never to a button', async () => {
    await open()
    // the archive answers once the test says so
    let answer = () => {}
    const answered = lookup
    lookup = (id) =>
      new Promise((resolve) => {
        answer = () => resolve(answered(id))
      })
    const actions = document.querySelector<HTMLElement>('[aria-label="Task actions"]')
    act(() => actions?.focus())
    expect(document.activeElement).toBe(actions)
    // while the archive is asked, Close is the one button a key could press
    await leave({ archived: true })
    expect(button('Close')).toBeDefined()
    expect(document.activeElement).toBe(note())
    await act(async () => answer())
    await act(async () => {
      await vi.waitFor(() => {
        if (!button('Restore')) throw new Error('still checking')
      })
    })
    expect(document.activeElement).toBe(note())
  })

  it('discards a title and hours typed for the task, says so, and restores the task without them', async () => {
    await open()
    await type(document.querySelector('[data-remaining-input]') as HTMLInputElement, '12')
    await click(document.querySelector<HTMLElement>('[data-task-title]'))
    const title = document.querySelector<HTMLTextAreaElement>('[aria-label="Task title"]')
    if (!title) throw new Error('the title did not open for editing')
    await type(title, 'Run the long soak test')
    await dropTask({ archived: true })
    expect(window.showToast).toHaveBeenCalledWith('Unsaved title discarded')
    expect(window.showToast).toHaveBeenCalledWith('Unsaved remaining hours discarded')
    await click(button('Restore'))
    await bringBack()
    expect(document.querySelector('[data-task-gone]')).toBeNull()
    expect(document.querySelector('[aria-label="Task title"]')).toBeNull()
    expect(document.querySelector('[data-task-title]')?.textContent).toBe('Run the soak test')
    expect(document.querySelector<HTMLInputElement>('[data-remaining-input]')?.value).toBe('')
    // neither went to the server
    expect(network.mutation.mock.calls.map(([ref]) => getFunctionName(ref))).not.toContain(
      'issues:update',
    )
  })

  it('keeps a reason typed to archive or delete the task in the note, unused, to copy', async () => {
    const task = await open()
    await act(async () => {
      await vi.waitFor(() => {
        if (document.activeElement !== dialog()) throw new Error('the window has no focus yet')
      })
    })
    await click(document.querySelector<HTMLElement>('[aria-label="Task actions"]'))
    await click(document.querySelector<HTMLElement>('[data-task-fate]'))
    const field = document.querySelector<HTMLTextAreaElement>('[data-fate-reason]')
    if (!field) throw new Error('the Archive or delete window did not open')
    await type(field, 'Superseded by the\nhardware rework ')
    await dropTask({ archived: true })
    expect(document.querySelector('[data-fate-reason]')).toBeNull()
    // the note, which takes focus and speaks, says the reason went unused
    // and points at it
    expect(note()?.textContent).toBe(
      `${task.key} was archived. Restore it to bring it back to the board. ${UNUSED}`,
    )
    const kept = document.querySelector<HTMLElement>('[data-task-gone-reason] p')
    expect(kept?.textContent).toBe('Superseded by the\nhardware rework')
    expect(note()?.getAttribute('aria-describedby')).toBe(kept?.id)
    // until it is copied, closing the window or the page asks first
    const { hasUnsaved } = await import('../lib/leaveGuard')
    const { isUpdateBlocked } = await import('../lib/updateSafety')
    expect(hasUnsaved()).toBe(true)
    expect(isUpdateBlocked()).toBe(true)
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await click(button('Copy reason'))
    expect(writeText).toHaveBeenCalledWith('Superseded by the\nhardware rework')
    expect(window.showToast).toHaveBeenCalledWith('Copied the reason')
    expect(hasUnsaved()).toBe(false)
    expect(isUpdateBlocked()).toBe(false)
    // this window sent nothing, and a refused copy leaves the reason selected
    expect(network.mutation.mock.calls.map(([ref]) => getFunctionName(ref))).not.toContain(
      'issues:archive',
    )
    writeText.mockRejectedValueOnce(new Error('denied'))
    await click(button('Copy reason'))
    expect(window.getSelection()?.toString()).toBe('Superseded by the\nhardware rework')
    expect(window.showToast).toHaveBeenLastCalledWith(
      "Couldn't copy. Copy the selected text instead.",
      'error',
    )
  })

  it('keeps the reason when someone else archived the task just before this window did', async () => {
    const task = await open()
    await openFate()
    const field = document.querySelector<HTMLTextAreaElement>('[data-fate-reason]')
    if (!field) throw new Error('the Archive or delete window did not open')
    await type(field, 'Moved to the next release')
    // the other archive reached the server first, so this one changed
    // nothing and posted no reason
    archive = [{ ...snap.issues[0], archived_at: '2026-09-14T09:00:00.000Z' }]
    network.mutation.mockImplementation(async (ref) =>
      getFunctionName(ref) === 'issues:archive' ? { issue: null, archived: false } : null,
    )
    await click(modalButton('Archive'))
    await act(async () => {
      await vi.waitFor(() => {
        if (!note()?.textContent?.includes('was archived')) throw new Error('no note yet')
      })
    })
    expect(note()?.textContent).toBe(
      `${task.key} was archived. Restore it to bring it back to the board. ${UNUSED}`,
    )
    expect(document.querySelector('[data-task-gone-reason] p')?.textContent).toBe(
      'Moved to the next release',
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(window.showToast).not.toHaveBeenCalledWith(`Archived ${task.key}`)
    expect(window.showToast).toHaveBeenCalledWith(
      `Someone else archived ${task.key} first. The reason you typed was not used.`,
    )
    // the delivery that drops the task leaves the note as it is
    snap.issues.splice(0, 1)
    await act(async () => deliver(snap))
    expect(document.querySelector('[data-task-gone-reason] p')?.textContent).toBe(
      'Moved to the next release',
    )
  })

  it('fills the next Archive or delete window with the kept reason after a restore', async () => {
    await open()
    await openFate()
    const field = document.querySelector<HTMLTextAreaElement>('[data-fate-reason]')
    if (!field) throw new Error('the Archive or delete window did not open')
    await type(field, 'Superseded by the rework')
    await dropTask({ archived: true })
    await click(button('Restore'))
    await bringBack()
    expect(document.querySelector('[data-task-gone]')).toBeNull()
    // the reason waits for the window, and a reload still asks about it
    const { hasUnsaved } = await import('../lib/leaveGuard')
    expect(hasUnsaved()).toBe(true)
    await click(document.querySelector<HTMLElement>('[aria-label="Task actions"]'))
    await click(document.querySelector<HTMLElement>('[data-task-fate]'))
    expect(document.querySelector<HTMLTextAreaElement>('[data-fate-reason]')?.value).toBe(
      'Superseded by the rework',
    )
  })

  it('keeps the kept reason when the task is archived again before the next window opens', async () => {
    const task = await open()
    await openFate()
    const field = document.querySelector<HTMLTextAreaElement>('[data-fate-reason]')
    if (!field) throw new Error('the Archive or delete window did not open')
    await type(field, 'Superseded by the rework')
    await dropTask({ archived: true })
    await click(button('Restore'))
    await bringBack()
    expect(document.querySelector('[data-task-gone]')).toBeNull()
    await dropTask({ archived: true })
    expect(note()?.textContent).toBe(
      `${task.key} was archived. Restore it to bring it back to the board. ${UNUSED}`,
    )
    expect(document.querySelector('[data-task-gone-reason] p')?.textContent).toBe(
      'Superseded by the rework',
    )
    const { hasUnsaved } = await import('../lib/leaveGuard')
    expect(hasUnsaved()).toBe(true)
  })

  /* Someone else archives the task and restores it while this window's
     archive is on its way, which then changes nothing. The deliveries say
     so in one, or one after the other, which takes the task away under the
     window for a moment. */
  for (const deliveries of ['one', 'two'] as const) {
    it(`frees the archive window with the reason when the task is back before the answer (${deliveries} deliveries)`, async () => {
      const task = await open()
      await openFate()
      const field = document.querySelector<HTMLTextAreaElement>('[data-fate-reason]')
      if (!field) throw new Error('the Archive or delete window did not open')
      await type(field, 'Moved to the next release')
      let answer = (_value: unknown) => {}
      network.mutation.mockImplementation((ref) =>
        getFunctionName(ref) === 'issues:archive'
          ? new Promise((resolve) => {
              answer = resolve
            })
          : Promise.resolve(null),
      )
      await click(modalButton('Archive'))
      expect(modalButton('Archiving…')).toBeDefined()
      const [row] = snap.issues.splice(0, 1)
      if (deliveries === 'two') await act(async () => deliver(snap))
      snap.issues.push({ ...row, updated_at: '2026-09-14T09:05:00.000Z' })
      await act(async () => deliver(snap))
      await act(async () => answer({ issue: null, archived: false }))
      await act(async () => {
        await vi.waitFor(() => {
          if (!modalButton('Archive')) throw new Error('the window is still busy')
        })
      })
      expect(document.querySelector<HTMLTextAreaElement>('[data-fate-reason]')?.value).toBe(
        'Moved to the next release',
      )
      expect(window.showToast).toHaveBeenCalledWith(
        `Someone else archived ${task.key} first. The reason you typed was not used.`,
      )
      expect(document.querySelector('[data-task-gone]')).toBeNull()
      expect(onClose).not.toHaveBeenCalled()
    })
  }

  it('stays in the Inbox pane and its pop-out, and says so in each', async () => {
    const task = await open('admin', undefined, 'inbox')
    await click(document.querySelector<HTMLElement>('[data-task-popout]'))
    const windows = () => [...document.querySelectorAll<HTMLElement>('[aria-label="Task"]')]
    expect(windows().map((w) => w.dataset.issueLayout)).toEqual(['embedded', 'columns'])
    await leave({ archived: true })
    const notes = () => [...document.querySelectorAll('[data-task-gone] [role="status"]')]
    await act(async () => {
      await vi.waitFor(() => {
        if (notes().filter((n) => n.textContent?.includes('was archived')).length < 2)
          throw new Error('the windows have not said what happened yet')
      })
    })
    expect(notes().map((n) => n.textContent)).toEqual([
      `${task.key} was archived. Restore it to bring it back to the board.`,
      `${task.key} was archived. Restore it to bring it back to the board.`,
    ])
    // the pane's Close goes back to the inbox
    const pane = windows().find((w) => w.dataset.issueLayout === 'embedded')
    const close = [...(pane?.querySelectorAll<HTMLButtonElement>('[data-task-gone] button') ?? [])]
    await click(close.find((b) => b.textContent === 'Close'))
    expect(onClose).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-task-gone]')).toBeNull()
  })

  it('closes without the note when the window archives its own task', async () => {
    await open()
    // the window takes focus a frame after it opens, which would close a
    // menu opened before
    await act(async () => {
      await vi.waitFor(() => {
        if (document.activeElement !== dialog()) throw new Error('the window has no focus yet')
      })
    })
    await click(document.querySelector<HTMLElement>('[aria-label="Task actions"]'))
    await click(document.querySelector<HTMLElement>('[data-task-fate]'))
    const reason = document.querySelector<HTMLTextAreaElement>('[data-fate-reason]')
    if (!reason) throw new Error('the Archive or delete window did not open')
    await type(reason, 'Done elsewhere')
    const archiveButton = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-modal-shell] button'),
    ].find((b) => b.textContent === 'Archive')
    await click(archiveButton)
    await act(async () => {
      await vi.waitFor(() => {
        if (!onClose.mock.calls.length) throw new Error('the window has not closed yet')
      })
    })
    expect(
      network.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === 'issues:archive'),
    ).toHaveLength(1)
    expect(document.querySelector('[data-task-gone]')).toBeNull()
    // the server's delivery without the task leaves the window as it is
    snap.issues.splice(0, 1)
    await act(async () => deliver(snap))
    expect(document.querySelector('[data-task-gone]')).toBeNull()
    expect(asked('issues:archivedTask')).toEqual([])
    expect(onClose).toHaveBeenCalledOnce()
  })
})
