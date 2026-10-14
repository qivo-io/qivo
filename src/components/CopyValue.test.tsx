// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { COPIED_MS, CopyValue } from './CopyValue'
import { TooltipProvider } from './ui/tooltip'

// Icon lives beside the shared controls that import the planner; this
// component needs none of it and must not start an application data client.
vi.mock('../store/planner', () => ({ P: {} }))

const URL_VALUE = 'https://api.qivo.io/mcp'
let container: HTMLDivElement
let root: Root
let writeText: Mock<(text: string) => Promise<void>>
let showToast: Mock<NonNullable<Window['showToast']>>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  showToast = vi.fn<NonNullable<Window['showToast']>>()
  window.showToast = showToast
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  window.showToast = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function render(value = URL_VALUE) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <CopyValue value={value} label="Copy address" data-probe="" />
      </TooltipProvider>,
    ),
  )
}

/* The click handler awaits the clipboard before it sets state. */
async function click(element: Element) {
  await act(async () => {
    ;(element as HTMLElement).click()
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

const glyph = () => container.querySelector('svg')?.getAttribute('class') ?? ''

describe('CopyValue', () => {
  it('copies the whole value from one button and shows the check for two seconds', async () => {
    await render()
    const button = container.querySelector('button[data-probe]')
    expect(button?.textContent).toBe(`Copy address ${URL_VALUE}`)
    expect(glyph()).toContain('lucide-copy')

    await click(button!)
    expect(writeText).toHaveBeenCalledWith(URL_VALUE)
    expect(glyph()).toContain('lucide-check')
    expect(showToast).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTime(COPIED_MS - 1))
    expect(glyph()).toContain('lucide-check')
    await act(async () => vi.advanceTimersByTime(1))
    expect(glyph()).toContain('lucide-copy')
  })

  it('turns a refused copy into focused, selected text and reports it', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    await render('qvt_secret')
    const button = container.querySelector('button')!
    button.focus()
    await click(button)

    expect(container.querySelector('button')).toBeNull()
    const text = container.querySelector('code[data-probe]')
    expect(text?.textContent).toBe('qvt_secret')
    expect(text?.className).toContain('select-all')
    expect(document.activeElement).toBe(text)
    expect(window.getSelection()?.toString()).toBe('qvt_secret')
    expect(showToast).toHaveBeenCalledWith(
      "Couldn't copy. Copy the selected text instead.",
      'error',
    )

    // Leaving and coming back by keyboard selects it again.
    const fallback = text as HTMLElement
    fallback.blur()
    window.getSelection()?.removeAllRanges()
    expect(fallback.tabIndex).toBe(0)
    // jsdom's focus() clears the selection after the focus handlers run, so
    // deliver the focus event the handler listens for instead.
    await act(async () => fallback.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
    expect(window.getSelection()?.toString()).toBe('qvt_secret')
  })

  it('reports only the latest of overlapping copies', async () => {
    const settle: { resolve: () => void; reject: (e: Error) => void }[] = []
    writeText.mockImplementation(
      () => new Promise<void>((resolve, reject) => settle.push({ resolve, reject })),
    )
    await render()
    const button = container.querySelector('button')!
    await click(button)
    await click(button)
    expect(settle).toHaveLength(2)

    // The newer write succeeds first, then the older one fails.
    await act(async () => settle[1].resolve())
    await act(async () => settle[0].reject(new Error('denied')))
    expect(glyph()).toContain('lucide-check')
    expect(container.querySelector('code')).toBeNull()
    expect(showToast).not.toHaveBeenCalled()

    // The check still lasts its full two seconds.
    await act(async () => vi.advanceTimersByTime(COPIED_MS - 1))
    expect(glyph()).toContain('lucide-check')
  })

  it('ignores a pending copy of a value that has since been replaced', async () => {
    let fail!: (e: Error) => void
    writeText.mockImplementation(() => new Promise<void>((_, reject) => (fail = reject)))
    await render('qvt_old')
    await click(container.querySelector('button')!)

    await render('qvt_new')
    await act(async () => fail(new Error('denied')))
    expect(showToast).not.toHaveBeenCalled()
    expect(container.querySelector('button')?.textContent).toBe('Copy address qvt_new')
  })

  it('reports nothing for a copy still pending when the value leaves the screen', async () => {
    let fail!: (e: Error) => void
    writeText.mockImplementation(() => new Promise<void>((_, reject) => (fail = reject)))
    await render('qvt_secret')
    await click(container.querySelector('button')!)

    await act(async () => root.render(null))
    await act(async () => fail(new Error('denied')))
    expect(showToast).not.toHaveBeenCalled()
  })

  it('starts without the old outcome when a new value replaces this one', async () => {
    await render('qvt_first')
    await click(container.querySelector('button')!)
    expect(glyph()).toContain('lucide-check')

    await render('qvt_second')
    expect(glyph()).toContain('lucide-copy')

    writeText.mockRejectedValue(new Error('denied'))
    await click(container.querySelector('button')!)
    expect(container.querySelector('code')).not.toBeNull()
    await render('qvt_third')
    expect(container.querySelector('button')?.textContent).toBe('Copy address qvt_third')
  })

  it('keeps each word of a command whole and lets a single token break anywhere', async () => {
    const command = 'claude mcp add --header "Authorization: Bearer qvt_x"'
    await render(command)
    const text = container.querySelector('[translate="no"]')!
    expect(text.textContent).toBe(command)
    const words = Array.from(text.querySelectorAll('span.inline-block'), (w) => w.textContent)
    expect(words).toEqual([
      'claude',
      'mcp',
      'add',
      '--header',
      '"Authorization:',
      'Bearer',
      'qvt_x"',
    ])

    await render(URL_VALUE)
    expect(container.querySelectorAll('[translate="no"] span.inline-block')).toHaveLength(0)
    expect(container.querySelector('[translate="no"] > span')?.className).toBe('break-all')
  })
})
