import { getFunctionName } from 'convex/server'
import { convex } from '../lib/convex'
import { pauseSentence } from '../lib/noticeText'
import { OFFLINE_DELAY_MS, syncStatus } from '../lib/syncStatus'

/* The operator console's writes. Convex keeps a call it cannot send and
   sends it once the socket is back, however long that takes, so the console
   pauses its changes the way the app does (lib/syncStatus): while Qivo
   cannot save, a mutation or an action is refused before it is sent, with
   the app's sentence, and the view shows it in place of the result. The
   console's views call Convex for changes only through sendMutation() and
   runAction() below (convex.test.ts checks), and reads through convex.query
   and the actions in READ_ACTIONS. A change that reads before it writes
   starts with beginChange().

   A mutation sent before a pause counts as waiting in the notice, because
   Convex sends it again after a reconnect. An action is not sent again: one
   that is waiting when the socket drops fails once it is back, and the view
   says the change may or may not have happened. So an action only goes out
   on a connected socket, never into Convex's queue, and it does not count as
   waiting. While it runs it still holds the pause's clock, so one that takes
   longer than SLOW_SAVE_MS pauses the other changes, as a slow mutation
   does. */

/** The actions that only read. Every other action changes something. */
const READ_ACTIONS = new Set([
  'adminStats:listOrgs',
  'adminStats:orgNames',
  'adminStats:platformStats',
  'adminPeople:userPage',
  'adminPeople:orgDetail',
  'usage:monthTable',
  'usage:orgMonths',
  'usage:orgPeople',
])

/** What Convex rejects an action with when the socket dropped before its
    answer came. */
const LOST_ACTION = 'Connection lost while action was in flight'

/** The sentence a change that was sent but lost its answer shows. */
export const LOST_TEXT =
  'The connection dropped before Qivo heard back, so this may or may not have happened. Check before you try again.'

/** The sentence a change shows when the connection dropped while Qivo
    checked it, before anything was sent. */
export const DROPPED_TEXT =
  'The connection dropped while Qivo checked this, so nothing was changed. Try again.'

/** The refusal of every change while Qivo cannot save, or null. */
function pauseRefusal(): Error | null {
  const pause = syncStatus.pause()
  return pause ? new Error(pauseSentence(pause.kind)) : null
}

/** Resolves once the socket is connected again within OFFLINE_DELAY_MS, the
    blip the pause itself waits out, or rejects with the pause's sentence. */
function reconnected(): Promise<void> {
  return new Promise((resolve, reject) => {
    let stop = () => {}
    const timer = setTimeout(() => {
      stop()
      reject(pauseRefusal() ?? new Error(pauseSentence('offline')))
    }, OFFLINE_DELAY_MS)
    stop = convex.subscribeToConnectionState((state) => {
      if (!state.isWebSocketConnected) return
      clearTimeout(timer)
      stop()
      const refused = pauseRefusal()
      if (refused) reject(refused)
      else resolve()
    })
  })
}

/** Sends a console mutation, or refuses it while Qivo cannot save. It
    counts as waiting until the server answers. */
export const sendMutation: typeof convex.mutation = (ref, args, options) => {
  const refused = pauseRefusal()
  if (refused) return Promise.reject(refused)
  const settle = syncStatus.track(true)
  const sent = convex.mutation(ref, args, options)
  sent.then(settle, settle)
  return sent
}

/** Runs a console action. One that changes something is refused while Qivo
    cannot save, waits out a short drop of the socket, and says so when the
    dropped socket lost its answer. */
export const runAction: typeof convex.action = (ref, ...args) => {
  if (READ_ACTIONS.has(getFunctionName(ref))) return convex.action(ref, ...args)
  const send = () => {
    const settle = syncStatus.track(false)
    const sent = convex.action(ref, ...args)
    sent.then(settle, settle)
    return sent.catch((error: unknown) => {
      throw error instanceof Error && error.message.includes(LOST_ACTION)
        ? new Error(LOST_TEXT)
        : error
    })
  }
  const refused = pauseRefusal()
  if (refused) return Promise.reject(refused)
  return convex.connectionState().isWebSocketConnected ? send() : reconnected().then(send)
}

/** Starts a change that reads before it writes, such as creating an
    organization once its address is checked. It throws the pause's sentence
    while Qivo cannot save or the socket is down. The function it answers
    throws once the socket has dropped since, so a change pressed before a
    drop never goes ahead on its own when the connection is back. */
export function beginChange(): () => void {
  const refused = pauseRefusal()
  if (refused) throw refused
  const start = convex.connectionState()
  if (!start.isWebSocketConnected) throw new Error(pauseSentence('offline'))
  return () => {
    const now = convex.connectionState()
    if (!now.isWebSocketConnected || now.connectionCount !== start.connectionCount)
      throw new Error(DROPPED_TEXT)
  }
}
