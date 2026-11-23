import { type ComponentPropsWithoutRef, forwardRef, useImperativeHandle, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { type Ground, groundRadius } from './ground'
import { Icon } from './qivo'

type FilterSearchProps = Omit<
  ComponentPropsWithoutRef<'input'>,
  'value' | 'onChange' | 'width' | 'className'
> & {
  value: string
  onValue: (value: string) => void
  /** its width in px in a row, which it gives up first as the row narrows;
      without one it fills its container */
  width?: number
  ground: Ground
}

/**
 * The search field of a filter row, the Board's, the Roadmap's and All
 * projects': a magnifier, the field the input props describe, and Clear
 * while it holds text. The ref is the field's.
 */
export const FilterSearch = forwardRef<HTMLInputElement, FilterSearchProps>(function FilterSearch(
  { value, onValue, width, ground, ...input },
  ref,
) {
  const field = useRef<HTMLInputElement>(null)
  useImperativeHandle(ref, () => field.current)
  /* The one elastic control in the cluster. Everything beside it is a nowrap
     button that cannot give up a pixel, so when the window is too narrow for the
     row this is what yields — a search box 60px shorter is a smaller loss than a
     bar that overflows its own edge.
     In a well it is drawn like the sidebar's Search: a quiet hairline on no
     fill, that strengthens on hover and while the field has focus — never the
     accent. On a page it keeps the control fill the page's buttons have. */
  return (
    <div
      data-filter-search
      style={width === undefined ? undefined : { flex: `0 1 ${width}px` }}
      className={cn(
        'flex h-control min-w-24 items-center gap-2 border border-border px-2 text-text-3 transition-[border-color,color] hover:border-border-strong hover:text-text-2 focus-within:border-border-strong focus-within:text-text-2',
        ground === 'well' ? 'bg-transparent' : 'bg-surface-1',
        groundRadius(ground),
      )}
    >
      <Icon name="search" size={16} />
      <Input
        ref={field}
        {...input}
        value={value}
        onChange={(e) => onValue(e.target.value)}
        className="h-full min-w-0 flex-1 rounded-none border-none bg-transparent p-0 font-sans text-base text-text-1 shadow-none focus-visible:outline-none focus-visible:ring-0"
      />
      {value && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 bg-transparent hover:bg-transparent hover:border-border-strong"
          title="Clear search"
          aria-label="Clear search"
          onClick={() => {
            // Clear leaves with the text, and focus would go with it
            field.current?.focus()
            onValue('')
          }}
        >
          <Icon name="close" size={12} />
        </Button>
      )}
    </div>
  )
})
