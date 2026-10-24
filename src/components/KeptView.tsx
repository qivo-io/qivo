import { Activity, memo, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { settleHiddenBlocks } from '@/lib/keptBlocks'
import { postMessageTask } from '@/lib/postTask'
import { useLatest } from '@/lib/useLatest'
import { createHiddenState, HiddenViewContext } from '@/lib/viewHidden'
import { createTeardown, TeardownContext } from '@/lib/viewTeardown'

/* A main page stays loaded while the other pages show (lib/keptPages.ts):
   opening it again shows it as it was, without mounting it again. While
   hidden it sits beside the shown page, in React's Activity, which
   stops its effects (its timers, observers and listeners) and renders its
   updates only when nothing else waits. It does not render for its
   parent's new props until it shows again, and not in the task that shows
   it: that task shows it as it was, and the render for its parent's new
   props follows in a task of its own once that frame has painted, as the
   next update would, unless what it held was made for another variant
   (another layout, or another task in the Inbox's pane). The commit that
   hides it renders its parent's new content only when that is for another
   variant. Its floating
   layers (lib/viewHidden.ts) close a commit before the rest hides, so no
   pop-up of it stays in the page, and what it portals elsewhere, such as
   the Roadmap's toolbar row, Activity hides with `display: none`.

   Activity hides its elements with `display: none`, which makes the browser
   tear down the layout of every element in it and build it again on show:
   for a large Board that cost more than mounting it. So the container
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
   inherited, so changing either would restyle every element of the page
   when it shows again. Its blocks that skip their items while offscreen
   (DeferredList.tsx) skip them for good while it hides (lib/keptBlocks.ts).

   When it is no longer kept, as its scope went or the person left the app
   alone for a while, the page leaves (ViewKeeper): it stays hidden until the next view has painted, then
   comes apart a slice at a time (lib/viewTeardown.ts) before it goes. */

/** A hidden view takes no room and draws nothing. */
const HIDDEN = '[content-visibility:hidden] !h-0 ![flex:none]'

/** Runs `callback` in a task once the next frame has painted. */
const afterPaint = (callback: () => void) => requestAnimationFrame(() => postMessageTask(callback))

/** What `children` rendered last while `frozen` was false. */
const Frozen = memo(
  function Frozen({ children }: { frozen: boolean; children: ReactNode }) {
    return children
  },
  (_, next) => next.frozen,
)

/** Shows `children` as the workspace view `view` while `shown`, in a
    container styled with `className`; while not shown, keeps it mounted,
    hidden and inactive. Content kept for another `variant` (such as the
    phone's or the desktop's layout) is not shown as it was: the commit that
    shows it renders the new content. Once `leaving`, it comes apart in slices after it has
    hidden, then calls `onGone`. */
export function KeptView({
  view,
  shown,
  variant = '',
  leaving = false,
  onGone,
  className,
  children,
}: {
  view: string
  shown: boolean
  variant?: string
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
  // shown again, it shows what it held at once, and renders its parent's
  // new content in a task of its own once that has painted, unless what it
  // held was made for another variant. The commit that hides it renders the
  // new content when that is for another variant, so it holds that, such
  // as the Inbox without its task pane. Both refs follow committed renders.
  const [current, setCurrent] = useState(true)
  const heldFor = useRef(variant)
  const wasShown = useRef(shown)
  const stale = heldFor.current !== variant
  if (!shown && current) setCurrent(false)
  if (shown && !current && stale) setCurrent(true)
  const frozen = shown ? !current && !stale : !(stale && wasShown.current)
  useLayoutEffect(() => {
    wasShown.current = shown
    if (!frozen) heldFor.current = variant
  })
  useEffect(() => {
    if (!shown || current) return
    let stopped = false
    afterPaint(() => {
      if (!stopped) setCurrent(true)
    })
    return () => {
      stopped = true
    }
  }, [shown, current])
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
  // once hidden, its blocks stop skipping their items only while offscreen,
  // and their marks come off in the commit that shows it
  useLayoutEffect(
    () => (mode === 'hidden' && box.current ? settleHiddenBlocks(box.current) : undefined),
    [mode],
  )
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
            {/* the one element Activity hides, and so the one shown again;
               a Suspense inside keeps its own hidden content hidden */}
            <div data-kept-content className="contents">
              <Frozen frozen={frozen}>{children}</Frozen>
            </div>
          </Activity>
        </TeardownContext.Provider>
      </HiddenViewContext.Provider>
    </div>
  )
}

/** Takes back the inline `display: none` Activity gave the content
    wrapper at the top of `container`. */
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
  variant,
  className,
  children,
}: {
  id: string | null
  view: string
  shown: boolean
  variant?: string
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
        variant={variant}
        leaving={!current}
        onGone={() => gone(slot.n)}
        className={className}
      >
        {current ? children : null}
      </KeptView>
    )
  })
}
