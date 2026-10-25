import type { UnsentScope } from './leaveGuard'
import {
  canReturn,
  currentKey,
  goToKey,
  lastFromKey,
  returning,
  returnTo,
  voidReturn,
} from './pageHistory'

/* A Back or Forward the app refuses because it would close a window that
   holds unsent text (components/DiscardPrompt).

   A popstate cannot be cancelled, so the page returns to the entry the move
   left by its key (lib/pageHistory returnTo), which keeps the entries on
   both sides and lands there whatever the person did meanwhile, and asks
   only once it is back. Discard then takes the refused move again. The
   refused popstate and the return reach no other popstate listener, such as
   the phone layers' (lib/pageHistory listenBackLayers). A move refused while
   the return is on its way joins it: one question, for the latest move.

   Without the Navigation API there is no key to return to, and the app
   pushes the address it left back instead (App onPop). */

type Ask = (scopes: UnsentScope[], go: () => void) => unknown

/** The refusal for App's popstate listener. `ask` is closeOrAsk. */
export function createPopRefusal(ask: Ask) {
  // while the return is on its way: the entry the latest refused move
  // reached and the windows it would have closed
  let held: { reached: string; scopes: UnsentScope[] } | null = null
  return {
    /** Whether the page is returning from a refused Back or Forward. */
    stepping: returning,
    /** Refuses the current popstate, which would close the windows of
        `scopes`. False without the Navigation API, and the caller then puts
        the address it left back itself. */
    refuse(event: PopStateEvent, scopes: UnsentScope[]): boolean {
      const shown = lastFromKey()
      const reached = currentKey()
      if (!canReturn() || !shown || !reached) return false
      event.stopImmediatePropagation()
      const first = !held
      held = { reached, scopes }
      if (first)
        returnTo(shown, () => {
          const refused = held
          held = null
          if (refused) ask(refused.scopes, () => goToKey(refused.reached))
        })
      return true
    },
    /** App took a Back or Forward that closes nothing held: a return still
        on its way then lands heard, as the move it now is. */
    accepted() {
      if (!held) return
      held = null
      voidReturn()
    },
  }
}
