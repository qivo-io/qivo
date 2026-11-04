// @vitest-environment jsdom
import { anyApi } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../../convex/lib/limits'
import type { LiveTransition } from './liveQueries'
import type { BatchAt, BatchSource, ListBatch, PagedList } from './pagedList'

/* The shared paged list (lib/pagedList.ts) over a transport double and a
   small name-ordered server: the `once` source's reads on demand, and the
   `live` source's batches, kept live with ends pinned on Load more, split
   when a pinned batch stops short, holding one moment's answers, stopped
   while the tab is hidden and on leaving, and started again for a refused
   position. Its two helpers, useSettledSearch and listEnd, have cases of
   their own. */

type Row = { id: string; name: string }
type Args = { list?: string; after?: string; through?: string }

/* The server: labels by id, in name order then id, read a batch at a time
   as convex/model/labels.ts labelBatch reads them. A cursor is the
   position's text, so equal positions give equal cursors. */
const server = vi.hoisted(() => ({
  labels: new Map<string, string>(),
  batch: 25,
  /** a batch whose read stops after this many rows, by its arguments */
  stop: null as null | ((args: Args) => number | null),
  /** a batch that fails, by its arguments */
  fail: null as null | ((args: Args) => unknown),
}))

const cursorOf = (row: Row) => JSON.stringify([row.name, row.id])
const order = (a: Row, b: Row) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
const past = (row: Row, cursor: string) => {
  const [name, id] = JSON.parse(cursor) as [string, string]
  return order(row, { name, id }) > 0
}

/** What the server answers for one batch. */
function answer(args: Args): ListBatch<Row> {
  const failure = server.fail?.(args)
  if (failure) throw failure
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

/* The live transport double: one token a watch, whose result the test
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

const { listEnd, usePagedList, useSettledSearch } = await import('./pagedList')

let container: HTMLDivElement
let root: Root
let list: PagedList<ListBatch<Row>, Row>

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

/** Renders a page that lists `listKey` from `source`. */
function View({
  listKey,
  source,
  most = 200,
}: {
  listKey: string | null
  source: BatchSource<ListBatch<Row>>
  most?: number
}) {
  list = usePagedList({ key: listKey, source, batch: (a) => a, id: (row) => row.id, most })
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

const names = () => list.rows.map((row) => row.name)
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
  Object.assign(server, { batch: 25, stop: null, fail: null })
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
    expect(list.phase).toBe('first')
    expect(listEnd(list, false)).toBe('loading')
    await d.reply()
    expect(names()).toHaveLength(25)
    expect(list.phase).toBe('ready')
    expect(listEnd(list, false)).toBe('more')
    // a second press and a Retry while a read runs read nothing
    await act(async () => {
      list.more()
      list.more()
      list.retry()
    })
    expect(d.asked).toHaveLength(2)
    expect(d.asked[1]?.at).toEqual({ after: JSON.stringify(['a24', 'a-24']), through: null })
    expect(list.phase).toBe('more')
    await d.reply()
    await act(async () => list.more())
    await d.reply()
    expect(names()).toHaveLength(60)
    expect(names().at(-1)).toBe('a59')
    expect(listEnd(list, false)).toBe('end')
    // nothing is subscribed
    expect(open()).toEqual([])
  })

  it('keeps its rows and place when Load more fails, and Retry continues there', async () => {
    plant('a', 30)
    const d = deferred()
    await render({ listKey: 'k', source: d.source })
    await d.reply()
    await act(async () => list.more())
    await d.reply(null)
    expect(list.phase).toBe('failed')
    expect(names()).toHaveLength(25)
    expect(listEnd(list, false)).toBe('failed')
    await act(async () => list.retry())
    expect(d.asked.at(-1)?.at.after).toBe(JSON.stringify(['a24', 'a-24']))
    await d.reply()
    expect(names()).toHaveLength(30)
    expect(listEnd(list, false)).toBe('end')
  })

  it('starts again on Retry after a failed first batch, and holds a first answer with no rows', async () => {
    plant('a', 3)
    const d = deferred()
    await render({ listKey: 'k', source: { ...d.source } })
    await d.reply(null)
    expect(list.phase).toBe('failed')
    await act(async () => list.retry())
    expect(d.asked.at(-1)?.at).toEqual({ after: null, through: null })
    await d.reply()
    expect(names()).toEqual(['a00', 'a01', 'a02'])
    expect(listEnd(list, false)).toBe('end')
  })

  it('holds a first answer with no rows, and fails a later one, keeping its rows', async () => {
    plant('a', 30)
    const replies: (ListBatch<Row> | 'not ready')[] = ['not ready', answer({}), 'not ready']
    const source: BatchSource<ListBatch<Row> | 'not ready'> = {
      kind: 'once',
      read: async () => replies.shift() ?? null,
    }
    let held: PagedList<ListBatch<Row> | 'not ready', Row> | null = null
    function Held() {
      held = usePagedList({
        key: 'k',
        source,
        batch: (a) => (a === 'not ready' ? null : a),
        id: (row) => row.id,
        most: 200,
      })
      return null
    }
    await act(async () => root.render(<Held />))
    expect(held?.phase).toBe('held')
    expect(listEnd(held as unknown as PagedList<unknown, unknown>, false)).toBe('held')
    // Retry starts a held list again
    await act(async () => held?.retry())
    expect(held?.rows).toHaveLength(25)
    await act(async () => held?.more())
    // a later batch with no rows is a failure that keeps the rows
    expect(held?.phase).toBe('failed')
    expect(held?.rows).toHaveLength(25)
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
    expect(list.rows).toEqual([])
    expect(list.phase).toBe('first')
    await d.reply()
    expect(names()).toHaveLength(25)
    await act(async () => list.more())
    const late = d.asked.at(-1)
    const renders = vi.fn()
    const shown = list
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => {
      renders()
      late?.answer({ rows: [{ id: 'y', name: 'late' }], next: null, stopped: false })
    })
    // nothing rendered the late answer
    expect(list).toBe(shown)
    expect(list.rows.some((row) => row.name === 'late')).toBe(false)
  })

  it('says the cap is reached, and never ends a stopped batch', async () => {
    plant('a', 60)
    const d = deferred()
    await render({ listKey: 'k', source: d.source, most: 50 })
    await d.reply()
    await act(async () => list.more())
    await d.reply()
    expect(names()).toHaveLength(50)
    expect(list.full).toBe(true)
    expect(listEnd(list, false)).toBe('full')
    // a search that matched nothing in the part the server read
    await render({ listKey: 's', source: d.source })
    d.setKey('s')
    await d.reply({ rows: [], next: 'part-2', stopped: true })
    expect(list.stopped).toBe(true)
    expect(listEnd(list, true)).toBe('more')
    expect(listEnd({ ...list, next: false }, true)).toBe('partial')
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
    expect(list.phase).toBe('first')
    expect(list.rows).toEqual([])
    await publish()
    expect(names()).toHaveLength(25)
    expect(listEnd(list, false)).toBe('more')
    expect(list.refreshing).toBe(false)
  })

  it('pins the open batch on Load more and opens only the next one, showing the press-time rows until both answer', async () => {
    plant('a', 60)
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    const end = JSON.stringify(['a24', 'a-24'])
    await act(async () => list.more())
    expect(open()).toEqual([{ list: 'k' }, { list: 'k', through: end }, { list: 'k', after: end }])
    expect(list.phase).toBe('more')
    expect(names()).toHaveLength(25)
    expect(listEnd(list, false)).toBe('more')
    await publish()
    // the pinned batch and the next replace the open one, whose watch stops
    expect(open()).toEqual([
      { list: 'k', through: end },
      { list: 'k', after: end },
    ])
    expect(names()).toHaveLength(50)
    expect(list.phase).toBe('ready')
  })

  it('shows a label made inside a pinned batch and loses none behind Load more', async () => {
    plant('a', 60)
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    await act(async () => list.more())
    await publish()
    expect(names()).toContain('a24')
    // a name between a00 and a01: the pinned first batch grows, the second
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
    await act(async () => list.more())
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
    expect(list.settling).toBe(true)
    expect(listEnd(list, false)).toBe('loading')
    // the halves answer while the pinned batch still stops: they replace it
    await publish()
    expect(list.settling).toBe(false)
    expect(names()).toHaveLength(50)
    expect(list.batches).toHaveLength(3)
    // a pinned batch whose read stops at its own start checked nothing: it
    // keeps its rows, says so in place and asks no batch through its start
    server.stop = (args) => (args.after === middle && args.through === end ? 0 : null)
    await publish()
    expect(open().some((a) => a.after === middle && a.through === middle)).toBe(false)
    expect(list.batches[1]?.note).toBe('stuck')
    expect(names()).toHaveLength(50)
    expect(list.partial).toBe(true)
    expect(listEnd({ ...list, next: false }, false)).toBe('partial')
    server.stop = null
    const before = open().length
    await act(async () => list.retry(list.batches[1]?.id))
    expect(open()).toHaveLength(before)
    await publish(true)
    expect(list.batches[1]?.note).toBeNull()
  })

  it('shows one moment: a row renamed into a batch on its way never goes missing', async () => {
    plant('a', 60)
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    await act(async () => list.more())
    await publish()
    // Load more on the second batch, then a01 renamed into its range
    await act(async () => list.more())
    server.labels.set('a-1', 'a30 moved')
    // only the first batch answers before the press's batches: it keeps
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
    expect(new Set(list.rows.map((row) => row.id)).size).toBe(list.rows.length)
  })

  it('shows a row two batches hold once, from the first', async () => {
    plant('a', 30)
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    await act(async () => list.more())
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
    expect(list.rows.filter((row) => row.id === 'a-0')).toHaveLength(1)
  })

  it('stops every watch while hidden, keeps its rows and refreshes the same batches on return', async () => {
    plant('a', 60)
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    await act(async () => list.more())
    await publish()
    const asked = open()
    await setVisibility('hidden')
    expect(open()).toEqual([])
    expect(names()).toHaveLength(50)
    expect(list.refreshing).toBe(false)
    await setVisibility('visible')
    expect(open()).toEqual(asked)
    expect(list.refreshing).toBe(true)
    expect(names()).toHaveLength(50)
    await publish(true)
    expect(list.refreshing).toBe(false)
  })

  it('refreshes after a reconnect until each batch answered again', async () => {
    plant('a', 60)
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    await act(async () => list.more())
    await publish()
    transport.state.connection = 2
    // the first answer after the reconnect names one batch only
    const [token] = [...transport.watches].find(([, w]) => w.live && w.args.through) ?? []
    await act(async () => {
      for (const fn of transport.handlers)
        fn({ tokens: new Set(token ? [token] : []), at: 0, connection: 2 })
      await Promise.resolve()
    })
    expect(list.refreshing).toBe(true)
    await publish(true)
    expect(list.refreshing).toBe(false)
  })

  it('starts again for a new key, showing no row of the old one, and leaves no watch when the page goes', async () => {
    plant('a', 30)
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    await render({ listKey: 'j', source: LIVE('j') })
    expect(open()).toEqual([{ list: 'j' }])
    expect(list.rows).toEqual([])
    expect(listEnd(list, true)).toBe('loading')
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
    await act(async () => list.more())
    await publish()
    const refusal = new ConvexError({ code: 'bad_request', message: 'not a cursor' })
    server.fail = (args) => (args.after || args.through ? refusal : null)
    await publish()
    // the list starts again from its first batch alone
    expect(open()).toEqual([{ list: 'k' }])
    server.fail = null
    await publish(true)
    expect(names()).toHaveLength(25)
    await act(async () => list.more())
    server.fail = (args) => (args.after || args.through ? refusal : null)
    await publish()
    expect(list.phase).toBe('failed')
    expect(open()).toEqual([])
    expect(listEnd(list, false)).toBe('failed')
    server.fail = null
    await act(async () => list.retry())
    await publish()
    expect(names()).toHaveLength(25)
  })

  it('keeps a failed batch’s rows with its note in place, and Retry reads it again', async () => {
    plant('a', 60)
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    await act(async () => list.more())
    await publish()
    server.fail = (args) => (args.through && !args.after ? new Error('offline') : null)
    await publish()
    expect(list.batches[0]?.note).toBe('failed')
    expect(names()).toHaveLength(50)
    expect(list.partial).toBe(true)
    server.fail = null
    await act(async () => list.retry(list.batches[0]?.id))
    expect(list.batches[0]?.retrying).toBe(true)
    await publish(true)
    expect(list.batches[0]?.note).toBeNull()
    // the last batch failing is the list's failure, at its end
    server.fail = (args) => (args.after ? new Error('offline') : null)
    await publish()
    expect(list.phase).toBe('failed')
    expect(listEnd(list, false)).toBe('failed')
  })

  it('gathers batches up to the cap of most / LIST_BATCH, then asks for a search', async () => {
    plant('a', 60)
    server.batch = 5
    await render({ listKey: 'k', source: LIVE('k') })
    await publish()
    for (let i = 0; i < 10; i++) {
      await act(async () => list.more())
      await publish()
    }
    // eight batches of five, 200 / LIST_BATCH
    expect(list.batches).toHaveLength(8)
    expect(names()).toHaveLength(40)
    expect(list.full).toBe(true)
    expect(listEnd(list, false)).toBe('full')
  })
})

/* --------------------------------------------------------------- helpers */

describe('a search box as a list asks with it', () => {
  let settled: ReturnType<typeof useSettledSearch>
  function Box({ text }: { text: string }) {
    settled = useSettledSearch(text, LIMITS.search)
    return null
  }

  it('settles once typing rests, at once when cleared, and keeps the last search within the limit', async () => {
    vi.useFakeTimers()
    try {
      await act(async () => root.render(<Box text="" />))
      expect(settled).toEqual({ typed: '', tooLong: false, settled: '' })
      await act(async () => root.render(<Box text=" fir " />))
      expect(settled).toEqual({ typed: 'fir', tooLong: false, settled: '' })
      await act(async () => vi.advanceTimersByTime(249))
      expect(settled.settled).toBe('')
      await act(async () => vi.advanceTimersByTime(1))
      expect(settled.settled).toBe('fir')
      const long = 'x'.repeat(LIMITS.search.max + 1)
      await act(async () => root.render(<Box text={long} />))
      await act(async () => vi.advanceTimersByTime(1000))
      expect(settled).toEqual({ typed: long, tooLong: true, settled: 'fir' })
      await act(async () => root.render(<Box text="" />))
      expect(settled.settled).toBe('')
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
