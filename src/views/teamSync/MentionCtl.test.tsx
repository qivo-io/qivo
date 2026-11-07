// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { TooltipProvider } from '../../components/ui/tooltip'
import { endClosing, playClosingAnimations } from '../../lib/closingAnimation.setup'
import { pastCloseTicks } from '../../lib/discardQuestion.setup'
import type { UnsentScope } from '../../lib/leaveGuard'
import {
  isOwnerPickerRead,
  type OwnerPickerArgs,
  ownerPickersStandIn,
} from '../../store/ownerPickersStandIn.setup'
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
/** the stand-in's forced states (store/ownerPickersStandIn.setup.ts) */
let force: Set<string>
/** every pickers: read, oldest first */
let asked: { name: string; args: OwnerPickerArgs }[]
/** whether the reads wait for `held`'s releases */
let holding: boolean
let held: { name: string; release: () => void }[]

const FIRST =
  'Ben Carla Dmitri Elena Farid Grace Hugo Ines Jonas Keiko Liam Maya Nora Omar Priya Quinn Rosa Sven Tara Umar Vera Wes Ximena Yusuf Zara Alba Bruno Chloe Diego Emil Freya Gus Hana Ivan Jade Kofi Lena Mateo Noor Leo'.split(
    ' ',
  )
const LAST =
  'Carter Silva Ivanov Rossi Haddad Kim Moreau Costa Berg Tanaka Walsh Patel Martins Farouk Nair Lopez Novak Larsen Singh Okafor Weber Dubois Garcia Yilmaz Mensah Hughes Sato Byrne Fischer Young'.split(
    ' ',
  )

async function load(people = 0) {
  vi.resetModules()
  const snap: Snapshot = plannerFixture()
  const me = snap.profiles[0]
  snap.profiles.push({ ...me, id: 'aisha', name: 'Aisha Rahman', auth_user_id: 'account-aisha' })
  for (let i = 0; i < people; i++) {
    const name = `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`
    snap.profiles.push({
      ...me,
      id: `person-${String(i).padStart(4, '0')}`,
      name,
      auth_user_id: `account-${i}`,
      org_role: 'user',
    })
  }
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
  network.query.mockImplementation(async (ref, args: OwnerPickerArgs) => {
    const name = getFunctionName(ref)
    if (!isOwnerPickerRead(name)) return null
    asked.push({ name, args })
    if (holding) await new Promise<void>((release) => held.push({ name, release }))
    return structuredClone(ownerPickersStandIn(snap, name, args, force))
  })
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
  force = new Set()
  asked = []
  held = []
  holding = false
  await load()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A few turns for the server's answers and React. */
async function flush() {
  for (let i = 0; i < 3; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}

/* Renders the @ glyph on the task, suggesting `initial`. `page` is the
   scope of the page the card sits on. */
async function mount(onSent: () => void, page?: UnsentScope, initial: string | null = 'aisha') {
  const it = P.issues.find((i) => i.uuid === 'task-a')
  if (!it) throw new Error('missing the task')
  const { UnsentScopeContext } = await import('../../lib/leaveGuard')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <UnsentScopeContext.Provider value={page ?? null}>
          <card.MentionCtl it={it} initial={initial} onSent={onSent} />
        </UnsentScopeContext.Provider>
        <prompt.DiscardPrompt />
      </TooltipProvider>,
    ),
  )
}

/* Types `text` into the note. */
async function typeNote(text: string) {
  const field = note()
  if (!field) throw new Error('missing the note')
  // React tracks the value through the native setter
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setValue?.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/* Opens the @ window on the task, with Aisha picked once the server says
   she can be mentioned, and writes `text`. `page` is the scope of the
   page the card sits on. */
async function write(text: string, onSent: () => void, page?: UnsentScope) {
  await mount(onSent, page)
  await act(async () => document.querySelector<HTMLElement>('[data-sync-mention]')?.click())
  await flush()
  await typeNote(text)
}

/* Presses Send and lets the check and the post go out. */
async function pressSend() {
  await act(async () => send()?.click())
  await flush()
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
/* Opens the window on a phone, with the page's history and the layers'
   listener as main.tsx and App add them, and writes a note. The window has
   a Back step of its own, and its own close takes none. */
async function writeOnPhone() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  const pageHistory = await import('../../lib/pageHistory')
  const removeHistory = pageHistory.installPageHistory()
  onTestFinished(pageHistory.listenBackLayers())
  onTestFinished(removeHistory)
  await write('Can you check the soak report?', vi.fn())
  // the window's Back step is pushed after it opened
  await act(async () => await Promise.resolve())
  expect(history.state?.qivoLayer).toBeTruthy()
}
const fading = () =>
  document.querySelector('[data-sync-mention-window]')?.getAttribute('data-state') === 'closed'
/* Ctrl+Enter, or Cmd+Enter with `meta`, in the note. True when the app
   took the key from the browser. */
async function modEnter(meta = false) {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    ctrlKey: !meta,
    metaKey: meta,
    bubbles: true,
    cancelable: true,
  })
  await act(async () => note()?.dispatchEvent(event))
  return event.defaultPrevented
}
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
    await pressSend()
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
    await pressSend()
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
    await pressSend()
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
    await pressSend()
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

  it('stays locked while it closes after the save, so a press then sends nothing', async () => {
    playClosingAnimations()
    const onSent = vi.fn()
    await write('Can you check the soak report?', onSent)
    await pressSend()
    await act(async () => writes[0].resolve(null))
    const closing = document.querySelector('[data-sync-mention-window]')
    expect(closing?.getAttribute('data-state')).toBe('closed')
    expect(send()?.disabled).toBe(true)
    expect(note()?.readOnly).toBe(true)
    expect(aisha()?.disabled).toBe(true)
    expect(button('Cancel').disabled).toBe(true)
    await pressSend()
    expect(writes).toHaveLength(1)
    await endClosing()
    expect(windowOpen()).toBe(false)
    expect(onSent).toHaveBeenCalledTimes(1)
    // the next note starts unlocked
    await toggle()
    expect(note()?.value).toBe('')
    expect(note()?.readOnly).toBe(false)
  })

  it('sends nothing from a press while it closes after Cancel', async () => {
    playClosingAnimations()
    await write('Can you check the soak report?', vi.fn())
    await act(async () => button('Cancel').click())
    expect(document.querySelector('[data-sync-mention-window]')?.getAttribute('data-state')).toBe(
      'closed',
    )
    // the fading window shows what it had, Send included
    expect(send()?.disabled).toBe(false)
    await pressSend()
    await pressSend()
    expect(writes).toHaveLength(0)
    await endClosing()
    expect(windowOpen()).toBe(false)
  })

  it('stays locked through a close that a send overtook, until the answer', async () => {
    await write('Can you check the soak report?', vi.fn())
    // the glyph's close asks about the unsent note a moment later, and the
    // send between keeps the note, so the window closes without asking
    await act(async () => {
      document.querySelector<HTMLElement>('[data-sync-mention]')?.click()
      send()?.click()
      await pastCloseTicks()
    })
    expect(question()).toBeNull()
    expect(windowOpen()).toBe(false)
    expect(writes).toHaveLength(1)
    // reopened while the note is on its way, it shows the note locked
    await toggle()
    expect(note()?.value).toBe('Can you check the soak report?')
    expect(send()?.disabled).toBe(true)
    expect(note()?.readOnly).toBe(true)
    await pressSend()
    expect(writes).toHaveLength(1)
  })

  it('closes at once on a phone after the save, and stays locked while it fades', async () => {
    playClosingAnimations()
    await writeOnPhone()
    await pressSend()
    await act(async () => writes[0].resolve(null))
    expect(fading()).toBe(true)
    expect(send()?.disabled).toBe(true)
    expect(note()?.readOnly).toBe(true)
    await pressSend()
    expect(writes).toHaveLength(1)
    await endClosing()
    expect(windowOpen()).toBe(false)
  })

  it('closes at once on a phone after Cancel, and a press while it fades sends nothing', async () => {
    playClosingAnimations()
    await writeOnPhone()
    await act(async () => button('Cancel').click())
    expect(fading()).toBe(true)
    await pressSend()
    expect(writes).toHaveLength(0)
    await endClosing()
    expect(windowOpen()).toBe(false)
  })

  it('sends nothing on Ctrl+Enter or Cmd+Enter, and keeps the note for Send', async () => {
    await write('Can you check the soak report?', vi.fn())
    expect(await modEnter()).toBe(false)
    expect(await modEnter(true)).toBe(false)
    expect(writes).toHaveLength(0)
    expect(windowOpen()).toBe(true)
    expect(note()?.value).toBe('Can you check the soak report?')
    await pressSend()
    expect(writes).toHaveLength(1)
  })

  it('closes once the server saves the comment', async () => {
    const onSent = vi.fn()
    await write('Can you check the soak report?', onSent)
    await pressSend()
    expect(windowOpen()).toBe(true)
    await act(async () => writes[0].resolve(null))
    expect(windowOpen()).toBe(false)
    expect(onSent).toHaveBeenCalledTimes(1)
  })
})

const person = (id: string) =>
  document.querySelector<HTMLButtonElement>(`[data-sync-mention-person="${id}"]`)
const people = () =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-sync-mention-person]')].map(
    (b) => b.dataset.syncMentionPerson,
  )
const pressed = () =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-sync-mention-person]')]
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.dataset.syncMentionPerson)
const line = () => document.querySelector('[data-sync-mention-line]')?.textContent ?? null
const listText = () => document.querySelector('[data-sync-mention-list]')?.textContent ?? ''
const reads = (name: string) => asked.filter((a) => a.name === name)
async function openWindow() {
  await act(async () => document.querySelector<HTMLElement>('[data-sync-mention]')?.click())
  await flush()
}
/* Lets the held read of `name` answer. */
async function release(name: string) {
  const at = held.findIndex((h) => h.name === name)
  if (at < 0) throw new Error(`no held ${name}`)
  const [read] = held.splice(at, 1)
  await act(async () => read.release())
  await flush()
}
async function search(text: string) {
  const box = document.querySelector<HTMLInputElement>('[data-sync-mention-search]')
  if (!box) throw new Error('missing the search')
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setValue?.call(box, text)
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => await new Promise((r) => setTimeout(r, 300)))
  await flush()
}
async function loadMore() {
  await act(async () => document.querySelector<HTMLElement>('[data-picker-more]')?.click())
  await flush()
}

describe('the Team sync @ window’s people', () => {
  it('reads nothing while closed, and its first batch and the suggestion’s check while open', async () => {
    await mount(vi.fn())
    expect(asked).toEqual([])
    await openWindow()
    const org = P.org.id
    expect(reads('pickers:syncRecipients').map((a) => a.args)).toEqual([
      { org_id: org, issue_id: 'task-a' },
    ])
    expect(reads('pickers:canOwn').map((a) => a.args)).toEqual([
      { org_id: org, issue_id: 'task-a', field: 'recipient', ids: ['aisha'] },
    ])
    await toggle()
    expect(windowOpen()).toBe(false)
    const before = asked.length
    await flush()
    expect(asked).toHaveLength(before)
  })

  it('chooses the suggested person only once the server says they can be mentioned', async () => {
    holding = true
    await mount(vi.fn())
    await openWindow()
    // the batch and the check are on their way, so no one is chosen
    expect(pressed()).toEqual([])
    expect(held).toHaveLength(2)
    // the check answers first and says yes
    await release('pickers:canOwn')
    await flush()
    expect(pressed()).toEqual(['aisha'])
  })

  it('chooses nothing for a check that says no or fails, until a batch holds the person', async () => {
    for (const state of ['check-ineligible', 'check-error']) {
      await load()
      force = new Set([state])
      holding = true
      held = []
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await mount(vi.fn())
      await openWindow()
      await release('pickers:canOwn')
      await flush()
      expect(pressed(), state).toEqual([])
      expect(line(), state).toBeNull()
      // a batch row of the person is the server's yes
      await release('pickers:syncRecipients')
      await flush()
      expect(pressed(), state).toEqual(['aisha'])
      await toggle()
      holding = false
    }
  })

  it('never chooses the suggested person over someone the person picked', async () => {
    await load(40)
    holding = true
    // Zara Carter sorts after the first batch
    await mount(vi.fn(), undefined, 'person-0024')
    await openWindow()
    await release('pickers:syncRecipients')
    await flush()
    const ben = people()[0]
    expect(ben).toBeDefined()
    await act(async () => person(ben ?? '')?.click())
    expect(pressed()).toEqual([ben])
    await release('pickers:canOwn')
    await flush()
    expect(pressed()).toEqual([ben])
  })

  it('keeps the chosen person first through a search that leaves them out, Load more and a new render', async () => {
    await load(40)
    await mount(vi.fn())
    await openWindow()
    await typeNote('Can you check it?')
    expect(people()[0]).toBe('aisha')
    expect(pressed()).toEqual(['aisha'])
    await search('Ben')
    expect(people()[0]).toBe('aisha')
    expect(
      people()
        .slice(1)
        .every((id) => id?.startsWith('person-')),
    ).toBe(true)
    expect(pressed()).toEqual(['aisha'])
    await search('')
    await loadMore()
    expect(people().filter((id) => id === 'aisha')).toHaveLength(1)
    expect(people()[0]).toBe('aisha')
    await mount(vi.fn())
    expect(pressed()).toEqual(['aisha'])
    expect(note()?.value).toBe('Can you check it?')
  })

  it('never shows an older search’s end while the next search’s list opens', async () => {
    await load(3)
    await mount(vi.fn())
    await openWindow()
    await search('zzz')
    expect(listText()).toContain('No people match.')
    // every text the list showed while the search was cleared, also for
    // one render: each text before a change, each node added or removed,
    // and each changed text as it stands
    const shown: string[] = []
    const take = (records: MutationRecord[]) => {
      for (const record of records) {
        if (record.oldValue !== null) shown.push(record.oldValue)
        if (record.type === 'characterData') shown.push(record.target.textContent ?? '')
        for (const node of [...record.addedNodes, ...record.removedNodes])
          shown.push(node.textContent ?? '')
      }
    }
    const watch = new MutationObserver(take)
    const list = document.querySelector('[data-sync-mention-list]')
    if (!list) throw new Error('missing the list')
    watch.observe(list, {
      childList: true,
      subtree: true,
      characterData: true,
      characterDataOldValue: true,
    })
    await search('')
    take(watch.takeRecords())
    watch.disconnect()
    expect(shown.join('\n')).not.toContain('No one else can be mentioned on this task.')
    // the list says it loads until the cleared search's list answers
    expect(shown.some((text) => text.includes('Loading…'))).toBe(true)
    expect(people()).toContain('person-0000')
  })

  it('clears the search on Escape before it closes', async () => {
    await load(40)
    await mount(vi.fn())
    await openWindow()
    await search('Ben')
    const box = document.querySelector<HTMLInputElement>('[data-sync-mention-search]')
    await act(async () =>
      box?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      ),
    )
    expect(windowOpen()).toBe(true)
    expect(box?.value).toBe('')
  })

  // the people figure at its design size, 1,000 people with the writer and
  // Aisha
  it('lists 1,000 people 25 at a time up to its cap of 500, each once', async () => {
    await load(998)
    await mount(vi.fn())
    await openWindow()
    expect(people()).toHaveLength(25)
    for (let press = 0; press < 19; press++) await loadMore()
    expect(people()).toHaveLength(500)
    expect(new Set(people()).size).toBe(500)
    expect(listText()).toContain('Search to narrow the list.')
    expect(document.querySelector('[data-picker-more]')).toBeNull()
  }, 60_000)
})

describe('the Team sync @ window’s Send', () => {
  it('checks the person first and posts only on a current yes', async () => {
    await write('Can you check the soak report?', vi.fn())
    const checks = reads('pickers:canOwn').length
    await pressSend()
    expect(reads('pickers:canOwn')).toHaveLength(checks + 1)
    expect(reads('pickers:canOwn').at(-1)?.args).toMatchObject({
      field: 'recipient',
      ids: ['aisha'],
    })
    expect(writes).toHaveLength(1)
  })

  it('posts nothing for a person who can no longer be mentioned, keeps the note and asks for another', async () => {
    await write('Can you check the soak report?', vi.fn())
    force.add('check-ineligible')
    await pressSend()
    expect(writes).toHaveLength(0)
    expect(windowOpen()).toBe(true)
    expect(note()?.value).toBe('Can you check the soak report?')
    expect(note()?.readOnly).toBe(false)
    expect(line()).toBe('Aisha can no longer be mentioned on this task. Pick someone else.')
    expect(pressed()).toEqual([])
    expect(send()?.disabled).toBe(true)
  })

  it('keeps the choice and the note when the check fails, and sends on the next press', async () => {
    await write('Can you check the soak report?', vi.fn())
    force.add('check-error')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await pressSend()
    expect(writes).toHaveLength(0)
    expect(line()).toBe("Couldn't check Aisha. Press Send to try again.")
    expect(pressed()).toEqual(['aisha'])
    expect(note()?.value).toBe('Can you check the soak report?')
    force.delete('check-error')
    await pressSend()
    expect(writes).toHaveLength(1)
  })

  for (const [state, says] of [
    ['refused', 'No write access to this project.'],
    ['unavailable', 'This task is no longer available.'],
    ['over-budget', "Couldn't check Aisha. Press Send to try again."],
  ])
    it(`posts nothing when the check answers ${state}, and says why`, async () => {
      await write('Can you check the soak report?', vi.fn())
      force.add(state)
      await pressSend()
      expect(writes).toHaveLength(0)
      expect(line()).toBe(says)
      expect(note()?.value).toBe('Can you check the soak report?')
      expect(windowOpen()).toBe(true)
    })

  it('clears a kept choice the server no longer takes when the window opens again', async () => {
    await write('Can you check the soak report?', vi.fn())
    await pressSend()
    await toggle()
    await act(async () => writes[0].reject(new ConvexError({ code: 'rule', message: RULE })))
    force.add('check-ineligible')
    await toggle()
    await flush()
    expect(note()?.value).toBe('Can you check the soak report?')
    expect(line()).toBe('Aisha can no longer be mentioned on this task. Pick someone else.')
    expect(pressed()).toEqual([])
  })

  it('leaves a kept choice the opening check cleared to the person, also once the suggestion changes', async () => {
    await load(3)
    await write('Can you check the soak report?', vi.fn())
    await pressSend()
    await toggle()
    await act(async () => writes[0].reject(new ConvexError({ code: 'rule', message: RULE })))
    force.add('check-ineligible')
    await toggle()
    await flush()
    expect(pressed()).toEqual([])
    await toggle()
    // the task's other party is now Ben Carter, whom the server takes
    force.delete('check-ineligible')
    await mount(vi.fn(), undefined, 'person-0000')
    await toggle()
    await flush()
    expect(reads('pickers:canOwn').at(-1)?.args.ids).toEqual(['person-0000'])
    expect(people()).toContain('person-0000')
    expect(pressed()).toEqual([])
    expect(line()).toBe('Aisha can no longer be mentioned on this task. Pick someone else.')
    expect(note()?.value).toBe('Can you check the soak report?')
  })

  it('keeps a person picked before the check of a kept choice answers', async () => {
    await load(3)
    await write('Can you check the soak report?', vi.fn())
    await pressSend()
    await toggle()
    await act(async () => writes[0].reject(new ConvexError({ code: 'rule', message: RULE })))
    force.add('check-ineligible')
    holding = true
    await toggle()
    await release('pickers:syncRecipients')
    // Ben Carter, picked while the check of the kept Aisha is on its way
    const ben = 'person-0000'
    await act(async () => person(ben)?.click())
    expect(pressed()).toEqual([ben])
    await release('pickers:canOwn')
    expect(pressed()).toEqual([ben])
    expect(line()).toBeNull()
  })

  it('ignores the opening check of a window that closed before it answered', async () => {
    await load(3)
    await write('Can you check the soak report?', vi.fn())
    await pressSend()
    await toggle()
    await act(async () => writes[0].reject(new ConvexError({ code: 'rule', message: RULE })))
    force.add('check-ineligible')
    holding = true
    // opened and closed while its check of the kept Aisha is on its way,
    // then opened again
    await toggle()
    await toggle()
    expect(windowOpen()).toBe(false)
    await toggle()
    expect(
      reads('pickers:canOwn')
        .slice(-2)
        .map((a) => a.args.ids),
    ).toEqual([['aisha'], ['aisha']])
    await release('pickers:syncRecipients')
    await release('pickers:syncRecipients')
    // Ben Carter, picked in the second opening
    const ben = 'person-0000'
    await act(async () => person(ben)?.click())
    expect(pressed()).toEqual([ben])
    // the first opening's check says no of Aisha, and changes nothing
    await release('pickers:canOwn')
    expect(pressed()).toEqual([ben])
    expect(line()).toBeNull()
    await release('pickers:canOwn')
    expect(pressed()).toEqual([ben])
    expect(line()).toBeNull()
  })

  it('never sends a kept note to the suggestion once Send dropped the chosen person', async () => {
    await load(3)
    await mount(vi.fn())
    await openWindow()
    expect(pressed()).toEqual(['aisha'])
    // Ben Carter, picked over the suggested Aisha
    const ben = 'person-0000'
    await act(async () => person(ben)?.click())
    await typeNote('Can you check the soak report?')
    holding = true
    await pressSend()
    // closed while the check of Ben is on its way, which then says no
    await toggle()
    expect(windowOpen()).toBe(false)
    force.add('check-ineligible')
    holding = false
    await release('pickers:canOwn')
    await toggle()
    await flush()
    expect(note()?.value).toBe('Can you check the soak report?')
    expect(line()).toBe('Ben can no longer be mentioned on this task. Pick someone else.')
    expect(pressed()).toEqual([])
    expect(writes).toHaveLength(0)
  })
})
