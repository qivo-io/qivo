// @vitest-environment jsdom
import { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { endClosing, playClosingAnimations } from '../lib/closingAnimation.setup'
import { OrganizationDeletion } from './OrganizationDeletion'

/* Settings › General's Delete organization question as it closes. Cancel
   clears the typed confirmation and a finished request clears busy, so the
   closing dialog keeps what it showed open, and an opening starts empty.
   The scheduled deletion can arrive before the request's answer. The
   request is answered by hand. */

const server = vi.hoisted(() => ({
  requests: [] as { resolve: (value: null) => void; args: unknown }[],
  // the organization's removal state, as its subscription delivers it
  state: {
    slug: 'northstar-labs',
    last_export_at: null as string | null,
    deletion: null as null | {
      reason: 'requested'
      delete_after: string
      keep_available: boolean
    },
  },
  listeners: new Set<() => void>(),
}))
vi.mock('../lib/convex', () => ({
  convex: {
    action: (_ref: unknown, args: unknown) =>
      new Promise((resolve) => server.requests.push({ resolve, args })),
  },
}))
vi.mock('../lib/orgRemovalState', () => ({
  useOrgRemovalState: () =>
    useSyncExternalStore(
      (listener) => {
        server.listeners.add(listener)
        return () => server.listeners.delete(listener)
      },
      () => server.state,
    ),
}))
/** Delivers the scheduled deletion, as the state's subscription does. */
const scheduleDeletion = () =>
  act(async () => {
    server.state = {
      ...server.state,
      deletion: {
        reason: 'requested',
        delete_after: '2026-11-25T00:00:00.000Z',
        keep_available: true,
      },
    }
    for (const listener of server.listeners) listener()
  })
vi.mock('../store/planner', () => ({ P: { cannotSaveText: () => null } }))

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  playClosingAnimations()
  server.requests.length = 0
  server.state = { ...server.state, deletion: null }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <TooltipProvider>
        <OrganizationDeletion orgId="org-northstar" orgName="Northstar Labs" />
      </TooltipProvider>,
    ),
  )
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const dialog = () => document.querySelector('[role="alertdialog"]')
const field = () => document.querySelector<HTMLInputElement>('[data-org-delete-confirm-input]')
const confirm = () => document.querySelector<HTMLButtonElement>('[data-org-delete-confirm]')
function button(name: string) {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent === name)
  if (!found) throw new Error(`missing ${name}`)
  return found
}
/** Puts `value` in the confirmation field, as typing or a paste does. */
async function fill(value: string) {
  const input = field()
  if (!input) throw new Error('missing the confirmation field')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
/** Opens the question and types the organization's address. */
async function askAndConfirm() {
  await act(async () => document.querySelector<HTMLElement>('[data-org-delete]')?.click())
  await fill('northstar-labs')
}

describe('the Delete organization question', () => {
  it('keeps the typed address while it closes after Cancel, and a press then does nothing', async () => {
    await askAndConfirm()
    expect(confirm()?.disabled).toBe(false)
    await act(async () => button('Cancel').click())
    expect(dialog()?.getAttribute('data-state')).toBe('closed')
    expect(field()?.value).toBe('northstar-labs')
    expect(confirm()?.disabled).toBe(false)
    await act(async () => confirm()?.click())
    expect(server.requests).toHaveLength(0)
    await endClosing()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(document.querySelector('[data-org-delete]'))
    // the next question starts empty
    await act(async () => document.querySelector<HTMLElement>('[data-org-delete]')?.click())
    expect(field()?.value).toBe('')
  })

  it('starts empty after a close even when the fading field took input', async () => {
    await act(async () => document.querySelector<HTMLElement>('[data-org-delete]')?.click())
    await fill('northstar-lab')
    await act(async () => button('Cancel').click())
    // a paste from the browser's Edit menu still reaches the focused field
    await fill('northstar-labs')
    await endClosing()
    await act(async () => document.querySelector<HTMLElement>('[data-org-delete]')?.click())
    expect(field()?.value).toBe('')
    expect(confirm()?.disabled).toBe(true)
  })

  it('keeps its busy button while it closes after the deletion is scheduled', async () => {
    await askAndConfirm()
    await act(async () => confirm()?.click())
    expect(server.requests).toEqual([
      {
        resolve: expect.any(Function),
        args: { org_id: 'org-northstar', confirm: 'northstar-labs' },
      },
    ])
    expect(confirm()?.textContent).toBe('Deleting…')
    await act(async () => server.requests[0].resolve(null))
    expect(dialog()?.getAttribute('data-state')).toBe('closed')
    expect(field()?.value).toBe('northstar-labs')
    expect(confirm()?.textContent).toBe('Deleting…')
    expect(confirm()?.disabled).toBe(true)
    await endClosing()
    expect(dialog()).toBeNull()
  })

  it('stays while it deletes when the deletion arrives first, then fades and gives focus to its date', async () => {
    await askAndConfirm()
    await act(async () => confirm()?.click())
    await scheduleDeletion()
    expect(document.querySelector('[data-org-delete]')).toBeNull()
    expect(dialog()?.getAttribute('data-state')).toBe('open')
    expect(confirm()?.textContent).toBe('Deleting…')
    await act(async () => server.requests[0].resolve(null))
    expect(dialog()?.getAttribute('data-state')).toBe('closed')
    expect(confirm()?.textContent).toBe('Deleting…')
    await endClosing()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(document.querySelector('[data-org-deletion-date]'))
  })

  it("closes a question that waits for nothing when another admin's deletion arrives", async () => {
    await askAndConfirm()
    await scheduleDeletion()
    expect(dialog()?.getAttribute('data-state')).toBe('closed')
    expect(field()?.value).toBe('northstar-labs')
    await act(async () => confirm()?.click())
    expect(server.requests).toHaveLength(0)
    await endClosing()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(document.querySelector('[data-org-deletion-date]'))
  })
})
