import * as React from 'react'

import { HoverTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(function Input(
  { className, type, title, ...props },
  ref,
) {
  return (
    <HoverTooltip content={title}>
      <input
        ref={ref}
        type={type}
        data-slot="input"
        className={cn(
          // the active look (focus / open) is the one field rule in tokens.css
          'h-control w-full min-w-0 rounded-md border border-input bg-transparent text-foreground px-2.5 py-0 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:mr-2 file:inline-flex file:h-full file:items-center file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
          (type === 'checkbox' || type === 'radio') &&
            'size-4 min-w-4 shrink-0 accent-primary shadow-none focus-visible:ring-2',
          type === 'range' && 'h-4 min-w-16 cursor-pointer border-0 bg-transparent p-0 shadow-none',
          // no native spin arrows anywhere; each use sets a width that shows three digits
          type === 'number' &&
            '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
          className,
        )}
        {...props}
      />
    </HoverTooltip>
  )
})

export { Input }
