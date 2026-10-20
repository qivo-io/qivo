// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Input } from '../components/ui/input'
import { TooltipProvider } from '../components/ui/tooltip'
import { hasUnsaved, useFieldUnsaved } from './leaveGuard'

/* A field that saves on blur keeps the close warning while a refused save
   leaves its typed text in place, and drops it once nothing is unsent. */

let paused = false
let container: HTMLDivElement
let root: Root

function Field({ saved = '16' }: { saved?: string }) {
  const unsaved = useFieldUnsaved(() => paused, saved)
  return (
    <TooltipProvider>
      <Input aria-label="Hours" type="number" key={saved} defaultValue={saved} {...unsaved} />
    </TooltipProvider>
  )
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  paused = false
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<Field />))
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Types `value` into the field and leaves it, as a person would. */
async function typeAndLeave(value: string) {
  const field = container.querySelector('input') as HTMLInputElement
  await act(async () => {
    field.focus()
    field.value = value
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(hasUnsaved()).toBe(true)
  await act(async () => {
    field.blur()
    vi.runAllTimers()
  })
}

describe('useFieldUnsaved', () => {
  it('keeps the warning while a paused save leaves the typed text', async () => {
    paused = true
    await typeAndLeave('12')
    expect(hasUnsaved()).toBe(true)
    // put back by hand: nothing left to send
    await typeAndLeave('16')
    expect(hasUnsaved()).toBe(false)
  })

  it('drops the warning when a new saved value replaces the draft, or the same number is typed', async () => {
    paused = true
    await typeAndLeave('12')
    await act(async () => root.render(<Field saved="20" />))
    expect(hasUnsaved()).toBe(false)
    await typeAndLeave('20.0')
    expect(hasUnsaved()).toBe(false)
  })

  it('drops the warning once the save went out', async () => {
    await typeAndLeave('12')
    expect(hasUnsaved()).toBe(false)
  })
})
