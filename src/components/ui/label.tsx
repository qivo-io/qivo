import { Label as LabelPrimitive } from 'radix-ui'
import type * as React from 'react'

import { HoverTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

function Label({ className, title, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <HoverTooltip content={title}>
      <LabelPrimitive.Root
        data-slot="label"
        className={cn(
          'flex items-center gap-2 text-foreground text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
          className,
        )}
        {...props}
      />
    </HoverTooltip>
  )
}

export { Label }
