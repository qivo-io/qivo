/* Small shared pieces for the operator views — table, badges, headings. */
import { type ReactNode, type Ref, useEffect } from 'react'
import { Badge as UiBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useUpdateBlocker } from '@/lib/updateSafety'
import { useConfirmArm } from '@/lib/useConfirmArm'
import { cn } from '@/lib/utils'

/* `headingRef` lets a view move focus to its title when it opens in place
   of something that had focus, such as a dialog that has just closed. The
   title is not a control, so it never shows the keyboard focus ring. */
export function AdminPageHeader({
  title,
  description,
  eyebrow,
  actions,
  headingRef,
}: {
  title: string
  description?: ReactNode
  eyebrow?: ReactNode
  actions?: ReactNode
  headingRef?: Ref<HTMLHeadingElement>
}) {
  return (
    <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-primary">
            {eyebrow}
          </div>
        )}
        <h1
          ref={headingRef}
          tabIndex={headingRef ? -1 : undefined}
          className="text-2xl font-semibold tracking-tight text-text-1 !outline-none"
        >
          {title}
        </h1>
        {description && (
          <p className="mt-2 max-w-2xl text-sm leading-6 text-text-2">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

export function AdminToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-1/70 p-3 shadow-card">
      {children}
    </div>
  )
}

export function AdminStat({
  label,
  value,
  note,
  detail,
}: {
  label: string
  value: ReactNode
  note?: ReactNode
  detail?: ReactNode
}) {
  return (
    <Card className="gap-0 border-border/80 bg-surface-1 p-4 shadow-card transition-colors hover:border-border-strong">
      <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-text-2">{label}</h2>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-text-1 tabular-nums">{value}</p>
      {note && <p className="mt-1 text-xs leading-5 text-text-2">{note}</p>}
      {detail && (
        <div className="mt-3 border-t border-border pt-3 text-xs text-text-2">{detail}</div>
      )}
    </Card>
  )
}

export function AdminEmptyState({
  title,
  description,
  action,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
}) {
  return (
    <Card className="items-center gap-2 border-dashed p-10 text-center shadow-none">
      <h2 className="text-base font-semibold text-text-1">{title}</h2>
      {description && <p className="max-w-md text-sm leading-6 text-text-2">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </Card>
  )
}

export function Badge({
  kind,
  children,
}: {
  kind: 'accent' | 'danger' | 'muted'
  children: ReactNode
}) {
  return (
    <UiBadge
      variant="outline"
      className={cn(
        'h-5 rounded-pill border-0 px-2 py-0 text-xs font-semibold',
        kind === 'accent' && 'bg-primary-soft text-text-1',
        kind === 'danger' && 'bg-danger-soft text-danger',
        kind === 'muted' && 'bg-surface-3 text-text-1',
      )}
    >
      {children}
    </UiBadge>
  )
}

export function ErrorNote({ message }: { message: string }) {
  return <div className="py-2 text-base text-danger">{message}</div>
}

export function Loading() {
  return <div className="py-2 text-base text-text-2">Loading…</div>
}

/* One-shot reveal for a generated recovery link: shown once, copy and done.
   Rendered inline (not a browser dialog) so nothing blocks the session. */
export function LinkReveal({ link, onClose }: { link: string; onClose: () => void }) {
  useUpdateBlocker(true)
  return (
    <div
      data-link-reveal
      className="animate-in fade-in zoom-in-95 my-6 rounded-lg border border-border-strong bg-surface-2 p-5"
    >
      <div className="mb-2 text-md font-semibold">One-time recovery link</div>
      <p className="mb-2 text-sm text-text-2">Copy it now. It won’t be shown again.</p>
      <div className="mb-2 break-all whitespace-normal font-mono text-sm text-text-1">{link}</div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="primary"
          onClick={() => {
            void navigator.clipboard.writeText(link)
          }}
        >
          Copy link
        </Button>
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  )
}

/* Shows `current` at the width of the widest of `labels`, so a button whose
   label swaps keeps its size and the table around it stays put. */
export function StableLabel({ labels, current }: { labels: readonly string[]; current: string }) {
  return (
    <span className="grid place-items-center">
      <span className="col-start-1 row-start-1">{current}</span>
      {labels
        .filter((label) => label !== current)
        .map((label) => (
          <span key={label} className="invisible col-start-1 row-start-1">
            {label}
          </span>
        ))}
    </span>
  )
}

/* A destructive action that takes a second click, the app's settings
   ConfirmButton pattern (src/panels/settings/controls.tsx). That component
   draws its icon through the planner store, so the console keeps this small
   copy. The first click arms the button and swaps in `confirmLabel`. The
   second click confirms only after a short pause, and the arm lapses after
   3.5 seconds (lib/useConfirmArm). `busyLabel` shows while the action runs.
   `blockedReason` turns the action off but keeps the button focusable, so
   the reason in its tooltip reaches the keyboard too. */
export function ConfirmAction({
  label,
  confirmLabel,
  busyLabel,
  busy = false,
  disabled = false,
  blockedReason,
  onConfirm,
}: {
  label: string
  confirmLabel: string
  busyLabel: string
  busy?: boolean
  disabled?: boolean
  blockedReason?: string
  onConfirm: () => void
}) {
  const { armed: armedKey, press, disarm } = useConfirmArm<'confirm'>()
  const armed = armedKey !== null
  const blocked = !!blockedReason
  useEffect(() => {
    if (disabled || busy || blocked) disarm()
  }, [disabled, busy, blocked, disarm])
  return (
    <Button
      type="button"
      size="sm"
      disabled={disabled || busy}
      aria-disabled={blocked || undefined}
      title={blockedReason}
      data-armed={armed ? '' : undefined}
      className={cn(
        'px-2 text-danger aria-disabled:cursor-not-allowed aria-disabled:opacity-55',
        armed && 'border-danger bg-danger-soft hover:bg-danger-soft',
      )}
      onClick={() => {
        if (!blocked) press('confirm', onConfirm)
      }}
    >
      <StableLabel
        labels={[label, confirmLabel, busyLabel]}
        current={busy ? busyLabel : armed ? confirmLabel : label}
      />
    </Button>
  )
}
