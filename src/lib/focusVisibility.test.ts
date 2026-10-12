import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isOpenSelectKey } from './focusVisibility'

/* Just enough of the DOM for the guard: closest('select') and :open. */
class FakeElement {
  constructor(
    private select: FakeElement | null,
    private open: boolean | 'unsupported' = false,
  ) {}
  closest(selector: string) {
    return selector === 'select' ? this.select : null
  }
  matches(selector: string) {
    if (selector !== ':open') return false
    if (this.open === 'unsupported') throw new SyntaxError(`'${selector}' is not a valid selector`)
    return this.open
  }
}

function selectWithOption(open: boolean | 'unsupported') {
  const select = new FakeElement(null, open)
  Object.assign(select, { closest: () => select })
  return { select, option: new FakeElement(select) }
}

describe('isOpenSelectKey', () => {
  beforeEach(() => {
    vi.stubGlobal('Element', FakeElement)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('claims every key pressed in an open list, from an option or the select', () => {
    const { select, option } = selectWithOption(true)
    for (const target of [option, select])
      expect(isOpenSelectKey({ target: target as unknown as Element })).toBe(true)
  })

  it('leaves keys to the page when the select is closed or absent', () => {
    const { option } = selectWithOption(false)
    expect(isOpenSelectKey({ target: option as unknown as Element })).toBe(false)
    const field = new FakeElement(null)
    expect(isOpenSelectKey({ target: field as unknown as Element })).toBe(false)
    expect(isOpenSelectKey({ target: null })).toBe(false)
  })

  it('treats a browser without :open as having no in-page list', () => {
    const { option } = selectWithOption('unsupported')
    expect(isOpenSelectKey({ target: option as unknown as Element })).toBe(false)
  })
})
