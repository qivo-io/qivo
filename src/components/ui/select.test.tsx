// @vitest-environment jsdom
import { act, useLayoutEffect } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHiddenState, HiddenViewContext } from '@/lib/viewHidden'
import { FieldSelect } from '../qivo'
import { TooltipProvider } from './tooltip'

/* A select in a kept page (components/KeptView): showing the page again
   does not wait for the select's closed list, and its trigger names the
   choice meanwhile. */

// FieldSelect's module reaches the store, which needs a connection
const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('@/lib/convex', async () => ({
  convex: network,
  live: (await import('@/store/guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('@/lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: null }) },
  signOut: vi.fn(),
}))

let container: HTMLDivElement
let root: Root
// the choices whose item is in the closed list now
const listed = new Set<string>()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  listed.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** An option's icon, which tells whether its item is in the list. */
function Listed({ id }: { id: string }) {
  useLayoutEffect(() => {
    listed.add(id)
    return () => {
      listed.delete(id)
    }
  }, [id])
  return null
}

const OPTIONS = ['all', 'one', 'two'].map((id) => ({
  value: id,
  label: `Scope ${id}`,
  icon: <Listed id={id} />,
}))

describe('a select in a kept page', () => {
  it('shows the page before its closed list comes back, and names the choice meanwhile', async () => {
    const hidden = createHiddenState()
    await act(async () =>
      root.render(
        <TooltipProvider>
          <HiddenViewContext.Provider value={hidden}>
            <FieldSelect value="two" options={OPTIONS} onChange={() => {}} aria-label="Scope" />
          </HiddenViewContext.Provider>
        </TooltipProvider>,
      ),
    )
    // the closed list holds every item, the selected one's icon also in the trigger
    expect([...listed].sort()).toEqual(['all', 'one', 'two'])
    await act(async () => hidden.set(true))
    expect(container.textContent).toContain('Scope two')

    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false)
    flushSync(() => hidden.set(false))
    // the render that shows the page has no list, and the trigger its choice
    expect(container.textContent).toContain('Scope two')
    expect(listed.has('one')).toBe(false)
    await vi.waitFor(() => expect([...listed].sort()).toEqual(['all', 'one', 'two']))
  })
})
