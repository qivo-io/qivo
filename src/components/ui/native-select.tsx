import * as React from 'react'

import { HoverTooltip } from '@/components/ui/tooltip'
import { isSelectInteractionKey } from '@/lib/focusVisibility'
import { cn } from '@/lib/utils'

const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  Omit<React.ComponentProps<'select'>, 'size'> & { size?: 'sm' | 'default' }
>(function NativeSelect(
  { className, size = 'default', title, onChange, onPointerDown, onKeyDown, ...props },
  ref,
) {
  // A pick made with the pointer ends the interaction: the browser keeps a
  // <select> focused (and so lit, see the field rule in tokens.css) after its
  // popup closes, unlike a date box whose calendar closes or a text box you
  // click out of — so let go of focus then. Changing the value from the
  // keyboard (arrows, without the popup) keeps focus, as it must.
  const pointer = React.useRef(false)
  return (
    <HoverTooltip content={title}>
      <select
        ref={ref}
        data-slot="native-select"
        data-size={size}
        className={cn(
          // the active look (focus) is the one field rule in tokens.css
          'min-w-0 rounded-md border border-input bg-transparent text-foreground px-2.5 py-0 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50',
          'h-control',
          'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
          className,
        )}
        onPointerDown={(e) => {
          pointer.current = true
          onPointerDown?.(e)
        }}
        onKeyDown={(e) => {
          // Shift and OS/browser shortcuts don't turn a pointer pick into a
          // keyboard pick. Native typeahead (ordinary letters) still does.
          if (isSelectInteractionKey(e)) pointer.current = false
          onKeyDown?.(e)
        }}
        onChange={(e) => {
          onChange?.(e)
          if (pointer.current) e.currentTarget.blur()
        }}
        {...props}
      />
    </HoverTooltip>
  )
})

function NativeSelectOption({ className, ...props }: React.ComponentProps<'option'>) {
  return (
    <option
      data-slot="native-select-option"
      className={cn('bg-[Canvas] text-[CanvasText]', className)}
      {...props}
    />
  )
}

function NativeSelectOptGroup({ className, ...props }: React.ComponentProps<'optgroup'>) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn('bg-[Canvas] text-[CanvasText]', className)}
      {...props}
    />
  )
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption }
