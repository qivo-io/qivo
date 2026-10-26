// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../../../convex/lib/limits'
import { TooltipProvider } from '../../components/ui/tooltip'
import { TextField } from './controls'

/* The keys of the settings text field. Enter saves a single-line field. A
   multi-line field saves only when it loses focus: Ctrl+Enter and Cmd+Enter
   stay the browser's, and Escape puts the stored text back. */

// the field's icons load the store, which needs a backend and sign-in
const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../../lib/convex', async () => ({
  convex: network,
  live: (await import('../../store/guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: null }) },
  signOut: vi.fn(),
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/* Renders the field with "Sensor" stored, focuses it and types `text`. */
async function typed(multiline: boolean, onCommit: (v: string) => void, text: string) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <TextField
          label="Description"
          value="Sensor"
          multiline={multiline}
          limit={LIMITS.projectDescription}
          onCommit={onCommit}
        />
      </TooltipProvider>,
    ),
  )
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    '[aria-label="Description"]',
  )
  if (!field) throw new Error('missing the field')
  // React tracks the value through the native setter
  const proto = multiline ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setValue = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  await act(async () => {
    field.focus()
    setValue?.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return field
}

/* Presses `key` in the field. True when the field took it from the browser. */
async function press(field: HTMLElement, key: string, mods: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })
  await act(async () => field.dispatchEvent(event))
  return event.defaultPrevented
}

describe('the settings text field', () => {
  it('saves a single-line field on Enter', async () => {
    const onCommit = vi.fn()
    const field = await typed(false, onCommit, 'Sensor array')
    expect(await press(field, 'Enter')).toBe(true)
    expect(onCommit).toHaveBeenCalledWith('Sensor array')
    expect(document.activeElement).not.toBe(field)
  })

  it('saves nothing on Ctrl+Enter or Cmd+Enter in a multi-line field, and saves it on blur', async () => {
    const onCommit = vi.fn()
    const field = await typed(true, onCommit, 'Sensor array')
    expect(await press(field, 'Enter', { ctrlKey: true })).toBe(false)
    expect(await press(field, 'Enter', { metaKey: true })).toBe(false)
    expect(onCommit).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(field)
    expect(field.value).toBe('Sensor array')
    await act(async () => field.blur())
    expect(onCommit).toHaveBeenCalledWith('Sensor array')
  })

  it('puts the stored text back on Escape in a multi-line field', async () => {
    const onCommit = vi.fn()
    const field = await typed(true, onCommit, 'Sensor array')
    expect(await press(field, 'Escape')).toBe(true)
    expect(field.value).toBe('Sensor')
    await act(async () => field.blur())
    expect(onCommit).not.toHaveBeenCalled()
  })
})
