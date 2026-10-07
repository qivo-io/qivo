import * as React from 'react'

import { HoverTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  function Textarea({ className, title, ...props }, ref) {
    return (
      <HoverTooltip content={title}>
        <textarea
          ref={ref}
          data-slot="textarea"
          className={cn(
            // the active look (focus) is the one field rule in tokens.css
            'flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent text-foreground px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:ring-destructive/40',
            className,
          )}
          {...props}
        />
      </HoverTooltip>
    )
  },
)

export { Textarea }
