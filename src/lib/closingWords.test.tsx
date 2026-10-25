// @vitest-environment jsdom
import { act, Suspense, startTransition, use, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useClosingWords } from './closingWords'

/* A window's words while it closes: those of the last open render that
   React committed, never those of a render it dropped. */

// a load that never ends, so a transition that waits for it never commits
const neverLoads = new Promise<never>(() => {})

/** Suspends for good. */
function Loading() {
  use(neverLoads)
  return null
}

/** What the test does to the selection. */
let selection: {
  pick: (name: string) => void
  pickLater: (name: string) => void
  close: () => void
}

/** A window naming its selection, open while it has one. */
function Window() {
  const [name, setName] = useState('Alpha')
  const [loading, setLoading] = useState(false)
  const shown = useClosingWords(name !== '', name)
  useEffect(() => {
    selection = {
      pick: setName,
      // a selection whose render waits for a load
      pickLater: (next) =>
        startTransition(() => {
          setName(next)
          setLoading(true)
        }),
      close: () => setName(''),
    }
  }, [])
  return (
    <Suspense fallback={null}>
      <p data-title>Delete {shown} connection?</p>
      {loading && <Loading />}
    </Suspense>
  )
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})

const title = () => container.querySelector('[data-title]')?.textContent

describe('useClosingWords', () => {
  it('shows the words of the last open render while it closes', () => {
    act(() => root.render(<Window />))
    act(() => selection.pick('Beta'))
    expect(title()).toBe('Delete Beta connection?')
    act(() => selection.close())
    expect(title()).toBe('Delete Beta connection?')
    act(() => selection.pick('Gamma'))
    expect(title()).toBe('Delete Gamma connection?')
  })

  it('never shows the words of an open render that React dropped', async () => {
    act(() => root.render(<Window />))
    // the transition's render names Beta, then waits for good, so React
    // drops it and the window still names Alpha
    await act(async () => selection.pickLater('Beta'))
    expect(title()).toBe('Delete Alpha connection?')
    // React retries the waiting transition after the close
    await act(async () => selection.close())
    expect(title()).toBe('Delete Alpha connection?')
  })
})
