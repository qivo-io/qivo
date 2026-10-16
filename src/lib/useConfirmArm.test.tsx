// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CONFIRM_DISARM_MS, CONFIRM_IGNORE_MS, useConfirmArm } from './useConfirmArm'

let container: HTMLDivElement
let root: Root
const action = vi.fn<(key: string) => void>()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // Date moves with the timers, since the hook times clicks with Date.now()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  action.mockReset()
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

/* Two rows that share one hook, as the settings lists do. */
function Rows() {
  const confirm = useConfirmArm<string>()
  return ['a', 'b'].map((key) => (
    <Button
      key={key}
      type="button"
      data-row={key}
      onClick={() => confirm.press(key, () => action(key))}
    >
      {confirm.armed === key ? 'Delete?' : 'Delete'}
    </Button>
  ))
}

const row = (key: string) => container.querySelector<HTMLButtonElement>(`[data-row="${key}"]`)!
const isArmed = (key: string) => row(key).textContent === 'Delete?'
const render = () =>
  act(async () =>
    root.render(
      <TooltipProvider>
        <Rows />
      </TooltipProvider>,
    ),
  )
const click = (key: string) => act(async () => row(key).click())
const wait = (ms: number) => act(async () => vi.advanceTimersByTime(ms))

describe('useConfirmArm', () => {
  it('ignores a second click within the pause and stays armed', async () => {
    await render()
    await click('a')
    await wait(CONFIRM_IGNORE_MS - 1)
    await click('a')
    expect(action).not.toHaveBeenCalled()
    expect(isArmed('a')).toBe(true)
  })

  it('treats an arm past its lapse as gone even when the timer runs late', async () => {
    await render()
    await click('a')
    // the clock passes the lapse without the timer firing, as in a throttled tab
    await act(async () => vi.setSystemTime(Date.now() + CONFIRM_DISARM_MS))
    await click('a')
    expect(action).not.toHaveBeenCalled()
    expect(isArmed('a')).toBe(true)
    await wait(CONFIRM_IGNORE_MS)
    await click('a')
    expect(action).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('confirms once on a click when the pause ends', async () => {
    await render()
    await click('a')
    await wait(CONFIRM_IGNORE_MS)
    await click('a')
    expect(action).toHaveBeenCalledExactlyOnceWith('a')
    expect(isArmed('a')).toBe(false)
    // the next click starts over
    await click('a')
    expect(action).toHaveBeenCalledTimes(1)
    expect(isArmed('a')).toBe(true)
  })

  it('disarms when the arm lapses, and an ignored click does not extend it', async () => {
    await render()
    await click('a')
    await wait(100)
    await click('a')
    await wait(CONFIRM_DISARM_MS - 101)
    expect(isArmed('a')).toBe(true)
    await wait(1)
    expect(isArmed('a')).toBe(false)
    await click('a')
    expect(action).not.toHaveBeenCalled()
  })

  it('arming another row disarms the first and starts its own clock', async () => {
    await render()
    await click('a')
    await wait(3000)
    await click('b')
    expect(isArmed('a')).toBe(false)
    expect(isArmed('b')).toBe(true)
    await wait(CONFIRM_DISARM_MS - 1)
    expect(isArmed('b')).toBe(true)
    await wait(1)
    expect(isArmed('b')).toBe(false)
    expect(action).not.toHaveBeenCalled()
  })

  it('confirms at most once for two clicks in one task', async () => {
    await render()
    // before a re-render, a double click on a resting row only arms it
    await act(async () => {
      row('a').click()
      row('a').click()
    })
    expect(action).not.toHaveBeenCalled()
    expect(isArmed('a')).toBe(true)

    // on an armed row the first confirms and the second arms again, with a
    // fresh clock
    await wait(CONFIRM_IGNORE_MS)
    await act(async () => {
      row('a').click()
      row('a').click()
    })
    expect(action).toHaveBeenCalledExactlyOnceWith('a')
    expect(isArmed('a')).toBe(true)
    await wait(CONFIRM_DISARM_MS - 1)
    expect(isArmed('a')).toBe(true)
    await wait(1)
    expect(isArmed('a')).toBe(false)
  })
})
