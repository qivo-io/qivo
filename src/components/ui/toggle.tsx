import type { VariantProps } from 'class-variance-authority'
import { Toggle as TogglePrimitive } from 'radix-ui'
import type * as React from 'react'

import { toggleVariants } from '@/components/ui/toggle-variants'
import { HoverTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

function Toggle({
  className,
  variant,
  size,
  title,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>) {
  return (
    <HoverTooltip content={title}>
      <TogglePrimitive.Root
        data-slot="toggle"
        className={cn(toggleVariants({ variant, size, className }))}
        {...props}
      />
    </HoverTooltip>
  )
}

export { Toggle }
