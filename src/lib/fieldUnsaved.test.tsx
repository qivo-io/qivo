// @vitest-environment jsdom
import { Activity, act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiscardPrompt } from '../components/DiscardPrompt'
import { Input } from '../components/ui/input'
import { TooltipProvider } from '../components/ui/tooltip'
import { closeOrAsk } from './discardQuestion'
import {
  createUnsentScope,
  DISCARD_MS,
  hasUnsaved,
  UnsentScopeContext,
  useFieldUnsaved,
} from './leaveGuard'

/* A field that saves on blur keeps the close warning while a refused save
   leaves its typed text in place, and drops it once nothing is unsent. A
   Discard puts its saved value back, for a field that stays in the page. */

let paused = false
let container: HTMLDivElement
let root: Root

function Field({ saved = '16', what }: { saved?: string; what?: string }) {
  const unsaved = useFieldUnsaved(() => paused, saved, what)
  // the field refuses a number over 100 on blur and marks itself, as the
  // settings' number fields do
  const [refused, setRefused] = useState(false)
  return (
    <TooltipProvider>
      <Input
        aria-label="Hours"
        type="number"
        key={saved}
        defaultValue={saved}
        aria-invalid={refused || undefined}
        {...unsaved}
        onChange={() => setRefused(false)}
        onBlur={(e) => setRefused(Number(e.target.value) > 100)}
      />
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
  // the blur's own render commits before its timer runs, as in a browser
  await act(async () => field.blur())
  await act(async () => vi.runAllTimers())
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

  it('keeps the warning while the field refused the typed number', async () => {
    await typeAndLeave('120')
    expect(hasUnsaved()).toBe(true)
    await typeAndLeave('16')
    expect(hasUnsaved()).toBe(false)
  })

  it('drops the warning once the save went out', async () => {
    await typeAndLeave('12')
    expect(hasUnsaved()).toBe(false)
  })

  it('lets a close go without asking when the field holds its saved value again', async () => {
    const page = createUnsentScope()
    await act(async () =>
      root.render(
        <>
          <UnsentScopeContext.Provider value={page}>
            <Field what="plannable hours" />
          </UnsentScopeContext.Provider>
          <TooltipProvider>
            <DiscardPrompt />
          </TooltipProvider>
        </>,
      ),
    )
    const field = container.querySelector('input') as HTMLInputElement
    await act(async () => {
      field.focus()
      field.value = '16'
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(page.held()).toEqual(['plannable hours'])
    const go = vi.fn()
    // the close leaves the field, whose blur ends the lease before the check
    await act(async () => {
      closeOrAsk([page], go)
      vi.runAllTimers()
    })
    expect(go).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-discard-prompt]')).toBeNull()
  })

  it('names the field in the window it is in while a paused save keeps it', async () => {
    const page = createUnsentScope()
    await act(async () =>
      root.render(
        <UnsentScopeContext.Provider value={page}>
          <Field what="plannable hours" />
        </UnsentScopeContext.Provider>,
      ),
    )
    paused = true
    await typeAndLeave('12')
    expect(page.held()).toEqual(['plannable hours'])
    paused = false
    await typeAndLeave('16')
    expect(page.held()).toEqual([])
  })
  it('puts the saved value back on a Discard, for a field that stays in the page', async () => {
    const page = createUnsentScope()
    await act(async () =>
      root.render(
        <UnsentScopeContext.Provider value={page}>
          <Field what="remaining hours" />
        </UnsentScopeContext.Provider>,
      ),
    )
    paused = true
    await typeAndLeave('42')
    await act(async () => page.discard())
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('16')
    expect(hasUnsaved()).toBe(false)
    await act(async () => vi.advanceTimersByTime(DISCARD_MS))
    expect(page.held()).toEqual([])
  })

  it('keeps the draft of a page that hides and shows again', async () => {
    const page = createUnsentScope()
    const render = (mode: 'visible' | 'hidden') =>
      act(async () =>
        root.render(
          <UnsentScopeContext.Provider value={page}>
            <Activity mode={mode}>
              <Field what="remaining hours" />
            </Activity>
          </UnsentScopeContext.Provider>,
        ),
      )
    await render('visible')
    paused = true
    await typeAndLeave('42')
    await render('hidden')
    await render('visible')
    expect(page.held()).toEqual(['remaining hours'])
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('42')
  })
})
