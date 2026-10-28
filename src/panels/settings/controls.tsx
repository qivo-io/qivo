/* Shared settings navigation, fields and toggles. */
import type React from 'react'
import { Button } from '@/components/ui/button'
import { limitSentence, overLimit } from '@/lib/fieldLimits'
import { cn } from '@/lib/utils'
import type { Limit } from '../../../convex/lib/limits'
import { LimitedInput, LimitedTextarea } from '../../components/LimitedField'
import { Icon } from '../../components/qivo'
import { SettingsField } from '../../components/settingsPage'
import { WORKSPACE_SIGNUP_URL } from '../../lib/demoMode'
import { type DraftSave, type SavedDraft, TRIMMED, useSavedDraft } from '../../lib/savedDraft'
import { P } from '../../store/planner'

/* ---------- shared page atoms ---------- */
export function DemoCapabilityNotice({ children }: { children: React.ReactNode }) {
  return (
    <p className="my-3 max-w-lg text-sm text-muted-foreground">
      {children}{' '}
      <a href={WORKSPACE_SIGNUP_URL} className="underline underline-offset-4">
        Create a workspace
      </a>{' '}
      to use this feature.
    </p>
  )
}

// Keep the parent link above titles so long names cannot push it aside.
export function BackLink({ onClick, to }: { onClick: () => void; to: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      title={`Back to ${to}`}
      aria-label={`Back to ${to}`}
      className="settings-parent-back [margin-left:-10px] [margin-bottom:8px] h-control-sm [color:var(--text-1)]"
    >
      <Icon name="chevronLeft" size={16} />
      Back
      <span className="settings-mobile-only">to {to}</span>
    </Button>
  )
}

/** The longest saved value a conflict line quotes whole. */
const QUOTED_MAX = 80

/** Under a field with a draft: the saved value that changed elsewhere while
    the person typed, who changed it when a refused save said so, and the
    two ways out, Use saved and Keep mine. `text` writes a saved value as
    the field shows it. The line is a polite live region, there while the
    field is, so screen readers hear a conflict as it comes; the field's
    input names it with aria-describedby (SavedDraft.conflictId). Either
    choice puts focus back in that input, so Enter saves after Keep mine.
    `compact` is for a field in a roster row: the sentence over the
    buttons, both wrapping in the room the row gives them, and `end` puts
    them under the right edge of a field that sits there. */
export function DraftConflictLine<T>({
  draft,
  text,
  compact = false,
  end = false,
}: {
  draft: SavedDraft<T>
  text: (value: T) => string
  compact?: boolean
  end?: boolean
}) {
  const conflict = draft.conflict
  let sentence = ''
  if (conflict) {
    const full = text(conflict.value).trim()
    const value = full.length > QUOTED_MAX ? `${full.slice(0, QUOTED_MAX).trimEnd()}…` : full
    const by = conflict.by
    sentence = !value
      ? by === 'you'
        ? 'You cleared it elsewhere.'
        : by
          ? `${by.name} cleared it.`
          : 'Cleared elsewhere.'
      : by === 'you'
        ? `You changed it elsewhere to “${value}”.`
        : by
          ? `${by.name} changed it to “${value}”.`
          : `Changed elsewhere to “${value}”.`
  }
  // the input this line describes, found before the choice renders it gone
  const choose = (choice: () => void) => () => {
    const input = [...document.querySelectorAll<HTMLElement>('[aria-describedby]')].find((el) =>
      el.getAttribute('aria-describedby')?.split(' ').includes(draft.conflictId),
    )
    choice()
    input?.focus()
  }
  return (
    <div
      id={draft.conflictId}
      aria-live="polite"
      data-draft-conflict={conflict ? '' : undefined}
      className={cn(
        conflict && 'flex gap-x-2 gap-y-1 [color:var(--danger)] [line-height:1.5]',
        conflict &&
          (compact
            ? cn('mt-1 flex-col text-xs', end ? 'items-end text-right' : 'items-start')
            : 'mt-2 flex-wrap items-center [font-size:var(--fs-sm)]'),
      )}
    >
      {conflict && (
        <>
          <span className="min-w-0 break-words">{sentence}</span>
          <span className={cn('flex gap-1.5', compact ? 'flex-wrap' : 'shrink-0')}>
            <Button type="button" size="xs" data-draft-use-saved onClick={choose(draft.discard)}>
              Use saved
            </Button>
            <Button type="button" size="xs" data-draft-keep-mine onClick={choose(draft.keepMine)}>
              Keep mine
            </Button>
          </span>
        </>
      )}
    </div>
  )
}

/** A settings text that saves on blur, and a single-line one also on Enter.
    It keeps what the person types as a draft of `record`'s field `label`
    against the value it began from (lib/savedDraft.ts), and `onCommit`
    passes `save` to the store, so the server refuses the save when someone
    else changed the value first. A value changed elsewhere while the person
    types shows under the field, which then saves nothing until they choose
    Use saved or Keep mine. A text over `limit` is not saved: the field
    keeps it, shows it invalid and says why. Leaving the stored text
    unchanged says nothing. A save while editing is paused keeps the text. */
export function TextField({
  label,
  record,
  value,
  onCommit,
  placeholder,
  hint,
  width,
  probe,
  multiline = false,
  limit,
  disabled = false,
}: {
  label: string
  /** The record the text belongs to, such as the organization's id. */
  record: string
  value: string
  onCommit: (v: string, save: DraftSave<string>) => void
  placeholder?: string
  hint?: React.ReactNode
  width?: number
  probe?: string
  multiline?: boolean
  limit: Limit
  disabled?: boolean
}) {
  const draft = useSavedDraft(`${record}:${label}`, value, TRIMMED, 'text', disabled)
  const commit = () => {
    const t = draft.text.trim()
    if (disabled || draft.isSaved(t)) draft.showSaved()
    // a conflict waits for Use saved or Keep mine
    else if (draft.conflict) return
    else if (overLimit(limit, t)) window.showToast?.(limitSentence(limit), 'error')
    else if (!t && !multiline) draft.showSaved()
    else if (!P.refusePausedEdit()) onCommit(t, draft.save(t))
  }
  const Control = multiline ? LimitedTextarea : LimitedInput
  return (
    <SettingsField label={label} hint={hint} width={width}>
      <Control
        aria-label={label}
        aria-describedby={draft.conflict ? draft.conflictId : undefined}
        limit={limit}
        value={draft.text}
        rows={multiline ? 1 : undefined}
        disabled={disabled}
        onChange={(e) => draft.edit(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !multiline) {
            e.preventDefault()
            e.currentTarget.blur()
          }
          if (multiline && e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            draft.discard()
          }
        }}
        {...(probe ? { [probe]: '' } : {})}
        placeholder={placeholder}
        className={
          multiline
            ? 'min-h-control w-full resize-none overflow-y-auto bg-surface-1 px-2.5 py-1 text-base font-sans md:text-base'
            : 'h-control w-full bg-surface-1 px-2.5 text-base font-sans'
        }
      />
      <DraftConflictLine draft={draft} text={(saved) => saved} />
    </SettingsField>
  )
}

// Shared boolean setting control.
export function Toggle({
  on,
  disabled,
  onClick,
  title,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: {
  on: boolean
  disabled?: boolean
  onClick: () => void
  title?: string
} & Pick<React.ComponentProps<typeof Button>, 'id' | 'aria-label' | 'aria-describedby'>) {
  return (
    <Button
      type="button"
      role="switch"
      id={id}
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      aria-label={ariaLabel ?? title}
      aria-describedby={ariaDescribedBy}
      title={title}
      style={
        {
          '--toggle-color': on ? 'var(--primary)' : 'var(--switch-off, var(--surface-3))',
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? 'default' : 'pointer',
        } as React.CSSProperties
      }
      className="flex h-8 w-[34px] shrink-0 items-center rounded-md border-0 bg-transparent p-0"
      variant="unstyled"
    >
      <span className="relative h-5 w-full rounded-pill bg-[var(--toggle-color)] [transition:background-color_var(--dur-fast)_var(--ease-out)]">
        <span
          style={{ left: on ? 16 : 2 }}
          className="absolute top-0.5 size-4 rounded-full bg-white shadow-card [transition:left_var(--dur-fast)_var(--ease-out)]"
        />
      </span>
    </Button>
  )
}
