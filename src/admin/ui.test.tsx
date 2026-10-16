// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CONFIRM_DISARM_MS, CONFIRM_IGNORE_MS } from '@/lib/useConfirmArm'
import { ConfirmAction } from './ui'

let container: HTMLDivElement
let root: Root
const onConfirm = vi.fn()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  onConfirm.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const render = () =>
  act(async () =>
    root.render(
      <TooltipProvider>
        <ConfirmAction
          label="Cancel invite"
          confirmLabel="Click again to cancel"
          busyLabel="Cancelling…"
          onConfirm={onConfirm}
        />
      </TooltipProvider>,
    ),
  )
const button = () => container.querySelector('button')!
const armed = () => button().hasAttribute('data-armed')
const click = (detail = 1) =>
  act(async () => {
    button().dispatchEvent(new MouseEvent('click', { bubbles: true, detail }))
  })
const wait = (ms: number) => act(async () => vi.advanceTimersByTime(ms))

describe('ConfirmAction', () => {
  it('stays armed through a double click and disarms after 3.5 seconds', async () => {
    await render()
    // a browser's double click, two clicks a moment apart
    await click(1)
    await wait(120)
    await click(2)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(armed()).toBe(true)

    await wait(CONFIRM_DISARM_MS - 121)
    expect(armed()).toBe(true)
    await wait(1)
    expect(armed()).toBe(false)

    // a click after the pause confirms, once
    await click()
    await wait(CONFIRM_IGNORE_MS)
    await click()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(armed()).toBe(false)
  })
})
