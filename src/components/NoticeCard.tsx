import { CircleAlert } from 'lucide-react'
import type { ReactNode } from 'react'

/** One warning in the floating column (lib/floatStack): its title and line,
    then `details` under them and `actions` at its end when given. `kind`
    names it in data-snapshot-notice. It draws the app's alert icon itself,
    because the icon set (components/qivo) loads the planner store, which the
    operator console does not run. */
export function NoticeCard({
  kind,
  title,
  line,
  details,
  actions,
}: {
  kind: string
  title: string
  line: string
  details?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div
      data-snapshot-notice={kind}
      data-floating-surface
      // The notice is outside any modal's DOM. A press here must not close
      // the dialog or window that holds the person's draft.
      onPointerDown={(event) => event.stopPropagation()}
      className="pointer-events-auto flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-xl"
    >
      <div className="min-w-0 flex-1 basis-60 text-sm">
        <div className="flex items-center gap-2 font-semibold">
          <CircleAlert
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
            className="block shrink-0 text-[var(--warn)]"
          />
          {title}
        </div>
        <div className="mt-1 text-muted-foreground">{line}</div>
        {details}
      </div>
      {actions && (
        <div
          className="ml-auto flex items-center gap-2"
          // A focused button outside an open dialog makes the dialog take
          // focus back and select its field's text, which the next key
          // would replace. The Details text stays selectable.
          onMouseDown={(event) => event.preventDefault()}
        >
          {actions}
        </div>
      )}
    </div>
  )
}
