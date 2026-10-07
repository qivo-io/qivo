import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import * as React from 'react'

import { HoverTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/* `data-on` is the one lit state for every control that reports "on" or
   "current" (deviation #232): a raised --lit chip (a step above --surface-3
   in every planner palette) with the card shadow and semibold text, and no
   hairline of its own — a variant's rest border, if it has one, is all the
   chip wears. It works on any variant, so a quiet toolbar toggle, a bordered
   phone filter button and a sidebar row all light the same way. The `quiet`
   variant is a control that sits inside a panel or well: nothing at rest, a
   fill on hover, never a border. No variant underlines on hover (deviation
   #237): a control answers the pointer with a fill or a stronger border, so
   shadcn's `link` variant is not offered. */
const litClasses =
  'data-[on]:bg-lit data-[on]:font-semibold data-[on]:text-text-1 data-[on]:shadow-card data-[on]:hover:bg-lit'

const buttonVariants = cva(
  `inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border text-sm font-medium transition-[background-color,border-color,color,opacity] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-55 aria-invalid:border-destructive aria-invalid:ring-destructive/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 ${litClasses}`,
  {
    variants: {
      variant: {
        default: 'border-border bg-surface-1 text-text-1 hover:border-border-strong hover:bg-hover',
        quiet: 'border-transparent bg-transparent text-text-2 hover:bg-hover hover:text-text-1',
        primary:
          'border-primary bg-primary text-primary-foreground hover:border-primary/90 hover:bg-primary/90',
        destructive:
          'border-destructive bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/30',
        outline:
          'border-border bg-background text-text-1 hover:border-border-strong hover:bg-hover',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'border-transparent bg-transparent text-text-1 hover:bg-hover',
        provider:
          'h-control-lg border-border bg-surface-1 text-base text-text-1 hover:border-border-strong hover:bg-hover disabled:cursor-progress disabled:bg-surface-1 disabled:text-text-2 disabled:opacity-100',
        unstyled:
          'h-auto rounded-none border-0 bg-transparent p-0 text-inherit shadow-none hover:bg-transparent hover:text-inherit',
      },
      size: {
        default: 'h-control px-2.5 has-[>svg]:px-2.5',
        xs: 'h-control-xs px-2.5 text-sm',
        sm: 'h-control-sm px-2.5',
        lg: 'h-control-lg px-4 has-[>svg]:px-3',
        icon: 'size-control p-0',
        'icon-xs': 'size-control-xs p-0',
        'icon-sm': 'size-control-sm p-0',
        'icon-lg': 'size-control-lg p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

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

export { Button, buttonVariants }
