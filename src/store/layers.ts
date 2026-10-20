/* One optimistic layer per store write (store/planner.ts send).

   The rows the store shows are always rebuilt the same way: the server's
   last snapshot delivery and the watched comment thread, then every live
   layer's paint in order. A layer lives from the moment its write is sent
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
    thread is watched. */
export type View = { workspace?: Paint; thread?: { task: string; paint: Paint } }

/** Which rows a paint changes. */
export type Part = 'workspace' | 'thread'

/** The values on screen for the fields one write changes, before its paint:
    the row's table and id, and each field's value. A field check reads them
    to tell the server what the person saw. */
export type Over = { table: string; id: string; fields: Record<string, unknown> }

/** One write's optimistic change. `open` collects paints before it is sent
    (a Roadmap batch) or covers several writes (an umbrella), `pending` waits
    for the server's answer, and `saved` is accepted but not yet known to be
    held by a delivery. `seen` holds the delivery counters when it was sent. */
export type Layer = {
  readonly id: number
  readonly name: string
  readonly over?: Over
  state: 'open' | 'pending' | 'saved'
  seen: { snapshot: number; thread: number }
  view: View
}

/** Whether `view` paints anything. */
export const paints = (view: View) => !!(view.workspace || view.thread)

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
      const layer: Layer = {
        id: ++nextId,
        name,
        ...(over ? { over } : {}),
        state: 'open',
        seen: { snapshot: 0, thread: 0 },
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
    /** Whether `layer` is still in the registry. */
    has: (layer: Layer) => live.includes(layer) || saved.includes(layer),
    /** Drops the saved `part` of every saved layer, once a live delivery
        holds them: every part for the workspace, and for the thread only the
        parts of task `task`, or of every task but `task` with `except`. */
    dropSaved(part: Part, task?: string, except = false) {
      // remove() replaces `saved`, so this walks the list as it was
      for (const layer of saved) {
        if (part === 'workspace') {
          if (!layer.view.workspace) continue
          layer.view = { ...layer.view, workspace: undefined }
        } else {
          const thread = layer.view.thread
          if (!thread || (task !== undefined && (thread.task === task) === except)) continue
          layer.view = { ...layer.view, thread: undefined }
        }
        if (!paints(layer.view)) remove(layer)
      }
    },
    /** Saved layers in acceptance order, then open and pending ones in
        creation order: the order a repaint applies them in. */
    ordered: (): readonly Layer[] => [...saved, ...live],
    /** Whether an open or pending layer paints `part`, or anything. */
    paintedPending: (part?: Part) => live.some((l) => (part ? !!l.view[part] : paints(l.view))),
    /** Empties the registry. */
    clear() {
      live = []
      saved = []
    },
  }
}

export type Layers = ReturnType<typeof createLayers>
