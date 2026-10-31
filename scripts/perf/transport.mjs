// Deterministic authenticated transport for browser CPU/DOM measurements only
// (scripts/benchmark-browser.mjs). It stands in for src/lib/convex and
// src/lib/auth and talks to a stand-in server in a Web Worker
// (scripts/perf/server.mjs), which holds the workspace and takes the page
// parameters it describes.
//
// The server's work runs on the worker's thread, so the page's script time
// holds only what a real client does with a result: the page decodes its
// JSON text as the Convex client does (JSON.parse, then jsonToConvex,
// convex/dist/esm/browser/sync/remote_query_set.js) and hands it to its
// listener, all in the one message task, as a WebSocket message would.
// Like Convex, a write's results reach the listeners before it resolves.
// `live` stands in for lib/liveQueries.ts: the server sends the workspace's
// parts that changed in one transition message, and the page decodes each
// and then calls the transition handlers once.
// window.__perf counts the bytes and results delivered and the time spent
// decoding them.
import { getFunctionName } from 'convex/server'
import { ConvexError, jsonToConvex } from 'convex/values'

const parameters = new URLSearchParams(location.search)
const server = new Worker(new URL('./server.mjs', import.meta.url), {
  type: 'module',
  name: parameters.toString(),
})
let next = 0
/* The listeners of the subscriptions, each with its error callback, and
   the calls waiting for an answer, by id. */
const receivers = new Map()
const calls = new Map()

/** Asks the server `message` and resolves with its answer. */
function call(message) {
  const id = `c${next++}`
  return new Promise((resolve, reject) => {
    calls.set(id, { resolve, reject })
    server.postMessage({ ...message, id })
  })
}

server.onmessage = ({ data }) => {
  window.__perf.writes = data.writes
  window.__perf.heldCount = data.held
  window.__perf.made = data.made
  window.__perf.cards = data.cards
  window.__perf.boardCards = data.boardCards
  window.__perf.boardRows = data.boardRows
  if (data.type === 'result' && data.error) {
    // a read the server could not answer, as Convex reports a failed query
    const failure = new Error(data.error)
    const receiver = receivers.get(data.to)
    if (receiver) receiver.fail?.(failure)
    else calls.get(data.to)?.reject(failure)
    calls.delete(data.to)
  } else if (data.type === 'result') {
    window.__perf.wireBytes += data.bytes
    window.__perf.deliveries++
    const start = performance.now()
    const value = jsonToConvex(JSON.parse(data.text))
    window.__perf.decodeMs += performance.now() - start
    const receiver = receivers.get(data.to)
    if (receiver) receiver.receive(value)
    else calls.get(data.to)?.resolve(value)
    calls.delete(data.to)
  } else if (data.type === 'transition') {
    const tokens = new Set()
    for (const result of data.results) {
      const token = partTokens.get(result.to)
      const entry = token && parts.get(token)
      if (!entry) continue
      tokens.add(token)
      if (result.error) {
        entry.error = new Error(result.error)
        continue
      }
      window.__perf.wireBytes += result.bytes
      window.__perf.deliveries++
      const start = performance.now()
      entry.value = jsonToConvex(JSON.parse(result.text))
      entry.error = undefined
      window.__perf.decodeMs += performance.now() - start
    }
    for (const fn of transitionHandlers) fn({ tokens, at: data.at, connection: 1 })
  } else if (data.type === 'answer') {
    const waiting = calls.get(data.id)
    calls.delete(data.id)
    if (data.error) waiting?.reject(new ConvexError(data.error))
    else if (data.failure) waiting?.reject(new Error(data.failure))
    else waiting?.resolve(data.value)
  }
}

export const convex = {
  query(ref, args) {
    return call({ type: 'query', name: getFunctionName(ref), args })
  },
  onUpdate(ref, args, receive, fail) {
    const id = `s${next++}`
    receivers.set(id, { receive, fail })
    server.postMessage({ type: 'subscribe', id, name: getFunctionName(ref), args })
    return () => {
      receivers.delete(id)
      server.postMessage({ type: 'unsubscribe', id })
    }
  },
  mutation(ref, args) {
    return call({ type: 'mutation', name: getFunctionName(ref), args })
  },
}
/* The watched parts by token, each with its id on the server, its latest
   value or error and how many watch it; tokens by id; the handlers. */
const parts = new Map()
const partTokens = new Map()
const transitionHandlers = new Set()
export const live = {
  watch(ref, args) {
    const name = getFunctionName(ref)
    const token = `${name}:${JSON.stringify(args)}`
    let entry = parts.get(token)
    // a watch beside one whose result arrived reads it at once
    // (lib/liveQueries.ts watch)
    const joined = !!entry && (entry.value !== undefined || entry.error !== undefined)
    if (entry) entry.count++
    else {
      entry = { id: `p${next++}`, count: 1, value: undefined, error: undefined }
      parts.set(token, entry)
      partTokens.set(entry.id, token)
      server.postMessage({ type: 'watch', id: entry.id, name, args })
    }
    let stopped = false
    return {
      token,
      joined,
      stop() {
        if (stopped) return
        stopped = true
        if (--entry.count > 0) return
        parts.delete(token)
        partTokens.delete(entry.id)
        server.postMessage({ type: 'unwatch', id: entry.id })
      },
    }
  },
  read(token) {
    const entry = parts.get(token)
    if (entry?.error) throw entry.error
    return entry?.value
  },
  onTransition(fn) {
    transitionHandlers.add(fn)
    return () => transitionHandlers.delete(fn)
  },
  query: (ref, args) => convex.query(ref, args),
}
export const authClient = {
  getSession: async () => ({
    data: {
      session: { id: 'perf-session' },
      user: { id: 'perf-account' },
    },
  }),
}
export const armConvexAuth = async () => true
export const signOut = async () => {}
export const clearLocalSession = () => {}
export const handleOAuthReturn = async () => false

/** Asks the server to run benchmark scenario `name`, resolving once its
    results reached the page. */
const scenario = (name, ...args) => call({ type: 'scenario', name, args })

window.__perf = {
  appRenders: 0,
  // the server's count of answered writes, and of writes held
  writes: 0,
  heldCount: 0,
  // bytes of every result delivered, how many, and the ms spent decoding
  // them (JSON.parse and jsonToConvex)
  wireBytes: 0,
  deliveries: 0,
  decodeMs: 0,
  count: Number(parameters.get('tasks') || 100),
  // the visible tasks the server holds, and how many of them the Board
  // shows as cards (all but the parents); and of the first program, the
  // Board the app opens, its cards and its tasks, the phone list's rows
  made: 0,
  cards: 0,
  boardCards: 0,
  boardRows: 0,
  /* Holds every write from now until release(). */
  hold() {
    server.postMessage({ type: 'hold' })
  },
  /* How many writes are held. */
  held: () => window.__perf.heldCount,
  /* Answers the oldest held write, refused when `refuse`. */
  releaseOne(refuse = false) {
    server.postMessage({ type: 'releaseOne', refuse })
  },
  /* Answers every held write and stops holding. */
  releaseAll() {
    server.postMessage({ type: 'releaseAll' })
  },
  /* Delivers `n` new unread messages for the signed-in person, one per task,
     for the bulk-read scenario. */
  seedMessages: (n) => scenario('seedMessages', n),
  /* Another person renames task `n`, which every listener receives. */
  deliverRemote: (n) => scenario('deliverRemote', n),
  /* Another person creates a task in the first project. */
  deliverCreate: () => scenario('deliverCreate'),
  /* Another person renames the first project. */
  deliverProjectRename: () => scenario('deliverProjectRename'),
  /* One new message for the signed-in person arrives. */
  deliverMessage: () => scenario('deliverMessage'),
  /* A Team sync sitting stamps another person (convex/teamSync.ts stamp). */
  deliverStamp: () => scenario('deliverStamp'),
  /* Another person moves task `n` to `status`, for checks by hand. */
  moveRemote: (n, status) => scenario('moveRemote', n, status),
  /* Another person comments on the open task; resolves with the comment's
     text. */
  deliverComments: () => scenario('deliverComments'),
}
