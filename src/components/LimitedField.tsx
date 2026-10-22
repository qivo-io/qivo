/* Text fields bounded by a limit of the registry (convex/lib/limits.ts).
   They keep whatever is typed or pasted, never cut it, and count it as the
   server does: UTF-16 code units after trimming, or after `clean` for a text
   the server cleans further. From 90 percent of the cap a counter shows
   "count/max" inside the field's end, and past the cap the field is invalid
   (aria-invalid, the fields' red border) and describes the registry
   sentence to assistive technology. The caller keeps its Save disabled
   while overLimit(limit, value) holds; a field that saves on blur or Enter
   skips the commit then, keeps the text and says why.

   The control sits in a relative wrapper that holds the counter. Layout
   classes for the field's place in its row (flex-1, a width) go on
   `wrapperClassName`; the control's own look stays on `className`. */

import * as React from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { countText, limitSentence, nearLimit } from '@/lib/fieldLimits'
import { cn } from '@/lib/utils'
import type { Limit } from '../../convex/lib/limits'

type Bounded = {
  /** The registry entry the text is bounded by. */
  limit: Limit
  value: string
  /** Classes for the wrapper, such as flex-1 in a row. */
  wrapperClassName?: string
  /** The text the server stores for `value`, which is what counts. Trimming
      by default; person names pass cleanName (lib/fieldLimits.ts). */
  clean?: (value: string) => string
}

const trimmed = (value: string) => value.trim()

/** The count of a controlled value, taken when the value changes only. */
function useLimitCount(
  limit: Limit,
  value: string,
  describedBy: string | undefined,
  clean: (value: string) => string = trimmed,
) {
  const id = React.useId()
  const count = React.useMemo(() => clean(value).length, [clean, value])
  const over = count > limit.max
  const shown = nearLimit(limit, count)
  return {
    count,
    over,
    shown,
    id,
    describedBy: [describedBy, shown && id].filter(Boolean).join(' ') || undefined,
  }
}

/** The counter inside the field's end, with the sentence for screen readers
    when the text is over the cap. */
function Counter({
  id,
  limit,
  count,
  over,
  className,
}: {
  id: string
  limit: Limit
  count: number
  over: boolean
  className: string
}) {
  return (
    <span
      id={id}
      data-limit-count={over ? 'over' : 'near'}
      className={cn(
        'pointer-events-none absolute right-2 font-sans text-xs tabular-nums',
        over ? 'text-danger' : 'text-text-3',
        className,
      )}
    >
      {countText(limit, count)}
      {over && <span className="sr-only"> {limitSentence(limit)}</span>}
    </span>
  )
}

/** The room the counter takes at the field's end, by the width of its
    widest text ("80/80", "255/255", "20,000/20,000"). Important, so it wins
    over the caller's own padding. */
const counterRoom = (limit: Limit) => {
  const chars = countText(limit, limit.max).length
  return chars <= 5 ? '!pr-12' : chars <= 7 ? '!pr-16' : '!pr-24'
}

type LimitedInputProps = Bounded & Omit<React.ComponentProps<typeof Input>, 'value' | 'maxLength'>

/** A one-line Input bounded by `limit` (see the file comment). */
export const LimitedInput = React.forwardRef<HTMLInputElement, LimitedInputProps>(
  function LimitedInput(
    {
      limit,
      value,
      wrapperClassName,
      clean,
      className,
      'aria-invalid': ariaInvalid,
      'aria-describedby': ariaDescribedBy,
      ...props
    },
    ref,
  ) {
    const c = useLimitCount(limit, value, ariaDescribedBy, clean)
    return (
      <div data-limited-field className={cn('relative min-w-0', wrapperClassName)}>
        <Input
          ref={ref}
          {...props}
          value={value}
          aria-invalid={c.over || ariaInvalid || undefined}
          aria-describedby={c.describedBy}
          className={cn(className, c.shown && counterRoom(limit))}
        />
        {c.shown && (
          <Counter
            id={c.id}
            limit={limit}
            count={c.count}
            over={c.over}
            className="top-1/2 -translate-y-1/2"
          />
        )}
      </div>
    )
  },
)

type LimitedTextareaProps = Bounded &
  Omit<React.ComponentProps<typeof Textarea>, 'value' | 'maxLength'>

/** A Textarea bounded by `limit` (see the file comment). The counter sits
    under the last line. */
export const LimitedTextarea = React.forwardRef<HTMLTextAreaElement, LimitedTextareaProps>(
  function LimitedTextarea(
    {
      limit,
      value,
      wrapperClassName,
      clean,
      className,
      'aria-invalid': ariaInvalid,
      'aria-describedby': ariaDescribedBy,
      ...props
    },
    ref,
  ) {
    const c = useLimitCount(limit, value, ariaDescribedBy, clean)
    return (
      <div data-limited-field className={cn('relative min-w-0', wrapperClassName)}>
        <Textarea
          ref={ref}
          {...props}
          value={value}
          aria-invalid={c.over || ariaInvalid || undefined}
          aria-describedby={c.describedBy}
          // important, so it wins over the caller's own padding
          className={cn(className, c.shown && '!pb-6')}
        />
        {c.shown && (
          <Counter id={c.id} limit={limit} count={c.count} over={c.over} className="bottom-1.5" />
        )}
      </div>
    )
  },
)
