import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { announce, installAnnouncer } from './announce'

/* Just enough of the DOM for the announcer: elements with attributes and
   children, and querySelector for attribute selectors joined by spaces. */
class FakeElement {
  attributes = new Map<string, string>()
  children: FakeElement[] = []
  parent: FakeElement | null = null
  className = ''
  textContent = ''
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null
  }
  append(...nodes: FakeElement[]) {
    for (const node of nodes) Object.assign(node, { parent: this })
    this.children.push(...nodes)
  }
  prepend(node: FakeElement) {
    node.parent = this
    this.children.unshift(node)
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this)
    this.parent = null
  }
  matches(part: string) {
    const [, name, value] = part.match(/^\[([\w-]+)(?:="(.*)")?\]$/) ?? []
    return (
      !!name &&
      this.attributes.has(name) &&
      (value === undefined || this.getAttribute(name) === value)
    )
  }
  *descendants(): Generator<FakeElement> {
    for (const child of this.children) {
      yield child
      yield* child.descendants()
    }
  }
  querySelector(selector: string): FakeElement | null {
    const [first, ...rest] = selector.split(' ')
    for (const el of this.descendants()) {
      if (!el.matches(first)) continue
      const found = rest.length ? el.querySelector(rest.join(' ')) : el
      if (found) return found
    }
    return null
  }
}

describe('announce', () => {
  let body: FakeElement

  beforeEach(() => {
    vi.useFakeTimers()
    body = new FakeElement()
    vi.stubGlobal('document', {
      body,
      createElement: () => new FakeElement(),
      querySelector: (selector: string) => body.querySelector(selector),
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const region = (politeness: string) =>
    body.querySelector(`[data-live-announcer] [aria-live="${politeness}"]`)!
  const said = (politeness: string) => region(politeness).children.map((m) => m.textContent)

  it('installs one polite and one assertive log region, once', () => {
    const dispose = installAnnouncer()
    installAnnouncer()
    expect(body.children).toHaveLength(1)
    for (const politeness of ['polite', 'assertive'])
      expect(region(politeness).getAttribute('role')).toBe('log')
    dispose()
    expect(body.children).toHaveLength(0)
  })

  it('adds each message as a new node in the region for its politeness', () => {
    installAnnouncer()
    announce('Saved')
    announce('Saved')
    announce("Couldn't save", 'assertive')
    expect(said('polite')).toEqual(['Saved', 'Saved'])
    expect(said('assertive')).toEqual(["Couldn't save"])
  })

  it('removes a message after it has been read', () => {
    installAnnouncer()
    announce('Saved')
    vi.advanceTimersByTime(6999)
    expect(said('polite')).toEqual(['Saved'])
    vi.advanceTimersByTime(1)
    expect(said('polite')).toEqual([])
  })

  it('does nothing before the regions are installed', () => {
    expect(() => announce('Saved')).not.toThrow()
    expect(body.children).toHaveLength(0)
  })
})
