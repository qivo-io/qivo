import type { UnsentScope } from './leaveGuard'
import { goTo, refuseMove, returning, returnStepLanded, returnTo, voidReturn } from './pageHistory'

/* A Back or Forward the app refuses because it would close a window that
   holds unsent text (components/DiscardPrompt).

   A popstate cannot be cancelled, so the page returns to the entry the move
   left (lib/pageHistory returnTo), which keeps the entries on both sides,
   and asks only once it is back. Discard then takes the refused move again.
   The refused popstate and the return reach no other popstate listener,
   such as the phone layers' (lib/pageHistory listenBackLayers), and no
   layer is asked about the move (holdLayers), unless a busy one would hold
   the page anyway (busyLayerLeft): then it holds it and nothing asks. With the Navigation API the
   return goes by key and lands whatever the person did meanwhile, and a
   move refused while it is on its way joins it: one question, for the
   latest move. Without the API it goes by position, a move that lands
   first is the move from then on, and the return's step then lands as one
   more move, refused in turn, before the page steps again.

   When the page cannot return, as for a move that left no entry to return
   to, App pushes the address it left back instead (App onPop). */

type Ask = (scopes: UnsentScope[], go: () => void) => unknown

/** The refusal for App's popstate listener. `ask` is closeOrAsk. */
export function createPopRefusal(ask: Ask) {
  // while the return is on its way: the entry the latest refused move
  // reached and the windows it would have closed
  let held: { reached: ReturnType<typeof refuseMove>['to']; scopes: UnsentScope[] } | null = null
  return {
    /** Refuses the current popstate, which would close the windows of
        `scopes`. False when the page cannot return, and the caller then puts
        the address it left back itself. */
    refuse(event: PopStateEvent, scopes: UnsentScope[]): boolean {
      const { from, to } = refuseMove()
      // the step of a return by position that another move overtook: the
      // page returns from where it landed, and the move still refused is the
      // person's latest. A known limit: a move of the person's by the same
      // step cannot be told from it, so Discard then takes the move before.
      const stepped = !!held && returnStepLanded()
      if (held && !returning() && !stepped) held = null
      if (
        (!held || stepped) &&
        !returnTo(from, () => {
          const refused = held
          held = null
          if (refused) ask(refused.scopes, () => goTo(refused.reached))
        })
      )
        return false
      event.stopImmediatePropagation()
      if (!stepped) held = { reached: to, scopes }
      return true
    },
    /** App took a Back or Forward that closes nothing held: a return still
        on its way, a refusal's or a held page's (lib/pageHistory
        holdLayers), then lands heard, as the move it now is. */
    accepted() {
      held = null
      voidReturn()
    },
  }
}
