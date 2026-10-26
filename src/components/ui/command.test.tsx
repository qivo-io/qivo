// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Command, CommandInput, CommandItem, CommandList } from './command'

/* The keys of a command list, which the palette, the assignee picker and the
   admin Backgrounds picker use. The arrows move the selection and Enter
   chooses it. cmdk's Ctrl+N, J, P and K move nothing and stay the browser's,
   so Ctrl+P in the palette prints the page. */

let container: HTMLDivElement
let root: Root
let chosen: string[]

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // cmdk measures its list and scrolls the selected row into view
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  Element.prototype.scrollIntoView = () => {}
  chosen = []
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <Command label="People">
        <CommandInput aria-label="Find a person" />
        <CommandList>
          {['Ada', 'Bo', 'Cy'].map((name) => (
            <CommandItem key={name} value={name} onSelect={(value) => chosen.push(value)}>
              {name}
            </CommandItem>
          ))}
        </CommandList>
      </Command>,
    ),
  )
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const input = () => {
  const field = container.querySelector<HTMLInputElement>('[aria-label="Find a person"]')
  if (!field) throw new Error('missing the search field')
  return field
}
const selected = () => container.querySelector('[cmdk-item][data-selected="true"]')?.textContent

/* Presses a key in the search field and returns the event, to read whether
   anything took it from the browser. */
async function press(key: string, ctrlKey = false) {
  const event = new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true, cancelable: true })
  await act(async () => input().dispatchEvent(event))
  return event
}

describe('command list keys', () => {
  it('moves with the arrows and chooses with Enter', async () => {
    expect(selected()).toBe('Ada')
    expect((await press('ArrowDown')).defaultPrevented).toBe(true)
    expect(selected()).toBe('Bo')
    await press('ArrowDown')
    await press('ArrowUp')
    expect(selected()).toBe('Bo')
    await press('Enter')
    expect(chosen).toEqual(['Bo'])
  })

  it('leaves Ctrl+N, J, P and K to the browser', async () => {
    await press('ArrowDown')
    for (const key of ['n', 'j', 'p', 'k']) {
      const event = await press(key, true)
      expect(event.defaultPrevented, `Ctrl+${key.toUpperCase()}`).toBe(false)
      expect(selected(), `Ctrl+${key.toUpperCase()}`).toBe('Bo')
    }
    expect(chosen).toEqual([])
  })
})
