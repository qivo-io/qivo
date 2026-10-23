import { Activity, memo, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLatest } from '@/lib/useLatest'
import { createHiddenState, HiddenViewContext } from '@/lib/viewHidden'
import { createTeardown, TeardownContext } from '@/lib/viewTeardown'

/* The Board stays loaded while every other page of its scope shows:
   opening it again shows it as it was, without mounting its cards again.
   While hidden it sits after the shown view, in React's Activity, which
   stops its effects (its timers, observers and listeners) and renders its
   updates only when nothing else waits. It does not render for its
   parent's new props until it shows again. Its floating layers
   (lib/viewHidden.ts) close a commit before the rest hides, so no pop-up
   of it stays in the page.

   Activity hides its elements with `display: none`, which makes the browser
   tear down the layout of every element in it and build it again on show:
   at 10,000 tasks that cost more than mounting the Board. So the container
   hides them with `content-visibility: hidden`, which keeps their layout
   and their scroll positions but skips drawing, finding and reading them,
   and takes back the `display: none` that Activity puts on its own
   elements, before the browser lays anything out: in the commit that
   hides, and after any render inside while hidden, which puts it back.
   Hidden that way, its elements take no focus, Tab passes them, and find
   in page and screen readers do not reach them. The container has
   data-hidden-view in place of data-workspace-view, so what looks for the
   shown view's elements, or puts focus back (lib/viewHidden.ts OUT_OF_USE),
   passes it by. It is not `inert` and keeps its pointer events: both are
   inherited, so changing either would restyle every element of the Board
   when it shows again.

   When its scope goes, the kept Board leaves (ViewKeeper): it stays hidden
   until the next view has painted, then comes apart a slice at a time
   (lib/viewTeardown.ts) before it goes. */

/** A hidden view takes no room and draws nothing. */
const HIDDEN = '[content-visibility:hidden] !h-0 ![flex:none]'

/** What `children` rendered last while `frozen` was false. */
const Frozen = memo(
  function Frozen({ children }: { frozen: boolean; children: ReactNode }) {
    return children
  },
  (_, next) => next.frozen,
)

/** Shows `children` as the workspace view `view` while `shown`, in a
    container styled with `className`; while not shown, keeps it mounted,
    hidden and inactive. Once `leaving`, it comes apart in slices after it
    has hidden, then calls `onGone`. */
export function KeptView({
  view,
  shown,
  leaving = false,
  onGone,
  className,
  children,
}: {
  view: string
  shown: boolean
  leaving?: boolean
  onGone?: () => void
  className: string
  children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const [hidden] = useState(createHiddenState)
  const [teardown] = useState(() => createTeardown())
  // hiding takes two commits: the layers close, then Activity hides the rest
  const [mode, setMode] = useState<'visible' | 'closing' | 'hidden'>('visible')
  if (shown && mode !== 'visible') setMode('visible')
  useLayoutEffect(() => {
    if (shown) {
      hidden.set(false)
      teardown.hold(false)
    } else if (mode === 'visible') {
      hidden.set(true)
      setMode('closing')
    } else if (mode === 'closing') {
      // the hide runs every effect's cleanup, which must not drop the parts
      teardown.hold(true)
      setMode('hidden')
    } else {
      teardown.hold(false)
      undoDisplayNone(box.current)
    }
  }, [shown, mode, hidden, teardown])
  useLayoutEffect(() => {
    const element = box.current
    if (mode !== 'hidden' || !element) return
    // a render inside the hidden view, such as a slice, commits on its own
    const watch = new MutationObserver((records) => {
      undoDisplayNone(element)
      if (records.some((record) => record.type === 'childList')) teardown.committed()
    })
    watch.observe(element, { subtree: true, childList: true, attributeFilter: ['style'] })
    return () => watch.disconnect()
  }, [mode, teardown])
  const gone = useLatest(() => onGone?.())
  useEffect(
    () => (leaving && mode === 'hidden' ? teardown.leave(gone) : undefined),
    [leaving, mode, teardown, gone],
  )
  return (
    <div
      ref={box}
      data-workspace-view={shown ? view : undefined}
      data-hidden-view={shown ? undefined : view}
      className={shown ? className : `${className} ${HIDDEN}`}
    >
      <HiddenViewContext.Provider value={hidden}>
        <TeardownContext.Provider value={teardown}>
          <Activity mode={mode === 'hidden' ? 'hidden' : 'visible'}>
            <Frozen frozen={!shown}>{children}</Frozen>
          </Activity>
        </TeardownContext.Provider>
      </HiddenViewContext.Provider>
    </div>
  )
}

/** Takes back the inline `display: none` Activity gave the elements at the
    top of `container`. */
function undoDisplayNone(container: Element | null) {
  for (const element of container?.children ?? [])
    if (element instanceof HTMLElement && element.style.display === 'none')
      element.style.removeProperty('display')
}

/** One kept view: `n` tells apart the times the same `id` was kept. */
type Slot = { n: number; id: string }

/** Keeps the view of `id` loaded (KeptView), shown while `shown`, and
    `children` its content. When `id` changes, or turns null, the view of
    the old one leaves: it stays hidden after the current one until the next
    view has painted, then comes apart in slices and goes. */
export function ViewKeeper({
  id,
  view,
  shown,
  className,
  children,
}: {
  id: string | null
  view: string
  shown: boolean
  className: string
  children: ReactNode
}) {
  const [slots, setSlots] = useState(() => ({
    current: id === null ? null : { n: 0, id },
    leaving: [] as Slot[],
    next: 1,
  }))
  if ((slots.current?.id ?? null) !== id)
    setSlots({
      current: id === null ? null : { n: slots.next, id },
      leaving: slots.current ? [...slots.leaving, slots.current] : slots.leaving,
      next: slots.next + 1,
    })
  const gone = (n: number) =>
    setSlots((before) => ({ ...before, leaving: before.leaving.filter((slot) => slot.n !== n) }))
  // the current view first, for whatever looks for its elements in the page
  const all = slots.current ? [slots.current, ...slots.leaving] : slots.leaving
  return all.map((slot) => {
    const current = slot === slots.current
    return (
      <KeptView
        key={slot.n}
        view={view}
        shown={current && shown}
        leaving={!current}
        onGone={() => gone(slot.n)}
        className={className}
      >
        {current ? children : null}
      </KeptView>
    )
  })
}
