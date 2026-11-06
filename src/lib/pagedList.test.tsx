// @vitest-environment jsdom
import { anyApi } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../../convex/lib/limits'
import type { LiveTransition } from './liveQueries'
import type { BatchAt, BatchSource, ListBatch, PagedList, PagedPages } from './pagedList'

/* The shared paged list (lib/pagedList.ts) over a transport double and a
   small name-ordered server: the `once` source's reads on demand, and the
   `live` source's batches, kept live with ends pinned on Load more, split
   when a pinned batch stops short, holding one moment's answers, stopped
   while the tab is hidden and on leaving, and started again for a refused
   position. The page mode (usePagedPages) shows one live page that Next
   and Previous replace, and useMoreOnScroll loads more as a marker comes
   into view. The helpers useSettledSearch, listEnd and pageEnd have cases
   of their own. */

type Row = { id: string; name: string }
type Args = { list?: string; after?: string; through?: string }

/* The server holds labels by id, in name order then id, read a batch at a time
   as convex/model/labels.ts labelBatch reads them. A cursor is the
   position's text, so equal positions give equal cursors. */
const server = vi.hoisted(() => ({
  labels: new Map<string, string>(),
  batch: 25,
  /** a batch whose read stops after this many rows, by its arguments */
  stop: null as null | ((args: Args) => number | null),
  /** a batch that fails, by its arguments */
  fail: null as null | ((args: Args) => unknown),
  /** a batch that answers not ready, by its arguments */
  notReady: null as null | ((args: Args) => boolean),
}))

const cursorOf = (row: Row) => JSON.stringify([row.name, row.id])
const order = (a: Row, b: Row) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
const past = (row: Row, cursor: string) => {
  const [name, id] = JSON.parse(cursor) as [string, string]
  return order(row, { name, id }) > 0
}

/** What the server answers for one batch, which may say it is not ready. */
function answer(args: Args): ListBatch<Row> & { ready?: false } {
  const failure = server.fail?.(args)
  if (failure) throw failure
  if (server.notReady?.(args)) return { rows: [], next: null, stopped: false, ready: false }
  const rows = [...server.labels].map(([id, name]) => ({ id, name })).sort(order)
  const after = args.after ?? null
  const through = args.through ?? null
  const limit = through === null ? server.batch : 4 * server.batch
  const stopAt = server.stop?.(args) ?? null
  const out: Row[] = []
  let at: string | null = after
  for (const row of rows) {
    if (after !== null && !past(row, after)) continue
    if (through !== null && past(row, through)) return { rows: out, next: through, stopped: false }
    if (stopAt !== null && out.length >= stopAt)
      return { rows: out, next: at as string, stopped: true }
    if (out.length >= limit)
      return { rows: out, next: at as string, stopped: through !== null && at !== through }
    out.push(row)
    at = cursorOf(row)
  }
  return { rows: out, next: null, stopped: false }
}

/* The live transport double, with one token a watch, whose result the test
   publishes in one transition, as Convex sends what one change brought. */
const transport = vi.hoisted(() => {
  type Watch = {
    args: Record<string, unknown>
    live: boolean
    json?: string
    value?: unknown
    error?: unknown
  }
  const handlers = new Set<(transition: LiveTransition) => void>()
  const watches = new Map<string, Watch>()
  const state = { n: 0, connection: 1, joined: false }
  const live = {
    watch: (_ref: unknown, args: Record<string, unknown>) => {
      const token = `t${++state.n}`
      watches.set(token, { args, live: true })
      return {
        token,
        joined: state.joined,
        stop: () => {
          const w = watches.get(token)
          if (w) w.live = false
        },
      }
    },
    read: (token: string) => {
      const w = watches.get(token)
      if (w?.error !== undefined) throw w.error
      return w?.value
    },
    onTransition: (fn: (transition: LiveTransition) => void) => {
      handlers.add(fn)
      return () => handlers.delete(fn)
    },
    query: async () => null,
  }
  return { live, handlers, watches, state }
})
vi.mock('./convex', () => ({ live: transport.live }))

const {
  listEnd,
  PAGE_LIMITS,
  pageEnd,
  useMoreOnScroll,
  usePagedList,
  usePagedPages,
  useSettledSearch,
} = await import('./pagedList')

let container: HTMLDivElement
let root: Root
/* What the page rendered, newest last, as a component keeps no outside
   variable. */
const views: PagedList<ListBatch<Row>, Row>[] = []
/** The list as the page rendered it last. */
const now = () => views[views.length - 1] as PagedList<ListBatch<Row>, Row>

/** The arguments of one batch of list `name`, in a fixed key order. */
const argsOf = (name: string, at: BatchAt) => ({
  list: name,
  ...(at.after === null ? {} : { after: at.after }),
  ...(at.through === null ? {} : { through: at.through }),
})

const LIVE = (name: string): BatchSource<ListBatch<Row>> => ({
  kind: 'live',
  query: anyApi.labels.settingsPage,
  args: (at) => argsOf(name, at),
})

/** Renders a page that lists `listKey` from `source`, where an answer
    that says it is not ready holds no batch. */
function View({
  listKey,
  source,
  most = 200,
}: {
  listKey: string | null
  source: BatchSource<ListBatch<Row>>
  most?: number
}) {
  views.push(
    usePagedList({
      key: listKey,
      source,
      batch: (a) => ('ready' in a ? null : a),
      id: (row) => row.id,
      most,
    }),
  )
  return null
}

const render = (props: Parameters<typeof View>[0]) =>
  act(async () => root.render(<View {...props} />))

/** The live watches, each with its arguments. */
const open = () => [...transport.watches.values()].filter((w) => w.live).map((w) => w.args as Args)

/** Sends one transition with every live watch's answer that changed, or
    every one with `all`, and lets the list take it in. */
async function publish(all = false) {
  await act(async () => {
    const tokens = new Set<string>()
    for (const [token, w] of transport.watches) {
      if (!w.live) continue
      let json: string
      let value: unknown
      let error: unknown
      try {
        value = answer(w.args as Args)
        json = JSON.stringify(value)
      } catch (e) {
        error = e
        json = `error ${String(e)}`
      }
      if (!all && json === w.json) continue
      Object.assign(w, { json, value, error })
      tokens.add(token)
    }
    for (const fn of transport.handlers)
      fn({ tokens, at: 0, connection: transport.state.connection })
    await Promise.resolve()
  })
}

/** Sends one transition with the answers of the live watches `match`
    picks, as Convex sends what changed for some batches only. */
async function publishOnly(match: (args: Args) => boolean) {
  await act(async () => {
    const tokens = new Set<string>()
    for (const [token, w] of transport.watches) {
      if (!w.live || !match(w.args as Args)) continue
      const value = answer(w.args as Args)
      Object.assign(w, { json: JSON.stringify(value), value })
      tokens.add(token)
    }
    for (const fn of transport.handlers)
      fn({ tokens, at: 0, connection: transport.state.connection })
    await Promise.resolve()
  })
}

const names = () => now().rows.map((row) => row.name)
/** Labels named `prefix00` to `prefix<n-1>`, each its own id. */
const plant = (prefix: string, n: number) => {
  for (let i = 0; i < n; i++)
    server.labels.set(`${prefix}-${i}`, `${prefix}${String(i).padStart(2, '0')}`)
}

async function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  server.labels.clear()
  views.length = 0
  Object.assign(server, { batch: 25, stop: null, fail: null, notReady: null })
  transport.watches.clear()
  transport.handlers.clear()
  Object.assign(transport.state, { n: 0, connection: 1, joined: false })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(document, 'visibilityState')
  vi.unstubAllGlobals()
})

/* ------------------------------------------------------------------ once */

describe('a list read once a batch', () => {
  /** A source whose reads wait until the test answers them. */
  function deferred() {
    const asked: { at: BatchAt; key: string; answer: (a: ListBatch<Row> | null) => void }[] = []
    let current = 'k'
    const source: BatchSource<ListBatch<Row>> = {
      kind: 'once',
      read: (at) =>
        new Promise((resolve) => {
          asked.push({ at, key: current, answer: resolve })
        }),
    }
    return {
      asked,
      source,
      setKey: (k: string) => {
        current = k
      },
      /** Answers the newest read with what the server holds, or `a`. */
      reply: (a?: ListBatch<Row> | null) =>
        act(async () => {
          const r = asked.at(-1)
          r?.answer(a === undefined ? answer(r.at.after ? { after: r.at.after } : {}) : a)
        }),
    }
  }

  it('reads the first batch, then Load more after the last next, one read at a time', async () => {
    plant('a', 60)
    const d = deferred()
    await render({ listKey: 'k', source: d.source })
    expect(now().phase).toBe('first')
    expect(listEnd(now(), false)).toBe('loading')
    await d.reply()
    expect(names()).toHaveLength(25)
    expect(now().phase).toBe('ready')
    expect(listEnd(now(), false)).toBe('more')
    // a second press and a Retry while a read runs read nothing
    await act(async () => {
      now().more()
      now().more()
      now().retry()
    })
    expect(d.asked).toHaveLength(2)
    expect(d.asked[1]?.at).toEqual({ after: JSON.stringify(['a24', 'a-24']), through: null })
    expect(now().phase).toBe('more')
    await d.reply()
    await act(async () => now().more())
    await d.reply()
    expect(names()).toHaveLength(60)
    expect(names().at(-1)).toBe('a59')
    expect(listEnd(now(), false)).toBe('end')
    // nothing is subscribed
    expect(open()).toEqual([])
  })

  it('keeps its rows and place when Load more fails, and Retry continues there', async () => {
    plant('a', 30)
    const d = deferred()
    await render({ listKey: 'k', source: d.source })
    await d.reply()
    await act(async () => now().more())
    await d.reply(null)
    expect(now().phase).toBe('failed')
    expect(names()).toHaveLength(25)
    expect(listEnd(now(), false)).toBe('failed')
    await act(async () => now().retry())
    expect(d.asked.at(-1)?.at.after).toBe(JSON.stringify(['a24', 'a-24']))
    await d.reply()
    expect(names()).toHaveLength(30)
    expect(listEnd(now(), false)).toBe('end')
  })

  it('starts again on Retry after a failed first batch, and holds a first answer with no rows', async () => {
    plant('a', 3)
    const d = deferred()
    await render({ listKey: 'k', source: { ...d.source } })
    await d.reply(null)
    expect(now().phase).toBe('failed')
    await act(async () => now().retry())
    expect(d.asked.at(-1)?.at).toEqual({ after: null, through: null })
    await d.reply()
    expect(names()).toEqual(['a00', 'a01', 'a02'])
    expect(listEnd(now(), false)).toBe('end')
  })

  it('holds a first answer with no rows, and fails a later one, keeping its rows', async () => {
    plant('a', 30)
    const replies: (ListBatch<Row> | 'not ready')[] = ['not ready', answer({}), 'not ready']
    const source: BatchSource<ListBatch<Row> | 'not ready'> = {
      kind: 'once',
      read: async () => replies.shift() ?? null,
    }
    const helds: PagedList<ListBatch<Row> | 'not ready', Row>[] = []
    function Held() {
      helds.push(
        usePagedList({
          key: 'k',
          source,
          batch: (a) => (a === 'not ready' ? null : a),
          id: (row) => row.id,
          most: 200,
        }),
      )
      return null
    }
    await act(async () => root.render(<Held />))
    expect(helds.at(-1)?.phase).toBe('held')
    expect(helds.at(-1)?.failure).toBeNull()
    expect(listEnd(helds.at(-1) as unknown as PagedList<unknown, unknown>, false)).toBe('held')
    // Retry starts a held list again
    await act(async () => helds.at(-1)?.retry())
    expect(helds.at(-1)?.rows).toHaveLength(25)
    await act(async () => helds.at(-1)?.more())
    // a later batch with no rows is a failure that keeps the rows, and its
    // answer for the page to say why
    expect(helds.at(-1)?.phase).toBe('failed')
    expect(helds.at(-1)?.rows).toHaveLength(25)
    expect(helds.at(-1)?.failure).toBe('not ready')
    // a read that fails outright leaves no answer
    await act(async () => helds.at(-1)?.retry())
    expect(helds.at(-1)?.phase).toBe('failed')
    expect(helds.at(-1)?.failure).toBeNull()
  })

  it('drops an answer for an older key and one that arrives after the page left', async () => {
    plant('a', 30)
    const d = deferred()
    await render({ listKey: 'k', source: d.source })
    const older = d.asked[0]
    await render({ listKey: 'j', source: d.source })
    await act(async () =>
      older?.answer({ rows: [{ id: 'x', name: 'old' }], next: null, stopped: false }),
    )
    expect(now().rows).toEqual([])
    expect(now().phase).toBe('first')
    await d.reply()
    expect(names()).toHaveLength(25)
    await act(async () => now().more())
    const late = d.asked.at(-1)
    const renders = vi.fn()
    const shown = now()
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => {
      renders()
      late?.answer({ rows: [{ id: 'y', name: 'late' }], next: null, stopped: false })
    })
    // nothing rendered the late answer
    expect(now()).toBe(shown)
    expect(now().rows.some((row) => row.name === 'late')).toBe(false)
  })

  it('says the cap is reached, and never ends a stopped batch', async () => {
    plant('a', 60)
    const d = deferred()
    await render({ listKey: 'k', source: d.source, most: 50 })
    await d.reply()
    await act(async () => now().more())
    await d.reply()
    expect(names()).toHaveLength(50)
    expect(now().full).toBe(true)
    expect(listEnd(now(), false)).toBe('full')
    // a search that matched nothing in the part the server read
    await render({ listKey: 's', source: d.source })
    d.setKey('s')
    await d.reply({ rows: [], next: 'part-2', stopped: true })
    expect(now().stopped).toBe(true)
    expect(listEnd(now(), true)).toBe('more')
    expect(listEnd({ ...now(), next: false }, true)).toBe('partial')
  })
})

/* ------------------------------------------------------------------ live */

describe('a list kept live a batch at a time', () => {
  it('opens one watch for the first batch, and takes no result Convex kept', async () => {
    plant('a', 30)
    transport.state.joined = false
    await render({ listKey: 'k', source: LIVE('k') })
    expect(open()).toEqual([{ list: 'k' }])
    // a value read before a transition names the watch is not taken
    const [w] = transport.watches.values()
    if (w) w.value = { rows: [{ id: 'kept', name: 'kept' }], next: null, stopped: false }
    await act(async () => {})
    expect(now().phase).toBe('first')
    expect(now().rows).toEqual([])
    await publish()
    expect(names()).toHaveLength(25)
    expect(listEnd(now(), false)).toBe('more')
    expect(now().refreshing).toBe(false)
  })

  it('pins the open batch on Load more and opens only the next one, showing the press-time rows until both answer', async () => {
    plant('a', 60)
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    const end = JSON.stringify(['a24', 'a-24'])
    await act(async () => now().more())
    expect(open()).toEqual([{ list: 'k' }, { list: 'k', through: end }, { list: 'k', after: end }])
    expect(now().phase).toBe('more')
    expect(names()).toHaveLength(25)
    expect(listEnd(now(), false)).toBe('more')
    await publish()
    // the pinned batch and the next replace the open one, whose watch stops
    expect(open()).toEqual([
      { list: 'k', through: end },
      { list: 'k', after: end },
    ])
    expect(names()).toHaveLength(50)
    expect(now().phase).toBe('ready')
  })

  it('shows a label made inside a pinned batch and loses none behind Load more', async () => {
    plant('a', 60)
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    await act(async () => now().more())
    await publish()
    expect(names()).toContain('a24')
    // a name between a00 and a01, so the pinned first batch grows, the second
    // keeps its start, and a24 stays in view
    server.labels.set('new', 'a00 new')
    await publish()
    expect(names()).toHaveLength(51)
    expect(names().slice(0, 3)).toEqual(['a00', 'a00 new', 'a01'])
    expect(names()).toContain('a24')
    expect(names().at(-1)).toBe('a49')
  })

  it('splits a pinned batch that stops short once, and not one that stops without moving', async () => {
    plant('a', 60)
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    await act(async () => now().more())
    await publish()
    const end = JSON.stringify(['a24', 'a-24'])
    const middle = JSON.stringify(['a11', 'a-11'])
    // the pinned first batch stops after 12 rows
    server.stop = (args) => (args.through === end && args.after === undefined ? 12 : null)
    await publish()
    expect(open()).toContainEqual({ list: 'k', through: middle })
    expect(open()).toContainEqual({ list: 'k', after: middle, through: end })
    // its earlier answer shows until both halves answered, with no end claimed
    expect(names()).toHaveLength(50)
    expect(now().settling).toBe(true)
    expect(listEnd(now(), false)).toBe('loading')
    // the halves answer while the pinned batch still stops, and replace it
    await publish()
    expect(now().settling).toBe(false)
    expect(names()).toHaveLength(50)
    expect(now().batches).toHaveLength(3)
    // a pinned batch whose read stops at its own start checked nothing, so it
    // keeps its rows, says so in place and asks no batch through its start
    server.stop = (args) => (args.after === middle && args.through === end ? 0 : null)
    await publish()
    expect(open().some((a) => a.after === middle && a.through === middle)).toBe(false)
    expect(now().batches[1]?.note).toBe('stuck')
    expect(names()).toHaveLength(50)
    expect(now().partial).toBe(true)
    expect(listEnd({ ...now(), next: false }, false)).toBe('partial')
    server.stop = null
    const before = open().length
    await act(async () => now().retry(now().batches[1]?.id))
    expect(open()).toHaveLength(before)
    await publish(true)
    expect(now().batches[1]?.note).toBeNull()
  })

  it('shows one moment: a row renamed into a batch on its way never goes missing', async () => {
    plant('a', 60)
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    await act(async () => now().more())
    await publish()
    // Load more on the second batch, then a01 renamed into its range
    await act(async () => now().more())
    server.labels.set('a-1', 'a30 moved')
    // only the first batch answers before the press's batches, and it keeps
    // what it showed, so the moved row still shows once
    for (const [token, w] of transport.watches)
      if (w.live && !w.args.after && w.args.through) {
        Object.assign(w, { value: answer(w.args as Args) })
        await act(async () => {
          for (const fn of transport.handlers)
            fn({ tokens: new Set([token]), at: 0, connection: 1 })
          await Promise.resolve()
        })
      }
    expect(names().filter((n) => n === 'a01' || n === 'a30 moved')).toEqual(['a01'])
    await publish()
    expect(names().filter((n) => n === 'a01' || n === 'a30 moved')).toEqual(['a30 moved'])
    expect(new Set(now().rows.map((row) => row.id)).size).toBe(now().rows.length)
  })

  it('shows a row two batches hold once, from the first', async () => {
    plant('a', 30)
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    await act(async () => now().more())
    await publish()
    // a rename moves a00 to the end, and only the second batch answers
    server.labels.set('a-0', 'a99')
    for (const [token, w] of transport.watches)
      if (w.live && w.args.after) {
        Object.assign(w, { value: answer(w.args as Args) })
        await act(async () => {
          for (const fn of transport.handlers)
            fn({ tokens: new Set([token]), at: 0, connection: 1 })
          await Promise.resolve()
        })
      }
    expect(now().rows.filter((row) => row.id === 'a-0')).toHaveLength(1)
  })

  it('stops every watch while hidden, keeps its rows and refreshes the same batches on return', async () => {
    plant('a', 60)
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    await act(async () => now().more())
    await publish()
    const asked = open()
    await setVisibility('hidden')
    expect(open()).toEqual([])
    expect(names()).toHaveLength(50)
    expect(now().refreshing).toBe(false)
    await setVisibility('visible')
    expect(open()).toEqual(asked)
    expect(now().refreshing).toBe(true)
    expect(names()).toHaveLength(50)
    await publish(true)
    expect(now().refreshing).toBe(false)
  })

  it('waits on return for each batch of a Load more to answer again, so no answer from before the tab hid joins one from after', async () => {
    plant('a', 60)
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    await act(async () => now().more())
    // the pinned batch answers and the next one has not when the tab hides
    await publishOnly((args) => !!args.through)
    expect(names()).toHaveLength(25)
    await setVisibility('hidden')
    // a30, past the pinned batch's end, is renamed into it while hidden
    server.labels.set('a-30', 'a10 moved')
    await setVisibility('visible')
    // the next batch answers first, and the pinned batch's answer is from
    // before the tab hid, so the press-time rows still show
    await publishOnly((args) => !!args.after)
    expect(now().phase).toBe('more')
    expect(names()).toHaveLength(25)
    // once the pinned batch answers again, both replace the open batch and
    // the moved row shows once
    await publishOnly((args) => !!args.through)
    expect(now().phase).toBe('ready')
    expect(now().refreshing).toBe(false)
    expect(names()).toHaveLength(51)
    expect(names().filter((n) => n === 'a10 moved')).toHaveLength(1)
    expect(names()).not.toContain('a30')
  })

  it('refreshes after a reconnect until each batch answered again', async () => {
    plant('a', 60)
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    await act(async () => now().more())
    await publish()
    transport.state.connection = 2
    // the first answer after the reconnect names one batch only
    const [token] = [...transport.watches].find(([, w]) => w.live && w.args.through) ?? []
    await act(async () => {
      for (const fn of transport.handlers)
        fn({ tokens: new Set(token ? [token] : []), at: 0, connection: 2 })
      await Promise.resolve()
    })
    expect(now().refreshing).toBe(true)
    await publish(true)
    expect(now().refreshing).toBe(false)
  })

  it('starts again for a new key, showing no row of the old one, and leaves no watch when the page goes', async () => {
    plant('a', 30)
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    await render({ listKey: 'j', source: LIVE('j') })
    expect(open()).toEqual([{ list: 'j' }])
    expect(now().rows).toEqual([])
    expect(listEnd(now(), true)).toBe('loading')
    await publish()
    expect(names()).toHaveLength(25)
    await act(async () => root.unmount())
    root = createRoot(container)
    expect(open()).toEqual([])
    expect(transport.handlers.size).toBe(0)
  })

  it('starts again once for a refused position, and fails on a second', async () => {
    plant('a', 60)
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    await act(async () => now().more())
    await publish()
    const refusal = new ConvexError({ code: 'bad_request', message: 'not a cursor' })
    server.fail = (args) => (args.after || args.through ? refusal : null)
    await publish()
    // the list starts again from its first batch alone
    expect(open()).toEqual([{ list: 'k' }])
    server.fail = null
    await publish(true)
    expect(names()).toHaveLength(25)
    await act(async () => now().more())
    server.fail = (args) => (args.after || args.through ? refusal : null)
    await publish()
    expect(now().phase).toBe('failed')
    expect(open()).toEqual([])
    expect(listEnd(now(), false)).toBe('failed')
    server.fail = null
    await act(async () => now().retry())
    await publish()
    expect(names()).toHaveLength(25)
  })

  it('keeps a failed batch’s rows with its note in place, and Retry reads it again', async () => {
    plant('a', 60)
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    await act(async () => now().more())
    await publish()
    server.fail = (args) => (args.through && !args.after ? new Error('offline') : null)
    await publish()
    expect(now().batches[0]?.note).toBe('failed')
    expect(names()).toHaveLength(50)
    expect(now().partial).toBe(true)
    server.fail = null
    await act(async () => now().retry(now().batches[0]?.id))
    expect(now().batches[0]?.retrying).toBe(true)
    await publish(true)
    expect(now().batches[0]?.note).toBeNull()
    // the last batch failing is the list's failure, at its end
    server.fail = (args) => (args.after ? new Error('offline') : null)
    await publish()
    expect(now().phase).toBe('failed')
    expect(listEnd(now(), false)).toBe('failed')
  })

  it('keeps a later batch’s rows when its answer holds none, failing it in place', async () => {
    plant('a', 60)
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    await act(async () => now().more())
    await publish()
    expect(names()).toHaveLength(50)
    // the second batch's rerun answers not ready
    server.notReady = (args) => args.after !== undefined
    await publish()
    expect(now().phase).toBe('failed')
    expect(now().batches[1]?.note).toBe('failed')
    expect(names()).toHaveLength(50)
    expect(listEnd(now(), false)).toBe('failed')
    server.notReady = null
    await act(async () => now().retry())
    await publish(true)
    expect(now().phase).toBe('ready')
    expect(names()).toHaveLength(50)
  })

  it('gathers batches up to the cap of most / LIST_BATCH, then asks for a search', async () => {
    plant('a', 60)
    server.batch = 5
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    for (let i = 0; i < 10; i++) {
      await act(async () => now().more())
      await publish()
    }
    // eight batches of five, 200 / LIST_BATCH
    expect(now().batches).toHaveLength(8)
    expect(names()).toHaveLength(40)
    expect(now().full).toBe(true)
    expect(listEnd(now(), false)).toBe('full')
  })
})

/* ----------------------------------------------------------------- pages */

describe('a list shown a page at a time', () => {
  const pages: PagedPages<ListBatch<Row>, Row>[] = []
  const page = () => pages[pages.length - 1] as PagedPages<ListBatch<Row>, Row>
  const shown = () => page().rows.map((row) => row.name)
  function Pages({
    listKey,
    starts,
  }: {
    listKey: string | null
    starts?: readonly (string | null)[]
  }) {
    pages.push(
      usePagedPages({
        key: listKey,
        query: anyApi.labels.settingsPage,
        args: (after) => argsOf(listKey ?? '', { after, through: null }),
        batch: (a: ListBatch<Row> & { ready?: false }) => ('ready' in a ? null : a),
        starts,
      }),
    )
    return null
  }
  const show = (props: Parameters<typeof Pages>[0]) =>
    act(async () => root.render(<Pages {...props} />))
  const cursor = (name: string) => JSON.stringify([name, `a-${Number(name.slice(1))}`])

  beforeEach(() => {
    pages.length = 0
  })

  it('replaces the page on Next and Previous, keeping the shown page until the new one answered', async () => {
    plant('a', 60)
    await show({ listKey: 'k' })
    expect(page().phase).toBe('first')
    expect(pageEnd(page(), false)).toBe('loading')
    await publish()
    expect(shown()).toHaveLength(25)
    expect(shown()[0]).toBe('a00')
    expect(page().hasNext).toBe(true)
    expect(page().hasPrevious).toBe(false)
    await act(async () => page().next())
    expect(page().phase).toBe('moving')
    expect(page().moving).toBe('next')
    expect(open()).toEqual([{ list: 'k' }, { list: 'k', after: cursor('a24') }])
    // the page on screen stays until the next one answers
    expect(shown()[0]).toBe('a00')
    await publish()
    // one page on screen, never the two together
    expect(shown()).toHaveLength(25)
    expect(shown()[0]).toBe('a25')
    expect(open()).toEqual([{ list: 'k', after: cursor('a24') }])
    expect(page().hasPrevious).toBe(true)
    await act(async () => page().next())
    await publish()
    expect(shown()).toEqual(Array.from({ length: 10 }, (_, i) => `a${50 + i}`))
    expect(page().hasNext).toBe(false)
    expect(pageEnd(page(), false)).toBe('end')
    await act(async () => page().previous())
    await publish()
    expect(shown()[0]).toBe('a25')
    await act(async () => page().previous())
    await publish()
    expect(shown()[0]).toBe('a00')
    expect(page().hasPrevious).toBe(false)
    expect(page().starts).toEqual([null])
  })

  it('moves a row added before the page’s end to the next page, losing none between pages, and fills a row that left', async () => {
    plant('a', 60)
    await show({ listKey: 'k' })
    await publish()
    server.labels.set('new', 'a00 new')
    await publish()
    expect(shown()).toHaveLength(25)
    expect(shown().slice(0, 2)).toEqual(['a00', 'a00 new'])
    expect(shown().at(-1)).toBe('a23')
    await act(async () => page().next())
    await publish()
    // Next starts at the page's live end, so a24 opens the next page
    expect(shown()[0]).toBe('a24')
    // a row that leaves is filled from the next ones
    server.labels.delete('a-30')
    await publish()
    expect(shown()).toHaveLength(25)
    expect(shown()).not.toContain('a30')
    expect(shown().at(-1)).toBe('a49')
  })

  it('offers Next beside a stopped page, and Retry for one stopped at its start', async () => {
    plant('a', 60)
    server.stop = (args) => (args.after ? 0 : 10)
    await show({ listKey: 'k' })
    await publish()
    expect(shown()).toHaveLength(10)
    expect(page().stopped).toBe(true)
    expect(page().hasNext).toBe(true)
    expect(pageEnd(page(), false)).toBe('more')
    await act(async () => page().next())
    await publish()
    // the read checked nothing past its start, so Next would read it again
    expect(shown()).toEqual([])
    expect(page().stuck).toBe(true)
    expect(page().hasNext).toBe(false)
    expect(pageEnd(page(), false)).toBe('stuck')
    server.stop = null
    await act(async () => page().retry())
    await publish()
    expect(shown()[0]).toBe('a10')
    expect(page().stuck).toBe(false)
  })

  it('keeps the page on screen when a move fails, and Retry tries the move again', async () => {
    plant('a', 60)
    await show({ listKey: 'k' })
    await publish()
    server.fail = (args) => (args.after ? new Error('offline') : null)
    await act(async () => page().next())
    await publish()
    expect(page().failedMove).toBe('next')
    expect(page().phase).toBe('ready')
    expect(shown()[0]).toBe('a00')
    expect(open()).toEqual([{ list: 'k' }])
    server.fail = null
    await act(async () => page().retry())
    expect(page().moving).toBe('next')
    await publish()
    expect(page().failedMove).toBe(null)
    expect(shown()[0]).toBe('a25')
  })

  it('reads a failed page again before the move that failed beside it, on one Retry', async () => {
    plant('a', 60)
    await show({ listKey: 'k' })
    await publish()
    await act(async () => page().next())
    // the page on screen and its Next fail in one transition, which leaves
    // Next no start until the page answers again
    server.fail = () => new Error('offline')
    await publish()
    expect(page().failedMove).toBe('next')
    expect(page().phase).toBe('failed')
    expect(shown()[0]).toBe('a00')
    // a Retry whose page read fails once more keeps Next failed beside it
    await act(async () => page().retry())
    await publish()
    expect(page().failedMove).toBe('next')
    expect(page().moving).toBe(null)
    const watches = transport.watches.size
    server.fail = null
    await act(async () => page().retry())
    // the page reads again first, on a watch of its own
    expect(transport.watches.size).toBe(watches + 1)
    expect(open()).toEqual([{ list: 'k' }])
    await publish()
    // then Next, from the page's new answer
    expect(page().moving).toBe('next')
    expect(open()).toEqual([{ list: 'k' }, { list: 'k', after: cursor('a24') }])
    await publish()
    expect(page().failedMove).toBe(null)
    expect(page().phase).toBe('ready')
    expect(shown()[0]).toBe('a25')
  })

  it('ends a failed Next on Retry once the page on screen has become the last', async () => {
    plant('a', 30)
    await show({ listKey: 'k' })
    await publish()
    server.fail = (args) => (args.after ? new Error('offline') : null)
    await act(async () => page().next())
    await publish()
    expect(page().failedMove).toBe('next')
    // the rows past the page leave, so it is the last
    for (let i = 25; i < 30; i++) server.labels.delete(`a-${i}`)
    await publish()
    expect(page().hasNext).toBe(false)
    const watches = transport.watches.size
    await act(async () => page().retry())
    // Retry has nowhere to go, so the failed Next is over and reads nothing
    expect(page().failedMove).toBe(null)
    expect(page().moving).toBe(null)
    expect(transport.watches.size).toBe(watches)
  })

  it('goes back to the first page once for a refused start, then fails, and Retry starts again', async () => {
    plant('a', 60)
    await show({ listKey: 'k' })
    await publish()
    await act(async () => page().next())
    await publish()
    const refusal = new ConvexError({ code: 'bad_request', message: 'not a cursor' })
    server.fail = (args) => (args.after ? refusal : null)
    await publish()
    expect(open()).toEqual([{ list: 'k' }])
    expect(page().starts).toEqual([null])
    await publish(true)
    expect(shown()[0]).toBe('a00')
    await act(async () => page().next())
    await publish()
    expect(page().phase).toBe('failed')
    expect(pageEnd(page(), false)).toBe('failed')
    expect(open()).toEqual([])
    server.fail = null
    await act(async () => page().retry())
    await publish()
    expect(shown()[0]).toBe('a00')
    expect(page().phase).toBe('ready')
  })

  it('keeps at most PAGE_LIMITS.starts page starts, so Previous stops at the oldest held', async () => {
    const was = PAGE_LIMITS.starts
    PAGE_LIMITS.starts = 2
    try {
      plant('a', 100)
      await show({ listKey: 'k' })
      await publish()
      for (let i = 0; i < 3; i++) {
        await act(async () => page().next())
        await publish()
      }
      expect(shown()[0]).toBe('a75')
      expect(page().starts).toHaveLength(2)
      await act(async () => page().previous())
      await publish()
      expect(shown()[0]).toBe('a50')
      expect(page().hasPrevious).toBe(false)
    } finally {
      PAGE_LIMITS.starts = was
    }
  })

  it('starts a new key at the first page, or at the starts a page remembered for it', async () => {
    plant('a', 60)
    await show({ listKey: 'k' })
    await publish()
    await act(async () => page().next())
    await publish()
    const remembered = page().starts
    await show({ listKey: 'j' })
    expect(open()).toEqual([{ list: 'j' }])
    expect(page().rows).toEqual([])
    expect(page().phase).toBe('first')
    await show({ listKey: 'k2', starts: remembered })
    expect(open()).toEqual([{ list: 'k2', after: cursor('a24') }])
    await publish()
    expect(shown()[0]).toBe('a25')
    expect(page().hasPrevious).toBe(true)
  })

  it('holds an answer with no rows on any page, and stops while hidden, refreshing on return', async () => {
    plant('a', 60)
    await show({ listKey: 'k' })
    await publish()
    await setVisibility('hidden')
    expect(open()).toEqual([])
    expect(shown()).toHaveLength(25)
    await setVisibility('visible')
    expect(open()).toEqual([{ list: 'k' }])
    expect(page().refreshing).toBe(true)
    await publish(true)
    expect(page().refreshing).toBe(false)
    server.notReady = (args) => !!args.after
    await act(async () => page().next())
    await publish()
    expect(page().phase).toBe('held')
    expect(pageEnd(page(), false)).toBe('held')
    expect(shown()).toEqual([])
  })

  it('leaves no read when the page goes', async () => {
    plant('a', 60)
    await show({ listKey: 'k' })
    await publish()
    await act(async () => page().next())
    await act(async () => root.unmount())
    root = createRoot(container)
    expect(open()).toEqual([])
    expect(transport.handlers.size).toBe(0)
  })
})

describe('the line that ends a page', () => {
  const base = {
    phase: 'ready' as const,
    hasNext: false,
    hasPrevious: false,
    stuck: false,
    rows: [{ id: 'a' }],
  }
  it.each([
    ['loading', { phase: 'first' as const }, false],
    ['held', { phase: 'held' as const, rows: [] }, false],
    ['failed', { phase: 'failed' as const, hasNext: true }, false],
    ['stuck', { stuck: true, rows: [] }, true],
    ['more', { hasNext: true, rows: [] }, true],
    ['more', { phase: 'moving' as const, hasNext: true }, false],
    ['none', { rows: [] }, true],
    ['empty', { rows: [] }, false],
    ['nomore', { rows: [], hasPrevious: true }, true],
    ['nomore', { rows: [], hasPrevious: true }, false],
    ['end', {}, false],
    ['end', { hasPrevious: true }, true],
  ])('answers %s for %j', (want, patch, searching) => {
    expect(pageEnd({ ...base, ...patch }, searching)).toBe(want)
  })
})

describe('a list that loads more as its end scrolls into view', () => {
  /* The observers made, each with its callback and the element it watches. */
  const observers: { fire: (inView: boolean) => void; disconnected: boolean }[] = []
  beforeEach(() => {
    observers.length = 0
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        entry: { fire: (inView: boolean) => void; disconnected: boolean }
        constructor(receive: (entries: { isIntersecting: boolean }[]) => void) {
          this.entry = {
            fire: (inView) => receive([{ isIntersecting: inView }]),
            disconnected: false,
          }
          observers.push(this.entry)
        }
        observe() {}
        disconnect() {
          this.entry.disconnected = true
        }
      },
    )
  })
  function Scrolled({ listKey }: { listKey: string }) {
    const list = usePagedList({
      key: listKey,
      source: LIVE(listKey),
      batch: (a: ListBatch<Row>) => a,
      id: (row) => row.id,
      most: 100,
    })
    views.push(list)
    const marker = useMoreOnScroll(
      list.more,
      listEnd(list, false) === 'more' && list.phase !== 'more',
    )
    return <div ref={marker} />
  }
  const fire = (inView: boolean) =>
    act(async () => {
      for (const o of observers) if (!o.disconnected) o.fire(inView)
    })

  it('reads the next batch once the marker is in view and the list may read, and not before', async () => {
    plant('a', 120)
    await act(async () => root.render(<Scrolled listKey="k" />))
    // before the first batch the list may not read more
    await fire(true)
    expect(open()).toEqual([{ list: 'k' }])
    await fire(false)
    await publish()
    expect(names()).toHaveLength(25)
    // out of view, nothing reads
    expect(open()).toEqual([{ list: 'k' }])
    await fire(true)
    expect(open()).toHaveLength(3)
    expect(now().phase).toBe('more')
    // once the batch lands with the marker still in view, the next one reads
    await publish()
    expect(names()).toHaveLength(50)
    expect(now().phase).toBe('more')
    await publish()
    await publish()
    await publish()
    // at the cap of 100 rows, it asks for a search and reads nothing more
    expect(names()).toHaveLength(100)
    expect(listEnd(now(), false)).toBe('full')
    await fire(true)
    expect(now().batches).toHaveLength(4)
  })

  it('stops observing when the list goes', async () => {
    plant('a', 30)
    await act(async () => root.render(<Scrolled listKey="k" />))
    await act(async () => root.unmount())
    root = createRoot(container)
    expect(observers.every((o) => o.disconnected)).toBe(true)
  })
})

/* --------------------------------------------------------------- helpers */

describe('a search box as a list asks with it', () => {
  const boxes: ReturnType<typeof useSettledSearch>[] = []
  function Box({ text }: { text: string }) {
    boxes.push(useSettledSearch(text, LIMITS.search))
    return null
  }

  it('settles once typing rests, at once when cleared, and keeps the last search within the limit', async () => {
    vi.useFakeTimers()
    try {
      await act(async () => root.render(<Box text="" />))
      expect(boxes.at(-1)).toEqual({ typed: '', tooLong: false, settled: '' })
      await act(async () => root.render(<Box text=" fir " />))
      expect(boxes.at(-1)).toEqual({ typed: 'fir', tooLong: false, settled: '' })
      await act(async () => vi.advanceTimersByTime(249))
      expect(boxes.at(-1)?.settled).toBe('')
      await act(async () => vi.advanceTimersByTime(1))
      expect(boxes.at(-1)?.settled).toBe('fir')
      const long = 'x'.repeat(LIMITS.search.max + 1)
      await act(async () => root.render(<Box text={long} />))
      await act(async () => vi.advanceTimersByTime(1000))
      expect(boxes.at(-1)).toEqual({ typed: long, tooLong: true, settled: 'fir' })
      await act(async () => root.render(<Box text="" />))
      expect(boxes.at(-1)?.settled).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the line that ends a list', () => {
  const base = {
    phase: 'ready' as const,
    next: false,
    full: false,
    stopped: false,
    partial: false,
    settling: false,
    rows: [{ id: 'a' }],
  }
  it.each([
    ['loading', { phase: 'first' as const }, false],
    ['held', { phase: 'held' as const }, false],
    ['failed', { phase: 'failed' as const, next: true }, false],
    ['loading', { settling: true, next: true }, false],
    ['full', { next: true, full: true }, false],
    ['more', { next: true }, false],
    ['more', { next: true, stopped: true, rows: [] }, true],
    ['partial', { partial: true }, false],
    ['partial', { stopped: true, rows: [] }, true],
    ['none', { rows: [] }, true],
    ['end', { rows: [] }, false],
    ['end', {}, true],
  ])('answers %s for %j', (want, patch, searching) => {
    expect(listEnd({ ...base, ...patch }, searching)).toBe(want)
  })
})
