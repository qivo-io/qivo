/* One optimistic layer per store write (store/planner.ts send).

   The rows the store shows are always rebuilt the same way: the server's
   last snapshot delivery, the watched comment thread, the task rows the
   open views' answers bring (store/viewRows.ts) and the task window's own
   answer of the watched task (store/planner.ts paintedAnswer), then every
   live layer's paint in order. A layer lives from the moment its write is sent
   until the server refuses it, or until a delivery is known to hold the
   accepted write. A refusal removes only that write's own layer, so no other
   change leaves the screen with it. This module only keeps the layers; the
   store decides when they paint, drop and repaint. */

/** A change to the row cache that runs again on every repaint, over the
    server's rows and the layers before it. Every paint keeps these rules:

    1. Look rows up by id on every run. Never keep a row object from send
       time, because each repaint builds new ones.
    2. Capture at send everything it reads from view models, the clock,
       keyToUuid, the week grid or the identity, and copy objects the caller
       owns.
    3. Write absolute values. Never toggle and never add one; a counter
       takes Math.max.
    4. Insert only when the id or natural key is absent. A create skips
       entirely, its dependent rows included, when the server's row is
       already there.
    5. Skip when a row it changes is gone.
    6. Where the server applies a rule when it commits, apply the same rule
       to the rows the paint runs on.
    7. No emit, toast, write, watchComments or clock read. Forgetting a
       minted file URL is allowed, since that is only a cache.
    8. Running it over rows that already hold its write changes nothing but
       server stamps. */
export type Paint = () => void

/** What one write shows. `workspace` paints the snapshot's rows; `thread`
    paints the comment thread of task `task`, and runs only while that task's
    thread is watched; `view` paints the task rows the open views' answers
    bring (store/viewRows.ts), every copy of a task it changes, and a
    create's puts its new task into the Board's and the Roadmap's rows
    (store/viewRows.ts insert, rule 4); `detail`
    paints the task window's own answer of task `task` (convex/taskWindow.ts
    task), and runs only while that task is watched and its answer held;
    `milestones` paints the milestones the store's milestone reads hold
    (store/milestoneRows.ts), every copy of a milestone it changes, and
    once the server accepted it only the copies of the reads that have not
    delivered it (store/planner.ts milestoneNeeds). A write on a task the
    workspace does not hold paints `view`, `detail` and `workspace`, whose
    paint skips until the workspace holds the task, so the write shows
    from whichever source the screen takes the task from. A milestone
    write paints `milestones` alone, as the workspace holds no milestone. */
export type View = {
  workspace?: Paint
  thread?: { task: string; paint: Paint }
  view?: Paint
  detail?: { task: string; paint: Paint }
  milestones?: Paint
}

/** Which rows a paint changes. */
export type Part = 'workspace' | 'thread' | 'view' | 'detail' | 'milestones'

/** The values on screen for the fields one write changes, before its paint:
    the row's table and id, and each field's value. The store sends them as
    the write's `expected` (store/planner.ts expectedOf), so the server can
    refuse an edit over a field someone else changed meanwhile
    (convex/model/expected.ts). */
export type Over = {
  table: string
  id: string
  fields: Record<string, unknown>
  /** for a task's parent pair, whether the row on screen had a parent the
      person cannot see, when that row is not the workspace's, such as the
      task window's own answer (store/planner.ts expectedOf) */
  hiddenParent?: boolean
}

/** One write's optimistic change. `open` collects paints before it is sent
    (a Roadmap batch) or covers several writes (an umbrella), `pending` waits
    for the server's answer, and `saved` is accepted but not yet known to be
    held by a delivery. `seen` holds the delivery counters when it was sent,
    the views' among them (deliveries of the reads that bring view rows),
    the task window's (deliveries of the watched task's own answer) and the
    milestone reads' (deliveries of their answers).
    `seenFrom` names, for each field of `over`, the newest open or pending
    layer that painted it when this one was made, so a refusal of that
    earlier write explains this one's (store/planner.ts). */
export type Layer = {
  readonly id: number
  readonly name: string
  readonly over?: Over
  readonly seenFrom?: ReadonlyMap<string, number>
  state: 'open' | 'pending' | 'saved'
  seen: { snapshot: number; thread: number; view: number; detail: number; milestones: number }
  view: View
}

/** Whether `view` paints anything. */
export const paints = (view: View) =>
  !!(view.workspace || view.thread || view.view || view.detail || view.milestones)

/** Creates an empty registry. */
export function createLayers() {
  let nextId = 0
  // open and pending layers in creation order, saved ones in acceptance order
  let live: Layer[] = []
  let saved: Layer[] = []

  const remove = (layer: Layer) => {
    live = live.filter((l) => l !== layer)
    saved = saved.filter((l) => l !== layer)
  }

  return {
    /** Starts a layer that is not sent yet: an umbrella, or a batch that
        collects paints before its one write. */
    open(name: string, view: View, over?: Over): Layer {
      const seenFrom = new Map<string, number>()
      // the live list is in creation order, so the last match is the newest
      for (const l of over ? live : [])
        if (over && l.over?.table === over.table && l.over.id === over.id)
          for (const field of Object.keys(over.fields))
            if (field in l.over.fields) seenFrom.set(field, l.id)
      const layer: Layer = {
        id: ++nextId,
        name,
        ...(over ? { over } : {}),
        ...(seenFrom.size ? { seenFrom } : {}),
        state: 'open',
        seen: { snapshot: 0, thread: 0, view: 0, detail: 0, milestones: 0 },
        view,
      }
      live.push(layer)
      return layer
    },
    /** Marks `layer` sent, with the delivery counters at that moment. */
    send(layer: Layer, seen: Layer['seen']) {
      layer.state = 'pending'
      layer.seen = { ...seen }
    },
    /** Keeps an accepted or ended layer as saved with `view`, the parts no
        delivery holds yet, or removes it when `view` paints nothing. */
    save(layer: Layer, view: View) {
      remove(layer)
      if (!paints(view)) return
      layer.view = view
      layer.state = 'saved'
      saved.push(layer)
    },
    /** Removes `layer`, refused or ended. */
    remove,
    /** Drops the saved `part` of each saved layer `held` says a live
        delivery holds. Answers whether it dropped any. */
    dropSavedIf(part: Part, held: (layer: Layer) => boolean): boolean {
      let dropped = false
      // remove() replaces `saved`, so this walks the list as it was
      for (const layer of saved) {
        if (!layer.view[part] || !held(layer)) continue
        layer.view = { ...layer.view, [part]: undefined }
        dropped = true
        if (!paints(layer.view)) remove(layer)
      }
      return dropped
    },
    /** Whether `layer` is still in the registry. */
    has: (layer: Layer) => live.includes(layer) || saved.includes(layer),
    /** Drops the saved `part` of every saved layer, once a live delivery
        holds them: every part for the workspace, the views and the
        milestone reads, and for the thread and the task window's answer
        only the parts of task `task`, or of every task but `task` with
        `except`. Answers whether it dropped any. */
    dropSaved(part: Part, task?: string, except = false): boolean {
      let dropped = false
      // remove() replaces `saved`, so this walks the list as it was
      for (const layer of saved) {
        if (part === 'workspace' || part === 'view' || part === 'milestones') {
          if (!layer.view[part]) continue
          layer.view = { ...layer.view, [part]: undefined }
        } else {
          const own = layer.view[part]
          if (!own || (task !== undefined && (own.task === task) === except)) continue
          layer.view = { ...layer.view, [part]: undefined }
        }
        dropped = true
        if (!paints(layer.view)) remove(layer)
      }
      return dropped
    },
    /** Saved layers in acceptance order, then open and pending ones in
        creation order: the order a repaint applies them in. */
    ordered: (): readonly Layer[] => [...saved, ...live],
    /** Whether an open or pending layer paints `part`, or anything. */
    paintedPending: (part?: Part) => live.some((l) => (part ? !!l.view[part] : paints(l.view))),
    /** Whether a write was sent and has not answered, painted or not. */
    waiting: () => live.some((l) => l.state === 'pending'),
    /** Empties the registry. */
    clear() {
      live = []
      saved = []
    },
  }
}

export type Layers = ReturnType<typeof createLayers>
