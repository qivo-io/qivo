import { Progress as ProgressPrimitive } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/** A bar that shows how far something has got. With `value` null it shows
    no share: Radix marks it indeterminate (data-state) and a segment moves
    along it, which stands still under prefers-reduced-motion
    (styles/tokens.css). */
function Progress({
  className,
  value,
  indicatorClassName,
  indicatorStyle,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & {
  indicatorClassName?: string
  indicatorStyle?: React.CSSProperties
}) {
  const indeterminate = value === null
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-primary/20', className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          indeterminate
            ? 'progress-indeterminate h-full bg-primary'
            : 'h-full w-full flex-1 bg-primary transition-all',
          indicatorClassName,
        )}
        style={
          indeterminate
            ? indicatorStyle
            : { transform: `translateX(-${100 - (value || 0)}%)`, ...indicatorStyle }
        }
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
