import { getFunctionName } from 'convex/server'
import { convex } from '../lib/convex'
import { pauseSentence } from '../lib/noticeText'
import { syncStatus } from '../lib/syncStatus'

/* The operator console's writes. Convex keeps a call it cannot send and
   sends it once the socket is back, however long that takes, so the console
   pauses its changes the way the app does (lib/syncStatus): while Qivo
   cannot save, a mutation or an action is refused before it is sent, with
   the app's sentence, and the view shows it in place of the result. The
   console's views call Convex for changes only through sendMutation() and
   runAction() below (convex.test.ts checks), and reads through convex.query
   and the actions in READ_ACTIONS.

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
])

/** What Convex rejects an action with when the socket dropped before its
    answer came. */
const LOST_ACTION = 'Connection lost while action was in flight'

/** The sentence a change that was sent but lost its answer shows. */
export const LOST_TEXT =
  'The connection dropped before Qivo heard back, so this may or may not have happened. Check before you try again.'

/** The refusal of a change now, or null when it may go out. An action also
    needs the socket connected, so it is never queued. */
function refusal(kind: 'mutation' | 'action'): Error | null {
  const pause = syncStatus.pause()
  if (pause) return new Error(pauseSentence(pause.kind))
  if (kind === 'action' && !convex.connectionState().isWebSocketConnected)
    return new Error(pauseSentence('offline'))
  return null
}

/** Sends a console mutation, or refuses it while Qivo cannot save. It
    counts as waiting until the server answers. */
export const sendMutation: typeof convex.mutation = (ref, args, options) => {
  const refused = refusal('mutation')
  if (refused) return Promise.reject(refused)
  const settle = syncStatus.track(true)
  const sent = convex.mutation(ref, args, options)
  sent.then(settle, settle)
  return sent
}

/** Runs a console action. One that changes something is refused while Qivo
    cannot save or the socket is down, and one whose answer the dropped
    socket lost says so. */
export const runAction: typeof convex.action = (ref, ...args) => {
  if (READ_ACTIONS.has(getFunctionName(ref))) return convex.action(ref, ...args)
  const refused = refusal('action')
  if (refused) return Promise.reject(refused)
  const settle = syncStatus.track(false)
  const sent = convex.action(ref, ...args)
  sent.then(settle, settle)
  return sent.catch((error: unknown) => {
    throw error instanceof Error && error.message.includes(LOST_ACTION)
      ? new Error(LOST_TEXT)
      : error
  })
}
