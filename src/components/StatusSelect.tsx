/* A task's status control on a row, as Team sync's cards and My view's
   Overview show it: the five statuses and Pause or Resume, each written
   through the store (P.updateIssue), which paints the change at once,
   refuses what the person may not do and says why. */
import { cn } from '@/lib/utils'
import { type IssueVM, P } from '@/store/planner'
import { FieldSelect, Icon, StatusDot } from './qivo'

export function StatusSelect({
  it,
  disabled,
  busy = false,
  title,
  labelled = false,
  className,
  onStatus,
  onSaved,
}: {
  it: IssueVM
  disabled: boolean
  /** a change of the task is on its way: a pick writes nothing, and the
      control stays enabled so focus can return to it */
  busy?: boolean
  /** why the control is off, or what it says while on */
  title?: string
  /** whether the closed control names the status beside its glyph */
  labelled?: boolean
  className?: string
  /** a status was picked, before it is saved */
  onStatus?: (status: string) => void
  /** whether the server saved the change, once it answered */
  onSaved?: (saved: boolean) => void
}) {
  return (
    <FieldSelect
      aria-label={`Status of ${it.title}`}
      value={it.status}
      menuWidth={180}
      backLayer
      disabled={disabled}
      title={title}
      className={cn(!labelled && '[&_[data-slot=select-value]>.truncate]:hidden', className)}
      options={P.STATUSES.map((s) => ({
        value: s.id,
        label: s.name,
        icon: <StatusDot status={s.id} />,
      }))}
      onChange={(v) => {
        if (busy) return
        onStatus?.(v)
        void P.updateIssue(it.id, { status: v }).then((saved) => onSaved?.(saved))
      }}
      action={{
        label: it.paused ? 'Resume' : 'Pause',
        icon: (
          <Icon
            name={it.paused ? 'play' : 'pause'}
            size={14}
            color={it.paused ? 'var(--success)' : 'var(--text-2)'}
          />
        ),
        onSelect: () => {
          if (busy) return
          onStatus?.(it.paused ? 'resume' : 'pause')
          void P.updateIssue(it.id, { paused: !it.paused }).then((saved) => onSaved?.(saved))
        },
      }}
    />
  )
}
