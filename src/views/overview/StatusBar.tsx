/* The Overview's stacked status bar: the leaves of a scope or a health row
   by status, one segment each, as the Status distribution and the health
   table's sparkbars draw them. */

import { HoverTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { P } from '../../store/planner'

/* stacked status-distribution bar; a segment paints the palette's
   --status-fill-<status> where one is set, else the status ink */
const statusBarSizeClasses = {
  6: 'h-[6px] rounded-[6px]',
  7: 'h-[7px] rounded-[7px]',
  8: 'h-[8px] rounded-[8px]',
} as const

/** The stacked status bar of `counts`, the leaves by status, empty while
    they are not given (null). */
export function OvStatusBar({
  counts,
  height = 7,
}: {
  counts: Record<string, number> | null
  height?: keyof typeof statusBarSizeClasses
}) {
  const total = counts ? Object.values(counts).reduce((sum, n) => sum + n, 0) : 0
  if (!counts || !total) return <div className={cn('bg-surface-3', statusBarSizeClasses[height])} />
  return (
    <div className={cn('flex overflow-hidden bg-surface-3', statusBarSizeClasses[height])}>
      {P.STATUSES.map((s) => {
        const n = counts[s.id]
        return n ? (
          <HoverTooltip key={s.id} content={`${s.name}, ${n}`}>
            <div
              style={{
                width: `${(n / total) * 100}%`,
                background: `var(--status-fill-${s.id}, ${s.tone})`,
              }}
            />
          </HoverTooltip>
        ) : null
      })}
    </div>
  )
}
