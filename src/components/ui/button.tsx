import type { VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import * as React from 'react'

import { buttonVariants } from '@/components/ui/button-variants'
import { HoverTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> &
    VariantProps<typeof buttonVariants> & {
      asChild?: boolean
    }
>(function Button(
  { className, variant = 'default', size = 'default', asChild = false, title, ...props },
  ref,
) {
  const Comp = asChild ? Slot.Root : 'button'
  /* The props go first so the Button's own data hooks win: a Radix trigger's
     asChild Slot passes its data-slot (popover-trigger, ...) down, and theme
     rules find every Button by data-slot="button" and data-variant. */
  return (
    <HoverTooltip content={title}>
      <Comp
        {...props}
        ref={ref}
        data-slot="button"
        data-variant={variant}
        data-size={variant === 'unstyled' ? undefined : size}
        className={
          variant === 'unstyled' ? cn(className) : cn(buttonVariants({ variant, size, className }))
        }
      />
    </HoverTooltip>
  )
})

export { Button }
