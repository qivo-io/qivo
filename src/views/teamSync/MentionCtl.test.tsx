// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../../components/ui/tooltip'
import { pastCloseTicks } from '../../lib/discardQuestion.setup'
import type { UnsentScope } from '../../lib/leaveGuard'
import { plannerFixture, type Snapshot } from '../../store/plannerFixture.setup'

/* The Team sync @ window on the real store. Its note is a comment, so the
   window waits for the server with the note locked: it closes once the
   comment is saved and keeps the note after a refusal, also through closing
   and reopening it, and a kept note holds back an app update. Each comment
   write is answered by hand. */

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

type Planner = typeof import('../../store/planner')['P']
type Answer = { resolve: (value: null) => void; reject: (reason: unknown) => void }

const NOW = '2026-09-14T08:00:00.000Z'
// A sample `rule` refusal of a post. The app toasts such a sentence as sent.
const RULE = 'this sample rule refuses the comment; try again later'

let P: Planner
let card: typeof import('./SyncCard')
let safety: typeof import('../../lib/updateSafety')
let prompt: typeof import('../../components/DiscardPrompt')
let container: HTMLDivElement
let root: Root
let writes: Answer[]

async function load() {
  vi.resetModules()
  const snap: Snapshot = plannerFixture()
  const me = snap.profiles[0]
  snap.profiles.push({ ...me, id: 'aisha', name: 'Aisha Rahman', auth_user_id: 'account-aisha' })
  snap.issues.push({
    id: 'task-a',
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
    num: 27,
    title: 'Run the soak test',
    description: '',
    status: 'review',
    priority: 'medium',
    paused: false,
    created_at: NOW,
    updated_at: NOW,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  writes = []
  network.onUpdate.mockImplementation((ref, _args, next) => {
    if (getFunctionName(ref) === 'workspace:whole') next(structuredClone(snap))
    return () => {}
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockImplementation(
    (ref) =>
      new Promise((resolve, reject) => {
        if (getFunctionName(ref) !== 'comments:create') return resolve(null)
        writes.push({ resolve, reject })
      }),
  )
  const store = await import('../../store/planner')
  P = store.P
  await store.initStore()
  card = await import('./SyncCard')
  safety = await import('../../lib/updateSafety')
  prompt = await import('../../components/DiscardPrompt')
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  // Radix measures the popover's anchor
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  window.showToast = vi.fn()
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
})

/* Opens the @ window on the task, with Aisha picked, and writes `text`.
   `page` is the scope of the page the card sits on. */
async function write(text: string, onSent: () => void, page?: UnsentScope) {
  const it = P.issues.find((i) => i.uuid === 'task-a')
  if (!it) throw new Error('missing the task')
  const { UnsentScopeContext } = await import('../../lib/leaveGuard')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <UnsentScopeContext.Provider value={page ?? null}>
          <card.MentionCtl it={it} initial="aisha" onSent={onSent} />
        </UnsentScopeContext.Provider>
        <prompt.DiscardPrompt />
      </TooltipProvider>,
    ),
  )
  await act(async () => document.querySelector<HTMLElement>('[data-sync-mention]')?.click())
  const field = note()
  if (!field) throw new Error('missing the note')
  // React tracks the value through the native setter
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setValue?.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const windowOpen = () => document.querySelector('[data-sync-mention-window]') !== null
function note() {
  return document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note"]')
}
const send = () => document.querySelector<HTMLButtonElement>('[data-sync-mention-send]')
function button(name: string) {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent === name)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing ${name}`)
  return found
}
const aisha = () => document.querySelector<HTMLButtonElement>('[data-sync-mention-person="aisha"]')
/* The @ glyph opens a closed window and closes an open one. */
async function toggle() {
  await act(async () => {
    document.querySelector<HTMLElement>('[data-sync-mention]')?.click()
    // a close that asks answers two ticks later
    await pastCloseTicks()
  })
}
const question = () => document.querySelector('[data-discard-prompt] h2')?.textContent ?? null

describe('the Team sync @ window', () => {
  it('keeps the window and its note when the server refuses the comment', async () => {
    const onSent = vi.fn()
    await write('Can you check the soak report?', onSent)
    await act(async () => send()?.click())
    expect(writes).toHaveLength(1)
    // one send at a time, and nothing in the window changes meanwhile
    expect(send()?.disabled).toBe(true)
    expect(note()?.readOnly).toBe(true)
    expect(aisha()?.disabled).toBe(true)
    expect(button('Cancel').disabled).toBe(true)
    await act(async () => writes[0].reject(new ConvexError({ code: 'rule', message: RULE })))
    expect(window.showToast).toHaveBeenCalledWith(
      expect.stringContaining('This sample rule refuses the comment'),
      'error',
    )
    expect(windowOpen()).toBe(true)
    expect(note()?.value).toBe('Can you check the soak report?')
    expect(send()?.disabled).toBe(false)
    expect(note()?.readOnly).toBe(false)
    expect(button('Cancel').disabled).toBe(false)
    expect(onSent).not.toHaveBeenCalled()
  })

  it('keeps the note when the server refuses it after the window closed', async () => {
    const onSent = vi.fn()
    await write('Can you check the soak report?', onSent)
    await act(async () => send()?.click())
    await toggle()
    expect(windowOpen()).toBe(false)
    await act(async () => writes[0].reject(new ConvexError({ code: 'rule', message: RULE })))
    // the closed window's note still holds back an app update's reload
    expect(safety.isUpdateBlocked()).toBe(true)
    await toggle()
    expect(note()?.value).toBe('Can you check the soak report?')
    expect(note()?.readOnly).toBe(false)
    // Cancel lets the note go
    await act(async () => button('Cancel').click())
    expect(safety.isUpdateBlocked()).toBe(false)
    await toggle()
    expect(note()?.value).toBe('')
    expect(onSent).not.toHaveBeenCalled()
  })

  it('lets a kept note go when the person discards the page around it', async () => {
    const { createUnsentScope } = await import('../../lib/leaveGuard')
    const page = createUnsentScope()
    await write('Can you check the soak report?', vi.fn(), page)
    await act(async () => send()?.click())
    await toggle()
    await act(async () => writes[0].reject(new ConvexError({ code: 'rule', message: RULE })))
    expect(page.held()).toEqual(['note'])
    // Discard on a question about the page, while the card stays on it
    await act(async () => page.discard())
    expect(safety.isUpdateBlocked()).toBe(false)
    await toggle()
    expect(note()?.value).toBe('')
  })

  it('closes the open window when the person discards the page around it', async () => {
    const { createUnsentScope } = await import('../../lib/leaveGuard')
    const page = createUnsentScope()
    await write('Can you check the soak report?', vi.fn(), page)
    expect(page.held()).toEqual(['note'])
    // Discard on leaving the page, which a kept Team sync outlives
    await act(async () => page.discard())
    expect(windowOpen()).toBe(false)
    expect(page.held()).toEqual([])
  })

  it('shows the note being sent when the window opens again, and closes once it is saved', async () => {
    const onSent = vi.fn()
    await write('Can you check the soak report?', onSent)
    await act(async () => send()?.click())
    await toggle()
    await toggle()
    expect(note()?.value).toBe('Can you check the soak report?')
    expect(note()?.readOnly).toBe(true)
    await act(async () => writes[0].resolve(null))
    expect(windowOpen()).toBe(false)
    expect(onSent).toHaveBeenCalledTimes(1)
    expect(safety.isUpdateBlocked()).toBe(false)
    await toggle()
    expect(note()?.value).toBe('')
  })

  it('asks before closing with a note that was neither sent nor kept', async () => {
    await write('Can you check the soak report?', vi.fn())
    await toggle()
    expect(question()).toBe('Discard your unsent note?')
    await act(async () => document.querySelector<HTMLElement>('[data-discard-keep]')?.click())
    expect(windowOpen()).toBe(true)
    expect(note()?.value).toBe('Can you check the soak report?')
    await toggle()
    await act(async () => document.querySelector<HTMLElement>('[data-discard-confirm]')?.click())
    expect(windowOpen()).toBe(false)
    await toggle()
    expect(note()?.value).toBe('')
    // Cancel lets a note go without asking
    const field = note()
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setValue?.call(field, 'Never mind')
      field?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('Cancel').click())
    expect(question()).toBeNull()
    expect(windowOpen()).toBe(false)
  })

  it('closes once the server saves the comment', async () => {
    const onSent = vi.fn()
    await write('Can you check the soak report?', onSent)
    await act(async () => send()?.click())
    expect(windowOpen()).toBe(true)
    await act(async () => writes[0].resolve(null))
    expect(windowOpen()).toBe(false)
    expect(onSent).toHaveBeenCalledTimes(1)
  })
})
