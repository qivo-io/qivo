import type { VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import * as React from 'react'

import { buttonHooks, type buttonVariants } from '@/components/ui/button-variants'
import { HoverTooltip } from '@/components/ui/tooltip'

const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> &
    VariantProps<typeof buttonVariants> & {
      asChild?: boolean
      /** For a Button that never has a `title`: it renders without the
          tooltip's Radix root, with the same DOM. Lists of many rows use it,
          and a row that goes live keeps its button node. */
      noTooltip?: boolean
    }
>(function Button(
  {
    className,
    variant = 'default',
    size = 'default',
    asChild = false,
    noTooltip = false,
    title,
    ...props
  },
  ref,
) {
  const Comp = asChild ? Slot.Root : 'button'
  if (import.meta.env.DEV && noTooltip && title)
    console.warn('A Button with noTooltip drops its title', title)
  /* The props go first so the Button's own data hooks win: a Radix trigger's
     asChild Slot passes its data-slot (popover-trigger, ...) down, and theme
     rules find every Button by data-slot="button" and data-variant. */
  const button = <Comp {...props} ref={ref} {...buttonHooks(variant, size, className)} />
  return noTooltip ? button : <HoverTooltip content={title}>{button}</HoverTooltip>
})

export { Button }
