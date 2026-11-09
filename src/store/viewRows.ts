/* The task rows the open views' answers bring (store/planner.ts view
   reads: the Board's tasks.board answer, P.watchBoard, each batch of the
   Overview's two lists, P.watchOverview, and Team sync's teamSync.agenda
   answer, P.watchSync), and the view models shaped from them.

   - A view's read is its row source: the whole answer of one live query,
     which names each task with its row and a group with its facts
     (convex/lib/viewReads.ts ViewRow), one slot per read. The Overview's
     lists are a source that brings rows in batches, each batch a slot of
     its own (take), and nothing that reads the models changed for it.
   - Each view keeps its own rows, by uuid, as its last answer brought them
     (the anchor), and the store paints every live layer's `view` part over
     copies of them on each repaint (store/layers.ts), as it paints the
     workspace's rows. A paint changes every copy of a task, in every view.
   - A view whose read stopped keeps its rows, as a kept page hidden behind
     another view, but they never stand in for a live view's: the live
     views' copies come first wherever one copy of a task is read (peek,
     byHandle, views), and each live answer brings a stopped view's copies
     of its tasks up to date (take), so the two never disagree and the
     live view's deliveries decide whether a write is held
     (store/planner.ts viewPartHeld).
   - The rows never enter the workspace's rows, which hold no task. Every
     task a view shows is a model shaped here from its answer's row.
   - The person's own new task goes into the rows of the views whose join
     shows the person's own changed tasks, the Board's and the Roadmap's
     (insert), from what its create sends, until the create answers, or
     until a read that is behind a reconnect delivers again
     (store/planner.ts newTaskViewPaint, slotsBehind). An insert is the one
     paint that adds a row no answer brought. Its number is the create's
     preview, moved past a number another task took in a view's answer
     meanwhile (store/planner.ts renumberPending), so no two models share a
     handle.
   - A model keeps its object while its row, its own and its parent's
     handles, its delay and the week grid hold the same data, so an answer
     that arrives again renders no card again (views/kanbanCards.tsx
     BoardCard), as store/workspaceBase.ts keeps a row's object.
   - A model is a task view model (shapeIssue) without the text and relation
     rows the answer does not send: no description, labels, links, files or
     follow, and only the subtasks the answer names. A group's Done and
     partial span come from its facts (factsOf), which P.isDone and the
     delay rules read before they walk subtasks.

   What the Board holds, all of it (store/boardHolds.test.ts pins it):
   - One answer per slot (views/board/useBoardView.ts BOARD_SLOTS), of at
     most BOARD.ceiling cards and BOARD.context groups and shown parents
     together (convex/lib/board.ts), 1,000 and 2,000. A variant that mounts
     releases the other's slot, so the desktop Board and the phone's list
     never hold rows at once.
   - While typing only narrows the text filter, the answer it narrows,
     until the answer for the new text arrives (P.watchBoard `narrows`);
     any other change of the arguments drops it at once.
   - The slots of the kept pages (lib/keptPages.ts), each page's own, at
     most the six main pages of one scope, which a new scope ends.
   - The owner-load cache's answers (store/ownerLoadCache.ts) for the
     owners the cards need, released with the view that registered them.
     Each open task is at most one span of one owner, so an organization's
     spans are at most its open tasks plus the paused lists, whatever the
     number of owners. An owner past OWNER_LOADS.open open rows answers
     unavailable, and a call stops at OWNER_LOADS.spans spans
     (convex/lib/ownerLoads.ts, convex/planning.ts ownerLoads).
   The workspace holds no task. No cap applies here at run time: these
   holders are bounded by the server's ceilings and the views' lifetimes,
   and the total is measured at the design size, not limited. */

import { reviewerOwns, taskOwnerId } from '../../convex/lib/review'
import { ISSUE_PREFIX } from '../../convex/lib/taskRefs'
import type { ViewRow } from '../../convex/lib/viewReads'
import type { Row } from './rows'
import { type IssueVM, shapeIssue } from './viewModels'

/** A view whose rows the store holds, such as the desktop Board. */
export type ViewSlot = string

/** What a model shaped from a row knows that the view model cannot carry:
    a group's Done and whether its span is partial, from the answer's group
    facts, or a task's own status and no span. */
export type ViewFacts = { done: boolean; partial: boolean }

/** What shaping needs from the store: the handle a task opens by
    (P.handleNow), which a change of the home organization moves, a
    signature of anything else a model shows that the row does not hold,
    such as its delay, and the week grid its week indexes are on
    (P.gridEpoch). A change of any of them renews the model. */
export type ViewShapeCtx = {
  handleNow: (uuid: string, orgId: string, num: number) => string
  extra?: (uuid: string) => string
  grid?: number
  /** Whether task `uuid`'s model names its handle over another model of
      the same handle, as the person's own new task on its way does, whose
      preview number another task can hold until the store moves it
      (store/planner.ts renumberPending). A card opened or dropped by that
      handle then acts on the person's own task, never on someone else's. */
  wins?: (uuid: string) => boolean
}

type Shaped = {
  row: ViewRow
  handle: string
  parent: string | null
  kids: string
  extra: string
  grid: number | undefined
  it: IssueVM
}

/* A week index of an ISO week date, or null. Weeks are what IssueVM's
   start and end hold. */
const weekOf = (iso: string | undefined, toWeek: (iso: string) => number) =>
  iso === undefined ? null : toWeek(iso)

/** Creates an empty registry. `toWeek` turns an ISO date into a week index
    (lib/dates.ts isoToWeek), passed in so the module holds no grid. `live`
    says whether a view's read is subscribed; the store's repaint follows
    its changes, as each repaint ranks the views (beginPaint). */
export function createViewRows(
  toWeek: (iso: string) => number,
  live: (slot: ViewSlot) => boolean = () => true,
) {
  // each view's last answer, by uuid, frozen in tests (the anchor)
  const anchors = new Map<ViewSlot, ReadonlyMap<string, ViewRow>>()
  // the rows on screen: each view's anchor with the layers painted over
  let painted = new Map<ViewSlot, Map<string, ViewRow>>()
  // the copies the paints made since the last reshape, so a repaint copies
  // a row once; a model shaped from a copy holds it, so a later paint, such
  // as the next write's at its send, copies the row again (reshape)
  let copies = new Set<ViewRow>()
  // the models of the views' tasks, by view and uuid
  const shaped = new Map<ViewSlot, Map<string, Shaped>>()
  const facts = new WeakMap<IssueVM, ViewFacts>()
  let byHandle = new Map<string, IssueVM>()
  // whether a release took models away since the last reshape
  let released = false

  /** The row of `uuid` a view shows, in the first view that holds it, a
      live one before a stopped one. */
  const peek = (uuid: string): ViewRow | undefined => {
    for (const rows of painted.values()) {
      const row = rows.get(uuid)
      if (row) return row
    }
    return undefined
  }

  /** The model of `row` in `rows`, the view's rows by uuid, with
      `children`, the rows naming it as parent, reusing `was` while its data
      holds. */
  function shape(
    row: ViewRow,
    rows: ReadonlyMap<string, ViewRow>,
    kidRows: readonly ViewRow[],
    ctx: ViewShapeCtx,
    was: Shaped | undefined,
  ): Shaped {
    const parentRow = row.parent_id ? rows.get(row.parent_id) : undefined
    const parent = parentRow ? ctx.handleNow(parentRow.id, parentRow.org_id, parentRow.num) : null
    // the subtasks this answer names; a group's others are filtered out or
    // hidden, and its facts say what they add up to
    const children = kidRows.map((kid) => ctx.handleNow(kid.id, kid.org_id, kid.num))
    const kids = children.join()
    const extra = ctx.extra?.(row.id) ?? ''
    const handle = ctx.handleNow(row.id, row.org_id, row.num)
    if (
      was &&
      was.handle === handle &&
      was.parent === parent &&
      was.kids === kids &&
      was.extra === extra &&
      was.grid === ctx.grid &&
      (was.row === row || JSON.stringify(was.row) === JSON.stringify(row))
    )
      return was.row === row ? was : { ...was, row }
    const handles = new Map([[row.id, handle]])
    if (parentRow && parent) handles.set(parentRow.id, parent)
    const only = <T>(value: T) => ({ get: (id: string) => (id === row.id ? value : undefined) })
    // the answer sends no text; the model shows none rather than a stale one
    const task: Row<'issues'> = { ...row, description: '' }
    const it = shapeIssue(task, {
      uuidToKey: handles,
      uuidToDisplayKey: only(`${ISSUE_PREFIX}-${row.num}`),
      hiddenSubtaskParents: { has: (id) => id === row.id && row.has_hidden_subtasks },
      hiddenParentTasks: { has: (id) => id === row.id && row.has_hidden_parent },
      linkViews: only([]),
      childKeys: only(children),
      labelsByIssue: only([]),
      attByIssue: only([]),
      attachmentCounts: only(0),
      subscribedIssues: { has: () => false },
    })
    // a group the answer names without its subtasks is still a group
    if (row.has_subtasks && !it.isGroup) {
      it.isGroup = true
      it.owner = taskOwnerId(row, true)
      it.ownerField = reviewerOwns(row, true) ? 'reviewer' : 'assignee'
    }
    if (row.has_subtasks) {
      // a group's dates are its calculated span, never its stored dates
      it.start = weekOf(row.span?.start_week, toWeek)
      it.end = weekOf(row.span?.end_week, toWeek)
    }
    facts.set(it, {
      done: row.has_subtasks ? !!row.group_done : row.status === 'done',
      partial: row.has_subtasks ? !!row.span?.partial : false,
    })
    return { row, handle, parent, kids, extra, grid: ctx.grid, it }
  }

  return {
    /** Takes view `slot`'s answer rows, `rows` (each task once), as its new
        anchor, and as the anchor of every stopped view's copy of one of
        these tasks. The caller repaints. */
    take(slot: ViewSlot, rows: readonly ViewRow[]) {
      const next = new Map(rows.map((row) => [row.id, row]))
      anchors.set(slot, next)
      for (const [other, held] of anchors) {
        if (other === slot || live(other)) continue
        let copy: Map<string, ViewRow> | null = null
        for (const uuid of (held.size < next.size ? held : next).keys()) {
          const row = next.get(uuid)
          if (!row || !held.has(uuid) || held.get(uuid) === row) continue
          copy ??= new Map(held)
          copy.set(uuid, row)
        }
        if (copy) anchors.set(other, copy)
      }
    },
    /** Forgets view `slot`'s rows and models. The caller repaints, and
        the next reshape answers that the models changed. */
    release(slot: ViewSlot) {
      anchors.delete(slot)
      painted.delete(slot)
      if (shaped.get(slot)?.size) released = true
      shaped.delete(slot)
    },
    /** Whether view `slot` holds rows. */
    holds: (slot: ViewSlot) => anchors.has(slot),
    /** Whether any view holds rows. */
    any: () => anchors.size > 0,
    /** Whether more than one view holds rows. */
    shared: () => anchors.size > 1,
    /** Whether a live view holds task `uuid`, or a view `which` names
        when given. */
    liveHolds(uuid: string, which: (slot: ViewSlot) => boolean = live): boolean {
      for (const [slot, rows] of anchors) if (which(slot) && rows.has(uuid)) return true
      return false
    },
    /** Starts a repaint: every view's rows as its anchor holds them, the
        live views first. */
    beginPaint() {
      const ranked = [...anchors].sort(([a], [b]) => Number(live(b)) - Number(live(a)))
      painted = new Map(ranked.map(([slot, rows]) => [slot, new Map(rows)]))
      copies = new Set()
    },
    /** The copies of task `uuid` a paint may change, one in each view that
        holds it, made the first time a paint asks in this repaint. Empty
        when no view holds the task, so the paint skips (store/layers.ts
        rule 5). */
    edit(uuid: string): ViewRow[] {
      const out: ViewRow[] = []
      for (const rows of painted.values()) {
        const row = rows.get(uuid)
        if (!row) continue
        if (copies.has(row)) {
          out.push(row)
          continue
        }
        const copy: ViewRow = structuredClone(row)
        copies.add(copy)
        rows.set(uuid, copy)
        out.push(copy)
      }
      return out
    },
    /** Puts a copy of `row` into view `slot`'s rows on screen, where that
        view holds rows and none of task `row.id` (store/layers.ts rule 4),
        so the person's new task shows there, and answers the copy, which a
        later paint of the same repaint changes (edit). Answers null where
        it put nothing. */
    insert(slot: ViewSlot, row: ViewRow): ViewRow | null {
      const rows = painted.get(slot)
      if (!rows || rows.has(row.id)) return null
      const copy: ViewRow = structuredClone(row)
      copies.add(copy)
      rows.set(row.id, copy)
      return copy
    },
    /** The copy of task `uuid` in view `slot` a paint may change, as edit
        makes it, or undefined where that view holds no row of it. */
    editIn(slot: ViewSlot, uuid: string): ViewRow | undefined {
      const rows = painted.get(slot)
      const row = rows?.get(uuid)
      if (!rows || !row) return undefined
      if (copies.has(row)) return row
      const copy: ViewRow = structuredClone(row)
      copies.add(copy)
      rows.set(uuid, copy)
      return copy
    },
    /** The tasks of organization `org` that the views' last answers
        brought, by number, each with its uuid. */
    numbered(org: string): Map<number, string> {
      const out = new Map<number, string>()
      for (const rows of anchors.values())
        for (const row of rows.values()) if (row.org_id === org) out.set(row.num, row.id)
      return out
    },
    /** The number the views' last answers give task `uuid`, the server's,
        or undefined where none brought it. */
    numberOf(uuid: string): number | undefined {
      for (const rows of anchors.values()) {
        const row = rows.get(uuid)
        if (row) return row.num
      }
      return undefined
    },
    /** Whether view `slot`'s last answer brought task `uuid`, so its row
        there is no insert. */
    answered: (slot: ViewSlot, uuid: string): boolean => !!anchors.get(slot)?.has(uuid),
    /** The row of task `uuid` as a view shows it, or undefined. */
    peek,
    /** View `slot`'s rows on screen, by uuid, or null when it holds none. */
    rowsOf: (slot: ViewSlot): ReadonlyMap<string, ViewRow> | null => painted.get(slot) ?? null,
    /** How many rows each slot's answer holds, by slot, for tests and the
        report (the Board's holders, above). */
    held: (): Map<ViewSlot, number> =>
      new Map([...anchors].map(([slot, rows]) => [slot, rows.size])),
    /** The tasks whose rows on screen differ from their anchor, the ones a
        live layer changed (P.ownPaintedTasks). */
    paintedTasks(): Set<string> {
      const out = new Set<string>()
      for (const [slot, rows] of painted) {
        const anchor = anchors.get(slot)
        for (const [uuid, row] of rows)
          if (
            anchor?.get(uuid) !== row &&
            JSON.stringify(anchor?.get(uuid)) !== JSON.stringify(row)
          )
            out.add(uuid)
      }
      return out
    },
    /** Shapes the models of every task the views hold, reusing each object
        while its data holds. Answers whether any model changed. */
    reshape(ctx: ViewShapeCtx): boolean {
      let changed = released
      released = false
      const handles = new Map<string, IssueVM>()
      for (const [slot, rows] of painted) {
        const before = shaped.get(slot) ?? new Map<string, Shaped>()
        const after = new Map<string, Shaped>()
        // each row's subtasks among the view's rows, in the answer's order
        const kidsOf = new Map<string, ViewRow[]>()
        for (const row of rows.values()) {
          if (!row.parent_id) continue
          const list = kidsOf.get(row.parent_id)
          if (list) list.push(row)
          else kidsOf.set(row.parent_id, [row])
        }
        for (const [uuid, row] of rows) {
          const was = before.get(uuid)
          const now = shape(row, rows, kidsOf.get(uuid) ?? [], ctx, was)
          if (now.it !== was?.it) changed = true
          after.set(uuid, now)
          const named = handles.get(now.it.id)
          if (!named || (ctx.wins?.(uuid) && !ctx.wins(named.uuid))) handles.set(now.it.id, now.it)
        }
        if (after.size !== before.size) changed = true
        shaped.set(slot, after)
      }
      for (const [slot, models] of shaped)
        if (!painted.has(slot)) {
          if (models.size > 0) changed = true
          shaped.delete(slot)
        }
      byHandle = handles
      // the models hold these rows now: a paint that changed one in place
      // would leave its model as it was, so the next paint copies afresh
      copies = new Set()
      return changed
    },
    /** The model of task `uuid` in view `slot`. */
    model: (slot: ViewSlot, uuid: string): IssueVM | undefined => shaped.get(slot)?.get(uuid)?.it,
    /** The model a handle names, in any view, a live one first, and the
        person's new task on its way first where two share it
        (ViewShapeCtx wins). */
    byHandle: (handle: string): IssueVM | undefined => byHandle.get(handle),
    /** Every model the views hold, by handle. */
    handles: (): ReadonlyMap<string, IssueVM> => byHandle,
    /** A model's group facts, or undefined for a model no view shaped. */
    factsOf: (it: IssueVM): ViewFacts | undefined => facts.get(it),
    /** Every view's rows on screen, by view, for the store's strict layer
        check. */
    views: (): ReadonlyMap<ViewSlot, ReadonlyMap<string, ViewRow>> => painted,
    /** What a strict check repaints from: the rows on screen, to put back. */
    save: () => ({ painted, copies }),
    restore(saved: { painted: Map<ViewSlot, Map<string, ViewRow>>; copies: Set<ViewRow> }) {
      painted = saved.painted
      copies = saved.copies
    },
    /** Forgets everything (a disposed demo). */
    clear() {
      anchors.clear()
      painted = new Map()
      copies = new Set()
      shaped.clear()
      byHandle = new Map()
      released = false
    },
  }
}

export type ViewRows = ReturnType<typeof createViewRows>
