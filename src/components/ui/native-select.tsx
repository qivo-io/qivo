import * as React from 'react'

import { HoverTooltip } from '@/components/ui/tooltip'
import { isSelectInteractionKey } from '@/lib/focusVisibility'
import { cn } from '@/lib/utils'

const customizable = typeof CSS !== 'undefined' && CSS.supports('appearance', 'base-select')
const labelKeys = new WeakMap<HTMLSelectElement, string>()

/* Where the select is customizable (tokens.css), give its closed field a label
   the page can style. The browser's own label cannot be clipped, so a long
   value would wrap onto a second line; this one ends in an ellipsis, as
   FieldSelect's does. Hidden copies of every option's text share its grid
   cell, so the field stays as wide as its widest option, as a classic select
   is, instead of resizing with each pick. It is built in the DOM rather than
   in JSX: React's types have no <selectedcontent> yet, and the copies need
   each option's rendered label, which select.options gives whatever shape the
   children take. React only inserts and removes its own options around it.
   The button is
   out of the Tab order. The select takes focus, and a focus trap that counted
   the button as its last stop would no longer wrap. */
function syncSelectLabel(select: HTMLSelectElement) {
  let button = select.querySelector<HTMLButtonElement>(':scope > button[data-select-label]')
  if (!button) {
    button = document.createElement('button')
    button.type = 'button'
    button.tabIndex = -1
    button.dataset.selectLabel = ''
    select.prepend(button)
  }
  const labels = Array.from(select.options, (option) => option.label)
  const key = labels.join('\n')
  if (labelKeys.get(select) === key) return
  labelKeys.set(select, key)
  // A new <selectedcontent> copies the chosen option afresh. The browser only
  // copies on a pick, so the old one would keep a renamed option's old text.
  const value = document.createElement('selectedcontent')
  value.dataset.selectValue = ''
  const sizers = labels.map((label) => {
    const sizer = document.createElement('span')
    sizer.dataset.selectSizer = ''
    sizer.setAttribute('aria-hidden', 'true')
    sizer.textContent = label
    return sizer
  })
  button.replaceChildren(value, ...sizers)
}

const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  Omit<React.ComponentProps<'select'>, 'size'> & { size?: 'sm' | 'default' }
>(function NativeSelect(
  { className, size = 'default', title, onChange, onPointerDown, onKeyDown, ...props },
  ref,
) {
  // A pick made with the pointer ends the interaction: the browser keeps a
  // <select> focused (and so lit, see the field rule in tokens.css) after its
  // list closes, unlike a date box whose calendar closes or a text box you
  // click out of, so let go of focus then. Changing the value from the
  // keyboard keeps focus, as it must.
  const pointer = React.useRef(false)
  const select = React.useRef<HTMLSelectElement | null>(null)
  React.useImperativeHandle(ref, () => select.current as HTMLSelectElement)
  // Runs every render, because the options arrive as children and may change.
  React.useLayoutEffect(() => {
    if (customizable && select.current) syncSelectLabel(select.current)
  })
  return (
    <HoverTooltip content={title}>
      <select
        ref={select}
        data-slot="native-select"
        data-size={size}
        className={cn(
          // The active look (focus, open list) is the one field rule in
          // tokens.css. The padding, chevron and open list are the dropdown
          // face there too (deviation #326). A call site sets width, fill and
          // type size, never horizontal padding.
          'min-w-0 rounded-md border border-input bg-transparent text-foreground py-0 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50',
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
          if (!pointer.current) return
          const select = e.currentTarget
          select.blur()
          // A customizable select (tokens.css) hands focus back to itself as
          // its list closes, after this event. Let go again once it has.
          requestAnimationFrame(() => {
            if (document.activeElement === select) select.blur()
          })
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
