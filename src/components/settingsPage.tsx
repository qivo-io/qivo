/* The settings screen's page atoms. Every settings page is built from these,
   top to bottom: a PageTitle, then SettingsSections (outlined boxes named on
   their border) holding SettingsFields and SettingsGroups. The rules they
   encode — sizes, spacing, when something is a box, a group, a field or a
   row — are written down in docs/design-spec.md §3.2; change both together. */
import type React from 'react'
import { cn } from '@/lib/utils'

type Probe = { [attr: `data-${string}`]: string | undefined; 'aria-busy'?: boolean }

/* The page's name: 20px semibold, an optional 14px line under it, and an
   optional control on its right (Projects puts New project there). */
export function PageTitle({
  children,
  sub,
  action,
}: {
  children: React.ReactNode
  sub?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="settings-page-title mb-6 flex max-w-[640px] items-start gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="m-0 text-xl font-semibold">{children}</h1>
        {sub && (
          <div className="mt-2 max-w-[520px] text-base leading-normal text-text-2">{sub}</div>
        )}
      </div>
      {action}
    </div>
  )
}

/* A field's name, 13px regular, 8px above its control. */
export function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 text-sm font-normal text-text-1">{children}</div>
}

/* Supporting text under a control or a list: 13px in the secondary tone. */
export function FieldHint({ children }: { children: React.ReactNode }) {
  return <div className="mt-2 text-sm leading-normal text-text-2">{children}</div>
}

/* One setting: label over control over hint, 24px below the previous field.
   `width` caps the control; the section it sits in is 640px wide. */
export function SettingsField({
  label,
  hint,
  width,
  children,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  width?: number
  children?: React.ReactNode
}) {
  return (
    <div style={{ maxWidth: width || 400 }} className="settings-field mb-6">
      {label && <FieldLabel>{label}</FieldLabel>}
      {children}
      {hint && <FieldHint>{hint}</FieldHint>}
    </div>
  )
}

/* A section of a page: an outlined box the panel shows through, its name on
   the border in the same 13px regular a field label uses, an optional one-line
   description under the name. Sections stack 24px apart (settings-layout.css).
   `tone="danger"` paints the border and the name in the danger colour: the
   box that holds what cannot be undone. A phone page that IS one section (its
   name is the page title) passes no `title` and renders its content bare. */
export function SettingsSection({
  title,
  description,
  tone,
  className,
  children,
  ...rest
}: {
  title?: React.ReactNode
  description?: React.ReactNode
  tone?: 'danger'
  className?: string
  children: React.ReactNode
} & Probe) {
  if (!title) {
    return (
      <section
        className={cn('settings-section max-w-[640px] [&>:last-child]:mb-0', className)}
        {...rest}
      >
        {description && <p className="mb-4 text-sm text-text-2">{description}</p>}
        {children}
      </section>
    )
  }
  const danger = tone === 'danger'
  return (
    <fieldset
      className={cn(
        'settings-section min-w-0 max-w-[640px] rounded-md border p-5 pt-4',
        danger
          ? 'settings-danger-zone [border-color:color-mix(in_oklab,var(--danger)_45%,transparent)]'
          : 'border-border',
        className,
      )}
      {...rest}
    >
      <legend className={cn('px-1 text-sm font-normal', danger ? 'text-danger' : 'text-text-1')}>
        {title}
      </legend>
      {description && <p className="mb-4 text-sm text-text-2">{description}</p>}
      <div className="[&>:last-child]:mb-0">{children}</div>
    </fieldset>
  )
}

/* A named group inside a section: a hairline (none for the first group in its
   section), the name on its own line in the label style, then the content.
   `disabled` disables every control in the group. */
export function SettingsGroup({
  legend,
  description,
  disabled,
  className,
  children,
  ...rest
}: {
  legend: React.ReactNode
  description?: React.ReactNode
  disabled?: boolean
  className?: string
  children: React.ReactNode
} & Probe) {
  return (
    <fieldset
      disabled={disabled}
      className={cn(
        'settings-group mt-6 min-w-0 border-t border-border pt-4 first:mt-0 first:border-t-0 first:pt-0',
        className,
      )}
      {...rest}
    >
      {/* floated, so the browser lays the legend out as an ordinary block
          instead of setting it into the border */}
      <legend className="float-left w-full text-sm font-normal text-text-1">{legend}</legend>
      {description && <p className="clear-both pt-2 text-sm text-text-2">{description}</p>}
      <div className="clear-both pt-2 [&>:last-child]:mb-0">{children}</div>
    </fieldset>
  )
}
