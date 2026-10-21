import { lastStep, position } from './historyIndex'
import type { UnsentScope } from './leaveGuard'

/* A Back or Forward the app refuses because it would close a window that
   holds unsent text (components/DiscardPrompt).

   A popstate cannot be cancelled, so the page steps back over the same
   distance with history.go, which keeps the entries on both sides, and asks
   only once it is back where it was. Discard then takes the step again. The
   refused popstate and the step back reach no other popstate listener, such
   as a phone layer's (lib/useMobile), and nothing may write history while
   the page steps back (`stepping`), or the step back would land elsewhere. */

type Ask = (scopes: UnsentScope[], go: () => void) => unknown

/** The refusal for one popstate listener, the first after the history
    index's own (lib/historyIndex). `ask` is closeOrAsk. */
export function createPopRefusal(ask: Ask, h: History = history) {
  // the entry the page steps back to, the entry the refused move reached,
  // and the windows it would have closed
  let back: { to: number; reached: number; scopes: UnsentScope[] } | null = null
  return {
    /** Whether the page is stepping back over a refused Back or Forward. */
    stepping: () => back !== null,
    /** Call first for each popstate. True for the step back's own
        popstate, which this ends by asking; the caller then does nothing
        else. */
    landed(event: PopStateEvent): boolean {
      if (!back || position() !== back.to) return false
      event.stopImmediatePropagation()
      const { reached, scopes } = back
      back = null
      ask(scopes, () => h.go(reached - position()))
      return true
    },
    /** Refuses the current popstate, which would close the windows of
        `scopes`. False when its entry has no position, and the caller has
        to put the address it left back itself. */
    refuse(event: PopStateEvent, scopes: UnsentScope[]): boolean {
      const step = lastStep()
      if (!step) return false
      event.stopImmediatePropagation()
      back = { to: position() - step, reached: position(), scopes }
      h.go(-step)
      return true
    },
  }
}
