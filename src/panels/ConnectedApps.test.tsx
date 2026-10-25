// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { endClosing, playClosingAnimations } from '../lib/closingAnimation.setup'
import { ConnectedApps } from './ConnectedApps'

/* Settings › Connected apps' delete question as it closes. Its close clears
   the selection it names, so the closing dialog keeps the words it showed
   open. The store's list and delete are answered by hand. */

type Answer<T> = { resolve: (value: T) => void }
const store = vi.hoisted(() => ({
  lists: [] as Answer<unknown>[],
  revokes: [] as Answer<boolean>[],
}))
vi.mock('../store/planner', () => ({
  P: {
    listOAuthConnections: () => new Promise((resolve) => store.lists.push({ resolve })),
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
  await answer(store.lists, APPS)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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
    await answer(store.lists, [APPS[0]])
    expect(title()).toBe('Delete Cursor connection?')
    expect(button('Deleting…').disabled).toBe(true)
    await endClosing()
    expect(dialog()).toBeNull()
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
