/* The blocks of a list that mounts in slices (components/DeferredList.tsx)
   skip their items while offscreen (`content-visibility: auto`), and the
   browser checks each such block, on every frame that lays anything out,
   for whether it came into view: in a hidden kept view (KeptView.tsx) too,
   where none can. So a hidden view's blocks skip their items for good
   (`data-kept-hidden`, DeferredList.css), which ends those checks. The
   view's container skips its contents once hidden, and the browser then
   keeps the styles inside as they were until a script reads one: in idle
   time after the view hid, this marks each block and reads its style, a
   few at a time. A mark on the block itself, not a rule on the hidden
   view, keeps a view that hides or shows from making the browser search
   all of its elements for blocks. */

import { type IdleDeadline, whenIdle } from './idle'

type Options = {
  /** runs `step` once the page is idle, with the time left; answers a
      function that cancels it */
  idle?: (step: (deadline: IdleDeadline) => void) => () => void
}

/** The idle time a step leaves for the browser's own work. */
const SPARE_MS = 2
const MARK = 'data-kept-hidden'

/** Marks the blocks in the hidden view `container` in idle time, so they
    stop skipping only while offscreen. Answers a function that stops and
    takes every mark off again, for the view to show. */
export function settleHiddenBlocks(container: Element, { idle = whenIdle }: Options = {}) {
  // live, so a step walks on from where the last one left off
  const blocks = container.getElementsByClassName('deferred-block')
  const marked: Element[] = []
  let next = 0
  let last: Element | undefined
  let cancel = () => {}
  const step = (deadline: IdleDeadline) => {
    // a block that went or came before `next`, as a leaving view drops its
    // blocks in slices, moved the rest: walk again, past the marked ones
    if (next > 0 && blocks[next - 1] !== last) next = 0
    while (next < blocks.length && deadline.timeRemaining() > SPARE_MS) {
      const block = blocks[next++]
      last = block
      if (block.hasAttribute(MARK)) continue
      block.setAttribute(MARK, '')
      marked.push(block)
      void getComputedStyle(block).contentVisibility
    }
    cancel = next < blocks.length ? idle(step) : () => {}
  }
  cancel = idle(step)
  return () => {
    cancel()
    for (const block of marked) block.removeAttribute(MARK)
  }
}
