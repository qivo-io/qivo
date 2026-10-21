import {
  type FocusEvent,
  memo,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { lastInputWasPointer } from '@/lib/focusVisibility'
import type { MountScheduler } from '@/lib/mountScheduler'
import { useLatest } from '@/lib/useLatest'
import { Button } from './ui/button'
import './DeferredList.css'

/* The most items a slice adds to one block before it opens the next. A
   slice renders only the block that grows, so its cost does not grow with
   the items already mounted. */
const BLOCK_SIZE = 256
/* The most items a render mounts at once when items arrive above the
   mounted boundary, as when a filter is cleared. */
const MOST_AT_ONCE = 64

type Props<T extends object> = {
  /** the list's id with its scheduler */
  id: string
  items: readonly T[]
  keyOf: (item: T) => string
  render: (item: T) => ReactNode
  /** an item's height in pixels before it renders */
  estimate: (item: T) => number
  /** the gap between items in pixels */
  gap: number
  /** the items to mount in the first render; all of them when it covers them */
  initial: number
  scheduler: MountScheduler
  /** the waiting space's accessible name for `pending` items */
  label: (pending: number) => string
  /** puts the waiting space in a list item, for a list with role="list" */
  listRole?: boolean
}

type Block<T> = { id: number; items: T[]; start: number }

/** How a block of a list that mounts in slices is drawn: its items'
    estimated height with their gaps, and whether it still grows. */
type BlockBox = { height: number; gap: number; open: boolean }

/* A list that mounts in slices wraps each block in a box the browser skips
   while it is offscreen (DeferredList.css), sized by its items' estimates
   until it renders. One box per block keeps that skipping cheap: the
   browser checks each such box on every frame, so a box per item would
   cost a check per item. A block that still grows takes its estimate as
   it is; a closed one keeps the size it last rendered at. A list its first
   screen covers draws no boxes, the DOM of a plain list. */
function BlockView<T>({
  items,
  render,
  box,
}: {
  items: readonly T[]
  render: (item: T) => ReactNode
  box: BlockBox | null
}) {
  const nodes = items.map((item) => render(item))
  if (!box) return <>{nodes}</>
  return (
    <div
      data-deferred-block
      role="none"
      className="deferred-block"
      style={{
        gap: box.gap,
        containIntrinsicBlockSize: box.open ? `${box.height}px` : `auto ${box.height}px`,
      }}
    >
      {nodes}
    </div>
  )
}

/* A block renders again when the list's render, its box or one of its
   items is new. */
const Block = memo(
  BlockView,
  (before, after) =>
    before.render === after.render &&
    before.box?.height === after.box?.height &&
    before.box?.open === after.box?.open &&
    before.items.length === after.items.length &&
    before.items.every((item, i) => item === after.items[i]),
) as typeof BlockView

/** A list that mounts its first `initial` items at once and the rest in
    the scheduler's slices, with a shaded space of their estimated height
    in their place. A mounted item stays mounted: an insert above the
    mounted boundary keeps the boundary item, and a list that shrinks below
    what it had mounted mounts again in slices when it grows. Focus that
    reaches the waiting space mounts the list and moves on, in the Tab
    direction, to the first or last control of the items that came in. With
    `initial` covering every item it renders them all and no space, the same
    DOM as a plain list. */
export function DeferredList<T extends object>({
  id,
  items,
  keyOf,
  render,
  estimate,
  gap,
  initial,
  scheduler,
  label,
  listRole = false,
}: Props<T>) {
  // the mounted count and the last mounted item's key, changed only by grow
  const [state, setState] = useState<{ count: number; frontier: string | null }>(() => ({
    count: Math.min(initial, items.length),
    frontier: null,
  }))
  const mountedOf = (current: typeof state, list: readonly T[]) => {
    const at =
      current.frontier === null ? -1 : list.findIndex((it) => keyOf(it) === current.frontier)
    const mounted = Math.min(
      list.length,
      at >= 0 ? at + 1 : current.count,
      current.count + MOST_AT_ONCE,
    )
    return Math.max(mounted, Math.min(initial, list.length))
  }
  // Fewer items than were mounted: count only those, so a list that grows
  // back mounts its first screen at once and the rest in slices.
  if (items.length < state.count) {
    setState({
      count: items.length,
      frontier: items.length ? keyOf(items[items.length - 1]) : null,
    })
  }
  const mounted = mountedOf(state, items)
  const pending = items.length - mounted

  const latest = useRef(items)
  const waiting = useRef(pending)
  const grow = useLatest((n: number) =>
    setState((current) => {
      const list = latest.current
      const count = Math.min(list.length, mountedOf(current, list) + n)
      return { count, frontier: count ? keyOf(list[count - 1]) : null }
    }),
  )
  const mountThrough = useLatest((key: string) =>
    setState((current) => {
      const at = latest.current.findIndex((it) => keyOf(it) === key)
      return at < mountedOf(current, latest.current) ? current : { count: at + 1, frontier: key }
    }),
  )
  const spacer = useRef<HTMLButtonElement>(null)
  useLayoutEffect(
    () =>
      scheduler.register({
        id,
        spacer: () => spacer.current,
        pending: () => waiting.current,
        grow,
        mountThrough,
      }),
    [scheduler, id, grow, mountThrough],
  )
  useLayoutEffect(() => {
    latest.current = items
    waiting.current = pending
    scheduler.changed()
  })

  /* Items keep the block that first held them, so an insert or a delete
     moves no item to another block, and only an item reordered across a
     block boundary remounts. Block ids rise down the list. */
  /* Each item's element, made once per item object and render, so the
     block a slice grows hands its other items back unchanged and React
     skips them without rendering or comparing them again. */
  const made = useRef<{
    render: typeof render
    nodes: WeakMap<T, ReactNode>
    node: (item: T) => ReactNode
  } | null>(null)
  if (made.current?.render !== render) {
    const nodes = new WeakMap<T, ReactNode>()
    made.current = {
      render,
      nodes,
      node: (item) => {
        if (!nodes.has(item)) nodes.set(item, render(item))
        return nodes.get(item)
      },
    }
  }
  const node = made.current.node
  const owners = useRef(new Map<string, number>())
  const nextBlock = useRef(0)
  /* Blocks below this id hold the first screen. They are on screen, so the
     browser renders them whole; slices fill new blocks below them, which
     it skips while they are offscreen. */
  const sealedBelow = useRef<number | null>(null)
  const blocks: Block<T>[] = []
  const shown = items.slice(0, mounted)
  const capacity = initial >= items.length ? Number.POSITIVE_INFINITY : BLOCK_SIZE
  const assigned = new Map<string, number>()
  let current: Block<T> | null = null
  for (const [index, item] of shown.entries()) {
    const key = keyOf(item)
    let owner = owners.current.get(key)
    if (owner !== undefined && (!current || owner > current.id)) {
      current = { id: owner, items: [], start: index }
      blocks.push(current)
    } else if (!current) {
      // a new item above every owned one joins the first owned block
      const next = shown.slice(index + 1).find((it) => owners.current.has(keyOf(it)))
      current = {
        id: next ? (owners.current.get(keyOf(next)) ?? 0) : nextBlock.current++,
        items: [],
        start: index,
      }
      blocks.push(current)
    } else if (
      owner === undefined &&
      (current.items.length >= capacity || current.id < (sealedBelow.current ?? 0)) &&
      current.id === nextBlock.current - 1
    ) {
      // the last block is full or holds the first screen: open the next one
      current = { id: nextBlock.current++, items: [], start: index }
      blocks.push(current)
    }
    owner = current.id
    nextBlock.current = Math.max(nextBlock.current, owner + 1)
    assigned.set(key, owner)
    current.items.push(item)
  }
  owners.current = assigned
  if (sealedBelow.current === null && capacity !== Number.POSITIVE_INFINITY)
    sealedBelow.current = nextBlock.current

  // the waiting items' estimated heights, each with the gap before it
  const sums = useMemo(() => {
    const prefix = [0]
    for (const item of items) prefix.push(prefix[prefix.length - 1] + estimate(item) + gap)
    return prefix
  }, [items, estimate, gap])
  const height = pending > 0 ? sums[items.length] - sums[mounted] - gap : 0

  /** The items' elements in `parent`, inside their block boxes or not. */
  const itemElements = (parent: Element, holder: Element) =>
    [...parent.children].flatMap((child) =>
      child === holder
        ? []
        : child.hasAttribute('data-deferred-block')
          ? [...child.children]
          : [child],
    )
  const onFocus = (event: FocusEvent<HTMLButtonElement>) => {
    const holder = listRole ? event.currentTarget.parentElement : event.currentTarget
    const parent = holder?.parentElement
    if (!holder || !parent) return
    const before = itemElements(parent, holder).at(-1)
    const from = event.relatedTarget
    const fromAbove =
      from instanceof Node &&
      !!(from.compareDocumentPosition(holder) & Node.DOCUMENT_POSITION_FOLLOWING)
    scheduler.completeList(id)
    if (lastInputWasPointer()) return
    const after = itemElements(parent, holder)
    const item = fromAbove ? after[before ? after.indexOf(before) + 1 : 0] : after.at(-1)
    if (!(item instanceof HTMLElement)) return
    const controls = [item, ...item.querySelectorAll<HTMLElement>('[data-focus-key]')].filter(
      (element) => element.dataset.focusKey !== undefined,
    )
    controls[fromAbove ? 0 : controls.length - 1]?.focus()
  }
  const waitingSpace = pending > 0 && (
    <Button
      ref={spacer}
      type="button"
      variant="unstyled"
      noTooltip
      data-board-pending={pending}
      aria-label={label(pending)}
      // the waiting items' estimated height, so the list keeps its shape
      style={{ height }}
      className="board-pending"
      onFocus={onFocus}
      onPointerDown={() => scheduler.completeList(id)}
    />
  )
  return (
    <>
      {blocks.map((block, i) => (
        <Block
          key={block.id}
          items={block.items}
          render={node}
          box={
            capacity === Number.POSITIVE_INFINITY
              ? null
              : {
                  height: sums[block.start + block.items.length] - sums[block.start] - gap,
                  gap,
                  open: pending > 0 && i === blocks.length - 1,
                }
          }
        />
      ))}
      {waitingSpace && listRole ? (
        // biome-ignore lint/a11y/useSemanticElements: the list is a styled flex div that takes drops, not a <ul>
        <div role="listitem">{waitingSpace}</div>
      ) : (
        waitingSpace
      )}
    </>
  )
}
