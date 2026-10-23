import { createContext, useContext, useSyncExternalStore } from 'react'

/** Whether a kept view (components/KeptView.tsx) is hidden, for the
    floating layers in it, which subscribe while they are mounted. A store
    rather than a context value: a new context value would make React walk
    the whole kept view to find the few layers that read it. */
export function createHiddenState() {
  let hidden = false
  const listeners = new Set<() => void>()
  return {
    get: () => hidden,
    set(next: boolean) {
      if (next === hidden) return
      hidden = next
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export type HiddenState = ReturnType<typeof createHiddenState>

/** The hidden state of the kept view the calling component is in, if any. */
export const HiddenViewContext = createContext<HiddenState | null>(null)

/** What takes an element out of use: an inert page behind a modal window,
    or a kept view (components/KeptView.tsx) hidden behind another page.
    The browser gives neither focus; what puts focus back skips both. */
export const OUT_OF_USE = '[inert], [data-hidden-view]'

const noSubscription = () => () => {}
const shown = () => false

/** Whether the kept view the calling layer is in is hidden. A floating
    layer (tooltip, popover, menu, dialog, pop) renders nothing then:
    portaled out of the view, it would stay in the page, where what asks
    whether a layer is open, such as Escape handling, would find it. */
export function useViewHidden() {
  const state = useContext(HiddenViewContext)
  return useSyncExternalStore(state?.subscribe ?? noSubscription, state?.get ?? shown)
}
