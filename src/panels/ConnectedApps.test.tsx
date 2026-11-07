// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { LIMITS } from '../../convex/lib/limits'
import { endClosing, playClosingAnimations } from '../lib/closingAnimation.setup'
import { APP_LIST } from '../lib/credentialLists'
import {
  credentialListsStandIn,
  type ForcedCredentialLists,
  type StandInConnection,
} from '../store/credentialListsStandIn.setup'
import { ConnectedApps } from './ConnectedApps'

/* Settings › Connected apps: the list read from the server a batch at a
   time, and the delete question as it closes. Its close clears the
   selection it names, so the closing dialog keeps the words it showed
   open. The store's batch read and delete are answered by hand, a batch
   from the rows a case gives or through the stand-in the perf page uses
   (store/credentialListsStandIn.setup.ts). */

type Answer<T> = { resolve: (value: T) => void }
type Asked = { search: string; cursor: string | null }
const store = vi.hoisted(() => ({
  lists: [] as (Answer<unknown> & { search: string; cursor: string | null })[],
  revokes: [] as Answer<boolean>[],
}))
// the list reads through the store, so the transport answers nothing
vi.mock('../lib/convex', () => ({ convex: {}, live: {} }))
vi.mock('../store/planner', () => ({
  P: {
    connectedApps: (search: string, cursor: string | null) =>
      new Promise((resolve) => store.lists.push({ resolve, search, cursor })),
    revokeOAuthConnection: () => new Promise((resolve) => store.revokes.push({ resolve })),
    fmtDate: (date: Date) => date.toISOString().slice(0, 10),
  },
}))

const connection = (id: string, clientName: string) => ({
  id,
  clientName,
  orgName: 'Northstar Labs',
  profileName: 'Nora Berg',
  scopes: ['qivo:read'],
  createdAt: Date.UTC(2026, 9, 20),
  lastUsedAt: null,
  revokedAt: null,
  revokedByAdmin: false,
  appGone: false,
})
const APPS = [connection('claude', 'Claude Desktop'), connection('cursor', 'Cursor')]
/** One whole batch of `rows`, as the server answers a short list. */
const batch = (rows: readonly unknown[]) => ({ rows, next: null, stopped: false })

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  playClosingAnimations()
  store.lists.length = 0
  store.revokes.length = 0
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ConnectedApps />
      </TooltipProvider>,
    ),
  )
  await answer(store.lists, batch(APPS))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  APP_LIST.most = 2000
})

/** Answers the oldest waiting call. */
const answer = <T,>(calls: Answer<T>[], value: T) => act(async () => calls.shift()?.resolve(value))
const dialog = () => document.querySelector('[role="alertdialog"]')
const title = () => dialog()?.querySelector('h2')?.textContent
function button(name: string, scope: ParentNode = document) {
  const found = [...scope.querySelectorAll('button')].find((b) => b.textContent === name)
  if (!found) throw new Error(`missing ${name}`)
  return found
}
async function ask(id: string) {
  const row = document.querySelector(`[data-oauth-connection="${id}"]`)
  if (!row) throw new Error(`missing ${id}`)
  await act(async () => button('Delete', row).click())
}

describe('the Connected apps delete question', () => {
  it('names the app while it closes after Cancel', async () => {
    await ask('claude')
    expect(title()).toBe('Delete Claude Desktop connection?')
    await act(async () => button('Cancel').click())
    expect(dialog()?.getAttribute('data-state')).toBe('closed')
    expect(title()).toBe('Delete Claude Desktop connection?')
    await endClosing()
    expect(dialog()).toBeNull()
    // focus goes back to the Delete that asked
    const row = document.querySelector('[data-oauth-connection="claude"]')
    expect(row && document.activeElement).toBe(row && button('Delete', row))
  })

  it('keeps the name and its busy button while it closes after a delete', async () => {
    await ask('cursor')
    await act(async () => button('Delete connection').click())
    expect(button('Deleting…').disabled).toBe(true)
    await answer(store.revokes, true)
    expect(dialog()?.getAttribute('data-state')).toBe('closed')
    expect(document.querySelector('[data-oauth-connection="cursor"]')).toBeNull()
    expect(title()).toBe('Delete Cursor connection?')
    // the list reloads, and the dialog still reads as it did when it closed
    await answer(store.lists, batch([APPS[0]]))
    expect(title()).toBe('Delete Cursor connection?')
    expect(button('Deleting…').disabled).toBe(true)
    await endClosing()
    expect(dialog()).toBeNull()
  })

  it.each([
    ['the next row', 'claude', 'cursor'],
    ['the row before when it was the last', 'cursor', 'claude'],
  ])('gives focus to %s once the deleted row has left', async (_, deleted, next) => {
    await ask(deleted)
    await act(async () => button('Delete connection').click())
    await answer(store.revokes, true)
    await answer(store.lists, batch(APPS.filter((app) => app.id !== deleted)))
    await endClosing()
    const row = document.querySelector(`[data-oauth-connection="${next}"]`)
    expect(row && document.activeElement).toBe(row && button('Delete', row))
  })

  it('gives focus to the next row once a reload that outlasts the closing has ended', async () => {
    await ask('claude')
    await act(async () => button('Delete connection').click())
    await answer(store.revokes, true)
    await endClosing()
    expect(dialog()).toBeNull()
    // the next row's Delete waits disabled for the list
    expect(document.activeElement).toBe(document.body)
    await answer(store.lists, batch([APPS[1]]))
    const row = document.querySelector('[data-oauth-connection="cursor"]')
    expect(row && document.activeElement).toBe(row && button('Delete', row))
  })

  it("gives focus to the empty list's line once the last row has left", async () => {
    await ask('claude')
    await act(async () => button('Delete connection').click())
    await answer(store.revokes, true)
    await answer(store.lists, batch([APPS[1]]))
    await endClosing()
    await ask('cursor')
    await act(async () => button('Delete connection').click())
    await answer(store.revokes, true)
    await answer(store.lists, batch([]))
    await endClosing()
    expect(document.activeElement?.textContent).toBe('No connected apps.')
  })

  it('keeps a refused delete in the dialog, not on the page', async () => {
    await ask('claude')
    await act(async () => button('Delete connection').click())
    await answer(store.revokes, false)
    const refusal = 'Could not delete this connection. Try again.'
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(refusal)
    await act(async () => button('Cancel').click())
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(refusal)
    await endClosing()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    // the next question starts without it
    await ask('cursor')
    expect(dialog()?.querySelector('[role="alert"]')).toBeNull()
  })
})

/* ------------------------------------------------- the list from the server */

describe('the Connected apps list read from the server', () => {
  /** `n` connections, the oldest `Oldest helper` and the others `App 1` to
      `App n-1`, newest last. */
  const many = (n: number): StandInConnection[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `app-${String(i).padStart(3, '0')}`,
      clientId: `client-${i}`,
      clientName: i === 0 ? 'Oldest helper' : `App ${i}`,
      profileId: 'seat',
      orgId: 'org',
      scopes: ['qivo:read'],
      createdAt: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
      lastUsedAt: null,
      revokedAt: null,
      login: 'login',
      approvedAt: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
      revocationReason: null,
      created: i,
      profileName: 'Nora Berg',
      orgName: 'Northstar Labs',
      clientGone: false,
    }))
  let rows: StandInConnection[] = []
  let force: ForcedCredentialLists = {}
  /** Answers the oldest waiting batch from the rows through the stand-in,
      or with null for a read that failed. */
  const serve = async () => {
    const asked = store.lists[0]
    if (!asked) throw new Error('no batch is waiting')
    let value: unknown
    try {
      value = credentialListsStandIn(
        'connectedApps:list',
        {
          ...(asked.search === '' ? {} : { search: asked.search }),
          ...(asked.cursor === null ? {} : { cursor: asked.cursor }),
        },
        { login: 'login', seats: [], tokens: [], connections: rows },
        force,
      )
    } catch {
      value = null
    }
    await answer(store.lists, value)
  }
  /** Leaves the page beforeEach rendered and renders a fresh one. */
  async function fresh(list: StandInConnection[]) {
    await act(async () => root.unmount())
    store.lists.length = 0
    rows = list
    force = {}
    root = createRoot(container)
    await act(async () =>
      root.render(
        <TooltipProvider>
          <ConnectedApps />
        </TooltipProvider>,
      ),
    )
    await serve()
  }
  const names = () =>
    [...document.querySelectorAll('[data-oauth-connection]')].map(
      (row) => row.querySelector('.font-semibold')?.textContent,
    )
  const end = () =>
    document.querySelector('[data-connected-apps-end]')?.getAttribute('data-connected-apps-end')
  const note = () => document.querySelector('[data-connected-apps-note]')?.textContent ?? ''
  const box = () => document.querySelector<HTMLInputElement>('[data-connected-apps-search]')
  /** Types `text` into the search and waits for its batch to be asked. */
  async function search(text: string) {
    const input = box()
    if (!input) throw new Error('no search')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => await new Promise((r) => setTimeout(r, 300)))
  }
  const asked = (): Asked[] => store.lists.map(({ search, cursor }) => ({ search, cursor }))

  it('shows 25 of 30 with Load more, then 30 and the end, and no search for two', async () => {
    await fresh(many(2))
    expect(box()).toBeNull()
    expect(note()).toBe('')
    await fresh(many(30))
    expect(names()).toHaveLength(25)
    expect(names()[0]).toBe('App 29')
    expect(box()).not.toBeNull()
    const more = document.querySelector<HTMLElement>('[data-connected-apps-more]')
    more?.focus()
    await act(async () => more?.click())
    expect(asked()).toEqual([{ search: '', cursor: expect.any(String) }])
    await serve()
    expect(names()).toHaveLength(30)
    expect(names().at(-1)).toBe('Oldest helper')
    expect(end()).toBe('end')
    const row = document.querySelector('[data-oauth-connection="app-004"]')
    expect(row && document.activeElement).toBe(row && button('Delete', row))
  })

  it('searches the whole list on the server, says when nothing matches, and refuses a long search', async () => {
    await fresh(many(30))
    await search('OLDEST')
    expect(asked()).toEqual([{ search: 'OLDEST', cursor: null }])
    await serve()
    expect(names()).toEqual(['Oldest helper'])
    await search('nothing like it')
    await serve()
    expect(end()).toBe('none')
    expect(note()).toBe('No connected apps match.')
    await search('x'.repeat(LIMITS.search.max + 1))
    expect(store.lists).toHaveLength(0)
    expect(end()).toBe('too_long')
    // the box stays while it holds text and for the rest of the visit
    await search('')
    await serve()
    expect(box()).not.toBeNull()
    expect(names()).toHaveLength(25)
  })

  it('asks for a search at the cap, never ends a stopped batch, and says when a batch failed', async () => {
    APP_LIST.most = 50
    await fresh(many(60))
    await act(async () =>
      document.querySelector<HTMLElement>('[data-connected-apps-more]')?.click(),
    )
    await serve()
    expect(names()).toHaveLength(50)
    expect(note()).toBe('Search to find more connected apps.')
    await fresh(many(30))
    force = { stop: 3 }
    await act(async () =>
      document.querySelector<HTMLElement>('[data-connected-apps-more]')?.click(),
    )
    await serve()
    expect(names()).toHaveLength(28)
    expect(end()).toBe('more')
    expect(note()).toContain('Qivo checked part of the list. Load more continues.')
    force = { fail: true }
    await act(async () =>
      document.querySelector<HTMLElement>('[data-connected-apps-more]')?.click(),
    )
    await serve()
    expect(names()).toHaveLength(28)
    expect(note()).toBe("Couldn't load more connected apps.Retry")
    await act(async () => root.unmount())
    store.lists.length = 0
    root = createRoot(container)
    force = { fail: true }
    await act(async () =>
      root.render(
        <TooltipProvider>
          <ConnectedApps />
        </TooltipProvider>,
      ),
    )
    await serve()
    expect(note()).toBe('Could not load connected apps. Try again.Try again')
    force = {}
    await act(async () => button('Try again').click())
    await serve()
    expect(names()).toHaveLength(25)
  })

  it('hides a deleted row at once and keeps the others until the refresh has landed', async () => {
    await fresh(many(3))
    await ask('app-001')
    await act(async () => button('Delete connection').click())
    await answer(store.revokes, true)
    expect(names()).toEqual(['App 2', 'Oldest helper'])
    // the refresh reads the first batch again, with the search kept
    expect(asked()).toEqual([{ search: '', cursor: null }])
    rows = rows.filter((row) => row.id !== 'app-001')
    await serve()
    expect(names()).toEqual(['App 2', 'Oldest helper'])
  })

  it('keeps the delete question open with its words while a Load more lands', async () => {
    await fresh(many(30))
    await act(async () =>
      document.querySelector<HTMLElement>('[data-connected-apps-more]')?.click(),
    )
    await ask('app-010')
    expect(title()).toBe('Delete App 10 connection?')
    await serve()
    expect(names()).toHaveLength(30)
    expect(dialog()?.getAttribute('data-state')).toBe('open')
    expect(title()).toBe('Delete App 10 connection?')
  })
})
