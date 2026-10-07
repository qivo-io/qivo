import { cva, type VariantProps } from 'class-variance-authority'
import { Toggle as TogglePrimitive } from 'radix-ui'
import type * as React from 'react'

import { HoverTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/* A pressed toggle lights exactly like a Button with `data-on` (deviation
   #232): raised --lit fill, card shadow, semibold, no hairline. Every variant
   carries a transparent border so the lit state never moves the label. `quiet`
   sits inside a well or panel and hovers as a fill; `outline` stands alone,
   bordered, and hovers like any bordered button. */
const toggleVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md border border-transparent text-sm font-medium whitespace-nowrap transition-[background-color,border-color,color,box-shadow] outline-none hover:bg-hover hover:text-text-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-55 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[state=on]:bg-lit data-[state=on]:font-semibold data-[state=on]:text-text-1 data-[state=on]:shadow-card data-[state=on]:hover:bg-lit dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        quiet: 'bg-transparent text-text-2',
        outline: 'border-border bg-transparent text-text-1 hover:border-border-strong',
      },
      size: {
        default: 'h-control min-w-control px-2.5',
        sm: 'h-control min-w-control px-2.5',
        lg: 'h-control min-w-control px-2.5',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

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

export { Toggle, toggleVariants }
