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
   the items already mounted. A block is also what the browser lays out
   when it comes into view (DeferredList.css), so a small one keeps that
   frame short. */
const BLOCK_SIZE = 64
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

/** Which items keep the block they had: the longest run, in list order, of
    owners that never decrease. Block ids rise down the list, so an item a
    reorder moved across blocks breaks that order and only it changes
    block; the items around it keep theirs. New items (no owner) keep none. */
function keptOwners(owners: (number | undefined)[]) {
  // patience sorting for the longest non-decreasing subsequence
  const tails: number[] = []
  const tailAt: number[] = []
  const before = Array.from({ length: owners.length }, () => -1)
  for (const [i, owner] of owners.entries()) {
    if (owner === undefined) continue
    let low = 0
    let high = tails.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (tails[mid] <= owner) low = mid + 1
      else high = mid
    }
    tails[low] = owner
    tailAt[low] = i
    before[i] = low > 0 ? tailAt[low - 1] : -1
  }
  const kept = Array.from({ length: owners.length }, () => false)
  for (let i = tails.length ? tailAt[tails.length - 1] : -1; i >= 0; i = before[i]) kept[i] = true
  return kept
}

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
    (before.items === after.items ||
      (before.items.length === after.items.length &&
        before.items.every((item, i) => item === after.items[i]))),
) as typeof BlockView

/** A list that mounts its first `initial` items at once and the rest in
    the scheduler's slices, with a shaded space of their estimated height
    in their place. A mounted item stays mounted while it is in the list,
    and a list that shrinks below what it had mounted mounts again in
    slices when it grows. Focus that
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
  /* What is mounted follows what the last render mounted: every item it
     mounted that is still in the list stays mounted, wherever a reorder,
     delete or insert moved it, with at most MOST_AT_ONCE new ones; a
     slice or a focus that needs an item asks for a longer prefix. A list
     that loses items mounts only what is left, so it grows back in
     slices. */
  const mountedKeys = useRef(new Set<string>())
  const lastMounted = useRef(0)
  /* The last render's list and blocks. While the list stays the same
     array, a render can only mount more of it: a slice. It then works on
     the items it adds alone, as work on every mounted item in each slice
     would grow with the list and leave the slices little time to mount. */
  const last = useRef<{ items: T[]; initial: number; mounted: number; blocks: Block<T>[] } | null>(
    null,
  )
  const grown =
    last.current?.items === items && last.current.initial === initial ? last.current : null
  // a length a slice or mountThrough asked for, 0 once rendered
  const [target, setTarget] = useState(0)
  const floor = Math.min(initial, items.length)
  const before = mountedKeys.current
  // the prefix that holds every item the last render mounted
  let stays = grown ? grown.mounted : 0
  if (!grown && before.size)
    for (let i = items.length - 1; i >= 0; i--)
      if (before.has(keyOf(items[i]))) {
        stays = i + 1
        break
      }
  const mounted = Math.min(
    items.length,
    Math.max(floor, Math.min(stays, before.size + MOST_AT_ONCE), target),
  )
  if (grown) for (let i = grown.mounted; i < mounted; i++) before.add(keyOf(items[i]))
  else mountedKeys.current = new Set(items.slice(0, mounted).map(keyOf))
  lastMounted.current = mounted
  if (target && mounted >= target) setTarget(0)
  const pending = items.length - mounted

  const latest = useRef(items)
  const waiting = useRef(pending)
  const grow = useLatest((n: number) =>
    setTarget((asked) => Math.max(asked, Math.min(latest.current.length, lastMounted.current + n))),
  )
  const mountThrough = useLatest((key: string) => {
    const at = latest.current.findIndex((it) => keyOf(it) === key)
    if (at >= lastMounted.current) setTarget((asked) => Math.max(asked, at + 1))
  })
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
  /* The plain blocks: those of a list that rendered whole the first time.
     A block is boxed or plain for good, as a box that came and went would
     remount every card in it. A plain block takes any number of items
     while the list renders whole; once it mounts in slices, new items go
     to new boxed blocks of BLOCK_SIZE, above the plain ones too. */
  const plainIds = useRef<ReadonlySet<number> | null>(null)
  const sliced = initial !== Number.POSITIVE_INFINITY
  const plain = (id: number) => plainIds.current?.has(id) ?? false
  const capacity = (id: number) =>
    plain(id) ? (sliced ? 0 : Number.POSITIVE_INFINITY) : BLOCK_SIZE
  /* A block between `low` and the kept block `high` (none: the end), or
     null when no id is left between them. Ids rise down the list. */
  const between = (low: number, high: number | undefined) => {
    if (high === undefined) return nextBlock.current++
    const id = (low + high) / 2
    return id > low && id < high ? id : null
  }
  /** Blocks for the mounted items `shown`, each kept in the block that
      held it where it can be. */
  const allocate = (shown: T[]) => {
    const blocks: Block<T>[] = []
    const assigned = new Map<string, number>()
    const known = shown.map((item) => owners.current.get(keyOf(item)))
    const kept = keptOwners(known)
    // how many kept items each block holds, and the first kept block after each item
    const keptSize = new Map<number, number>()
    const keptAfter: (number | undefined)[] = []
    for (let i = shown.length - 1, next: number | undefined; i >= 0; i--) {
      keptAfter[i] = next
      const owner = known[i]
      if (kept[i] && owner !== undefined) {
        next = owner
        keptSize.set(owner, (keptSize.get(owner) ?? 0) + 1)
      }
    }
    let current: Block<T> | null = null
    for (const [index, item] of shown.entries()) {
      const owner = kept[index] ? known[index] : undefined
      if (owner !== undefined && (!current || owner !== current.id)) {
        current = { id: owner, items: [], start: index }
        blocks.push(current)
      } else if (owner === undefined && !current) {
        // new or moved items above every kept one: the first kept block while
        // it has room, else a block of their own above it
        const next = keptAfter[index]
        // the items above the first kept one, which all come before it
        const run = known.findIndex((_, i) => kept[i])
        const id =
          next !== undefined && (keptSize.get(next) ?? 0) + run <= capacity(next)
            ? next
            : next === undefined
              ? nextBlock.current++
              : next - 1
        current = { id, items: [], start: index }
        blocks.push(current)
      } else if (
        owner === undefined &&
        current &&
        (current.items.length >= capacity(current.id) || current.id < (sealedBelow.current ?? 0))
      ) {
        // the block is full or holds the first screen: open the next one
        const id = between(current.id, keptAfter[index])
        if (id !== null) {
          current = { id, items: [], start: index }
          blocks.push(current)
        }
      }
      if (!current) continue
      nextBlock.current = Math.max(nextBlock.current, Math.floor(current.id) + 1)
      assigned.set(keyOf(item), current.id)
      current.items.push(item)
    }
    owners.current = assigned
    return blocks
  }
  /** The last render's blocks, with the items mounted since at their end. */
  const extend = (previous: Block<T>[], from: number) => {
    const blocks = [...previous]
    let current = blocks.at(-1)
    let fresh = false
    for (let index = from; index < mounted; index++) {
      if (
        !current ||
        current.items.length >= capacity(current.id) ||
        current.id < (sealedBelow.current ?? 0)
      ) {
        current = { id: nextBlock.current++, items: [], start: index }
        blocks.push(current)
        fresh = true
      } else if (!fresh) {
        // the growing block gets a new array, so the blocks before it keep theirs
        current = { ...current, items: [...current.items] }
        blocks[blocks.length - 1] = current
        fresh = true
      }
      owners.current.set(keyOf(items[index]), current.id)
      current.items.push(items[index])
    }
    return blocks
  }
  const blocks = grown ? extend(grown.blocks, grown.mounted) : allocate(items.slice(0, mounted))
  last.current = { items, initial, mounted, blocks }
  plainIds.current ??= new Set(sliced ? [] : blocks.map((block) => block.id))
  if (sealedBelow.current === null && sliced) sealedBelow.current = nextBlock.current

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
    // the item's tab stops, as Tab itself would reach them
    const controls = [item, ...item.querySelectorAll<HTMLElement>('[data-focus-key]')].filter(
      (element) => element.dataset.focusKey !== undefined && element.tabIndex >= 0,
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
            plain(block.id)
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
