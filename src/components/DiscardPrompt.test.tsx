// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUnsentScope, type UnsentScope } from '../lib/leaveGuard'
import { closeOrAsk, DiscardPrompt } from './DiscardPrompt'
import { TooltipProvider } from './ui/tooltip'

/* The question before a window closes with unsent text: none while the
   window holds nothing, Keep editing keeps it open, Discard closes. */

let container: HTMLDivElement
let root: Root
let scope: UnsentScope

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  scope = createUnsentScope()
  await act(async () =>
    root.render(
      <TooltipProvider>
        <DiscardPrompt />
      </TooltipProvider>,
    ),
  )
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const prompt = () => document.querySelector('[data-discard-prompt]')
/** Asks to close, and lets the one tick pass that a blur's save gets. */
async function close(go: () => void) {
  let now = false
  await act(async () => {
    now = closeOrAsk([scope], go)
    vi.runAllTimers()
  })
  return now
}
const press = (selector: string) =>
  act(async () => document.querySelector<HTMLElement>(selector)?.click())

describe('closing a window with unsent text', () => {
  it('closes at once while the window holds nothing', async () => {
    const go = vi.fn()
    expect(await close(go)).toBe(true)
    expect(go).toHaveBeenCalledTimes(1)
    expect(prompt()).toBeNull()
  })

  it('asks what to do, keeps the text on Keep editing and closes on Discard', async () => {
    scope.hold('comment')
    scope.hold('title')
    const go = vi.fn()
    expect(await close(go)).toBe(false)
    expect(prompt()?.textContent).toContain('Discard your unsent comment and title?')
    await press('[data-discard-keep]')
    expect(prompt()).toBeNull()
    expect(go).not.toHaveBeenCalled()
    expect(scope.held()).toEqual(['comment', 'title'])

    await close(go)
    await press('[data-discard-confirm]')
    expect(go).toHaveBeenCalledTimes(1)
    expect(prompt()).toBeNull()
    // the window closing next finds nothing left to ask about
    expect(scope.held()).toEqual([])
  })

  it('returns focus to the text field after a close button took it', async () => {
    const field = document.createElement('textarea')
    const button = document.createElement('button')
    document.body.append(field, button)
    field.focus()
    // a press on the close button moves focus to it first
    button.focus()
    scope.hold('comment')
    await close(vi.fn())
    await press('[data-discard-keep]')
    await act(async () => vi.runAllTimers())
    expect(document.activeElement).toBe(field)
  })

  it('closes without asking when the text was saved by the blur the close caused', async () => {
    const saved = scope.hold('remaining hours')
    const go = vi.fn()
    let now = true
    await act(async () => {
      now = closeOrAsk([scope], go)
      saved()
      vi.runAllTimers()
    })
    expect(now).toBe(false)
    expect(go).toHaveBeenCalledTimes(1)
    expect(prompt()).toBeNull()
  })
})
