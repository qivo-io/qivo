/* The app's delay verdicts, on its week grid where the current week is
   TODAY_WEEK. The rules live in convex/lib/delay.ts, which the REST and MCP
   task reads share. The store decides whether the project displays delay. */

import {
  type DelayInfo,
  type DelayIssue,
  type DelayStatus,
  computeDelayMap as delayMapOn,
  delayOf as delayOn,
} from '../../convex/lib/delay'
import { TODAY_WEEK } from './dates'
import type { LoadSpan } from './workload'

export type { DelayInfo, DelayIssue, DelayStatus }

/** Delay status for one issue given its owner's org-wide load. */
export const delayOf = (it: DelayIssue, load: LoadSpan[]): DelayInfo | null =>
  delayOn(it, load, TODAY_WEEK)

/** Task delays share each effective owner's organization-wide load index. */
export const computeDelayMap = (
  issues: DelayIssue[],
  loadByOwner: Map<string, LoadSpan[]>,
): Map<string, DelayInfo> => delayMapOn(issues, loadByOwner, TODAY_WEEK)

/* Presentation constants — token references, not hex: surfaces that need a
   translucent fill derive it with color-mix(), which works on a var() the way
   suffixing alpha only worked on a literal.
   `ok` is deliberately null. On track is the ordinary state, and the ordinary
   state is drawn as nothing — only pressure earns a colour. */
export const DELAY_COLORS: Record<DelayStatus, string | null> = {
  ok: null,
  behind: 'var(--pressure-warn)',
  late: 'var(--pressure-over)',
}
export const DELAY_NEUTRAL = null // done / no status, when the project tracks delay: also drawn as nothing
export const DELAY_LABELS: Record<DelayStatus, string> = {
  ok: 'On track',
  behind: 'Currently delayed',
  late: 'Delayed',
}
/* The task window's mark for the two pressure states: an `Icon` name and the
   glyph's colour (the words beside it stay plain — coloured text reads poorly
   on the dark surfaces). `ok` has no entry — on track is drawn as nothing, the
   same rule DELAY_COLORS states above. */
export const DELAY_MARK: Record<Exclude<DelayStatus, 'ok'>, { glyph: string; color: string }> = {
  behind: { glyph: 'clockFading', color: 'var(--pressure-warn)' },
  late: { glyph: 'warning', color: 'var(--pressure-over)' },
}
