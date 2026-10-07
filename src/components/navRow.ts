import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/* The rows of the project tree — the sidebar's, and the Settings screen's
   mirror of it (deviation #251). Every row is a quiet control lit by
   `data-on` (deviation #232): the same raised chip as a pressed toolbar toggle
   and the current view tab, so "you are here" reads the same wherever it is
   said. The personal rows are Buttons; a project row is a div, because it
   also carries its "…" menu.
   A project row takes no size variant and drops the quiet variant's
   transparent hairline (deviation #250): the control height is its MINIMUM,
   so a sub-project name that wraps grows the row instead of spilling out of
   it, and the branch lines are drawn edge to edge on each row, where a
   border, even an invisible one, would leave a gap in the line between
   rows. No row in the rail carries hover help. */
export const navRow = 'w-full justify-start gap-2 px-2 text-base'
export const navRowDiv = cn(
  buttonVariants({ variant: 'quiet', size: null }),
  'flex min-h-control border-0',
  navRow,
)
