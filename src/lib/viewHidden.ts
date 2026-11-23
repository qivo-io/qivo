import {
  createContext,
  type RefObject,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from 'react'

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

/** Gives the element of `ref`, which a kept view renders outside its own
    box, such as a row it portals into the shell's toolbar, the mark of the
    hidden view `view` (data-hidden-view) while that view hides, as the
    view's box has it, so what puts focus back passes the element by
    (OUT_OF_USE). The mark comes in the commit that hides the view, as
    KeptView tells its hidden state, before App's layout effects look at
    focus there; a mark React rendered would come a commit later, since a
    hidden view does not render for that commit. React's Activity hides
    the element itself. */
export function useHiddenViewMark(ref: RefObject<HTMLElement | null>, view: string) {
  const state = useContext(HiddenViewContext)
  useLayoutEffect(() => {
    if (!state) return
    const mark = () => {
      if (state.get()) ref.current?.setAttribute('data-hidden-view', view)
      else ref.current?.removeAttribute('data-hidden-view')
    }
    mark()
    return state.subscribe(mark)
  }, [state, ref, view])
}

const noSubscription = () => () => {}
const shown = () => false

/** Whether the kept view the calling layer is in is hidden. A floating
    layer (tooltip, popover, menu, dialog, pop) renders nothing then:
    portaled out of the view, it would stay in the page, where what asks
    whether a layer is open, such as Escape handling, would find it. A
    closed layer (`open` false) draws nothing anyway, so it does not ask:
    a page holds hundreds of closed tooltips and popovers, which then do
    not render as it hides and shows. */
export function useViewHidden(open = true) {
  const context = useContext(HiddenViewContext)
  const state = open ? context : null
  return useSyncExternalStore(state?.subscribe ?? noSubscription, state?.get ?? shown)
}

/** Whether the tooltip or popover a content is in is open, as its root
    (components/ui) knows; true outside one. */
export const LayerOpenContext = createContext(true)

/** The `open` state of a Radix root, mirrored for LayerOpenContext, and the
    open props that keep it so. */
export function useLayerOpen({
  open,
  defaultOpen,
  onOpenChange,
}: {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [own, setOwn] = useState(defaultOpen ?? false)
  return {
    open: open ?? own,
    props: {
      open,
      defaultOpen,
      onOpenChange: (next: boolean) => {
        setOwn(next)
        onOpenChange?.(next)
      },
    },
  }
}
