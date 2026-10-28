// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../../../convex/lib/limits'
import { TooltipProvider } from '../../components/ui/tooltip'
import { TextField } from './controls'

/* The keys of the settings text field. Enter saves a single-line field. A
   multi-line field saves only when it loses focus: Ctrl+Enter and Cmd+Enter
   stay the browser's, and Escape puts the stored text back. While a value
   changed elsewhere shows under the field, Enter and blur save nothing and
   keep the text, and Escape still puts the stored text back. */

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

/* Renders the field with `stored` saved. */
async function show(multiline: boolean, onCommit: (v: string) => void, stored = 'Sensor') {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <TextField
          label="Description"
          record="sensor"
          value={stored}
          multiline={multiline}
          limit={LIMITS.projectDescription}
          onCommit={onCommit}
        />
      </TooltipProvider>,
    ),
  )
}

/* Renders the field with "Sensor" stored, focuses it and types `text`. */
async function typed(multiline: boolean, onCommit: (v: string) => void, text: string) {
  await show(multiline, onCommit)
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
    expect(onCommit).toHaveBeenCalledWith(
      'Sensor array',
      expect.objectContaining({ seen: 'Sensor' }),
    )
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
    expect(onCommit).toHaveBeenCalledWith(
      'Sensor array',
      expect.objectContaining({ seen: 'Sensor' }),
    )
  })

  it('puts the stored text back on Escape in a multi-line field', async () => {
    const onCommit = vi.fn()
    const field = await typed(true, onCommit, 'Sensor array')
    expect(await press(field, 'Escape')).toBe(true)
    expect(field.value).toBe('Sensor')
    await act(async () => field.blur())
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('saves nothing on Enter or blur while a change made elsewhere shows, and keeps the text', async () => {
    for (const multiline of [false, true]) {
      const onCommit = vi.fn()
      const field = await typed(multiline, onCommit, 'Sensor array')
      // another session saves the description
      await show(multiline, onCommit, 'Sensor kit')
      const conflict = container.querySelector('[data-draft-conflict]')
      expect(conflict?.textContent).toContain('Changed elsewhere to “Sensor kit”.')
      expect(field.getAttribute('aria-describedby')).toBe(conflict?.id)
      if (!multiline) expect(await press(field, 'Enter')).toBe(true)
      await act(async () => field.blur())
      expect(onCommit).not.toHaveBeenCalled()
      expect(field.value).toBe('Sensor array')
      expect(container.querySelector('[data-draft-conflict]')).not.toBeNull()
      await act(async () => root.render(null))
    }
  })

  it('puts the stored text back on Escape while a change made elsewhere shows', async () => {
    const onCommit = vi.fn()
    const field = await typed(true, onCommit, 'Sensor array')
    await show(true, onCommit, 'Sensor kit')
    expect(await press(field, 'Escape')).toBe(true)
    expect(field.value).toBe('Sensor kit')
    expect(container.querySelector('[data-draft-conflict]')).toBeNull()
    await act(async () => field.blur())
    expect(onCommit).not.toHaveBeenCalled()
  })
})
