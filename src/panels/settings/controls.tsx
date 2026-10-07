/* Shared settings navigation, fields and confirmation controls. */
import type React from 'react'
import { useEffect as useEffectS, useState as useStateS } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Icon } from '../../components/qivo'
import { SettingsField } from '../../components/settingsPage'
import { WORKSPACE_SIGNUP_URL } from '../../lib/demoMode'
import { useUpdateBlocker } from '../../lib/updateSafety'

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

export function TextField({
  label,
  value,
  onCommit,
  placeholder,
  hint,
  width,
  probe,
  multiline = false,
  maxLength,
  disabled = false,
}: {
  label: string
  value: string
  onCommit: (v: string) => void
  placeholder?: string
  hint?: React.ReactNode
  width?: number
  probe?: string
  multiline?: boolean
  maxLength?: number
  disabled?: boolean
}) {
  const [v, setV] = useStateS(value)
  useUpdateBlocker(!disabled && v !== value)
  useEffectS(() => {
    setV(value)
  }, [value])
  const commit = () => {
    const t = v.trim()
    if (!disabled && (t || multiline) && t !== value) onCommit(t)
    else setV(value)
  }
  const Control = multiline ? Textarea : Input
  return (
    <SettingsField label={label} hint={hint} width={width}>
      <Control
        aria-label={label}
        value={v}
        rows={multiline ? 1 : undefined}
        maxLength={maxLength}
        disabled={disabled}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            e.currentTarget.blur()
          }
          if (multiline && e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            setV(value)
          }
        }}
        {...(probe ? { [probe]: '' } : {})}
        placeholder={placeholder}
        className={
          multiline
            ? 'min-h-control w-full resize-none overflow-y-auto bg-surface-1 px-[11px] py-1 text-base font-sans md:text-base'
            : 'h-control w-full bg-surface-1 px-[11px] text-base font-sans'
        }
      />
    </SettingsField>
  )
}

// Confirmation disarms after 3.5 seconds; reversible actions may use neutral color.
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  icon = 'trash',
  disabled,
  title,
  danger = true,
  ...rest
}: {
  label: string
  confirmLabel: string
  onConfirm: () => void
  icon?: string
  disabled?: boolean
  title?: string
  danger?: boolean
  // the callers' data-* probes ride through `rest` onto the button
  [dataAttr: `data-${string}`]: string | undefined
}) {
  const [arm, setArm] = useStateS(false)
  useEffectS(() => {
    if (!arm) return
    const t = setTimeout(() => setArm(false), 3500)
    return () => clearTimeout(t)
  }, [arm])
  const tone = danger ? 'var(--danger)' : 'var(--text-1)'
  return (
    <Button
      disabled={disabled}
      title={title}
      {...rest}
      style={{
        color: tone,
        borderColor: arm ? tone : 'var(--border)',
        background: arm ? (danger ? 'var(--danger-soft)' : 'var(--surface-2)') : 'var(--surface-1)',
      }}
      onClick={() => {
        if (!arm) {
          setArm(true)
          return
        }
        setArm(false)
        onConfirm()
      }}
    >
      <Icon name={icon} size={16} />
      {arm ? confirmLabel : label}
    </Button>
  )
}

// Shared boolean setting control.
export function Toggle({
  on,
  disabled,
  onClick,
  title,
}: {
  on: boolean
  disabled?: boolean
  onClick: () => void
  title?: string
}) {
  return (
    <Button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      aria-label={title}
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
