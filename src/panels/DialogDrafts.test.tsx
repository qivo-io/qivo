// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture } from '../store/plannerFixture.setup'

/* Closing a dialog while a field holds text the person typed: the close
   button, Escape and Done ask first, Cancel does not. On the real store,
   with the question mounted as the app mounts it. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

type Modals = typeof import('./Modals')
type Prompt = typeof import('../components/DiscardPrompt')

let dialogs: Modals
let prompt: Prompt
let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  window.showToast = vi.fn()
  vi.resetModules()
  const snap = plannerFixture()
  // a project the fixture's person leads, for milestones
  snap.projects.push({
    ...snap.projects[0],
    id: 'roadmap',
    type: 'meta',
    key: 'MAP',
    num: 2,
    name: 'Roadmap',
    lead_id: snap.profiles[0].id,
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  network.onUpdate.mockImplementation((_ref, _args, next) => {
    next(structuredClone(snap))
    return () => {}
  })
  const store = await import('../store/planner')
  await store.initStore()
  dialogs = await import('./Modals')
  prompt = await import('../components/DiscardPrompt')
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

async function render(node: ReactNode) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        {node}
        <prompt.DiscardPrompt />
      </TooltipProvider>,
    ),
  )
}
function field(label: string) {
  const found = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!found) throw new Error(`missing ${label}`)
  return found
}
/** Types `value` into the field labelled `label` as React reads input. */
async function type(label: string, value: string) {
  const input = field(label)
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
/** Presses the button named `name`, then lets the close's one tick pass. */
async function press(name: string) {
  const button = [...document.querySelectorAll('button')].find(
    (b) => b.textContent === name || b.getAttribute('aria-label') === name,
  )
  if (!button) throw new Error(`missing ${name}`)
  await act(async () => {
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
async function pressEscape() {
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
const question = () => document.querySelector('[data-discard-prompt] h2')?.textContent ?? null

describe('closing a dialog with typed text', { timeout: 20_000 }, () => {
  it('asks before New task drops its title, and closes on Discard', async () => {
    const onClose = vi.fn()
    await render(<dialogs.NewIssueModal init={{}} onClose={onClose} onCreate={vi.fn()} />)
    await type('Title', 'Calibrate the sensor')
    await pressEscape()
    expect(question()).toBe('Discard your unsent title?')
    await press('Keep editing')
    expect(onClose).not.toHaveBeenCalled()
    expect(field('Title').value).toBe('Calibrate the sensor')
    await press('Close')
    expect(question()).toBe('Discard your unsent title?')
    await press('Discard')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes at once with nothing typed, and on Cancel', async () => {
    const onClose = vi.fn()
    await render(<dialogs.NewIssueModal init={{}} onClose={onClose} onCreate={vi.fn()} />)
    await type('Title', 'Calibrate')
    await type('Title', '  ')
    await pressEscape()
    expect(question()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
    await type('Title', 'Calibrate the sensor')
    await press('Cancel')
    expect(question()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('asks again after a Cancel the dialog refused', async () => {
    // busy for the first close, as a dialog waiting for the server is
    const onClose = vi.fn().mockReturnValueOnce(false)
    await render(
      <dialogs.ModalShell icon="key" title="New token" onClose={onClose} unsent={['token name']}>
        <input aria-label="Name" />
      </dialogs.ModalShell>,
    )
    await press('Cancel')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(question()).toBeNull()
    await press('Close')
    expect(question()).toBe('Discard your unsent token name?')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('asks before Done drops a milestone name that was not added', async () => {
    const onClose = vi.fn()
    await render(<dialogs.MilestoneModal init={{ project: 'roadmap' }} onClose={onClose} />)
    await press('Done')
    expect(onClose).toHaveBeenCalledTimes(1)
    await type('New milestone', 'Beta')
    await press('Done')
    expect(question()).toBe('Discard your unsent milestone name?')
    await press('Discard')
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
