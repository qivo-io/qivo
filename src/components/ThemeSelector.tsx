import { Check, Layers, Moon, Sun } from 'lucide-react'
import { useId } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AppearancePreferences } from '../store/planner'
import { SettingsGroup } from './settingsPage'

type Theme = AppearancePreferences['mode']

/** An illustration of each palette, independent of the active workspace image. */
function ThemePreview({ mode }: { mode: Theme }) {
  return (
    <svg
      className="theme-choice-preview"
      data-theme-preview={mode}
      viewBox="0 0 192 132"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="theme-preview-panel" x="7" y="8" width="38" height="116" rx="2" />
      <rect className="theme-preview-heading" x="12" y="14" width="18" height="3" rx="1" />
      <path className="theme-preview-navigation" d="M12 25h29m-29 7h29m-29 7h29" />
      <circle className="theme-preview-avatar" cx="15" cy="115" r="3.5" />
      <rect className="theme-preview-title" x="51" y="15" width="73" height="3" />
      <rect className="theme-preview-action" x="167" y="13" width="16" height="6" rx="1" />
      {[51, 96, 141].map((x) => (
        <g key={x}>
          <rect className="theme-preview-panel" x={x} y="27" width="39" height="97" rx="2" />
          <rect className="theme-preview-title" x={x + 3} y="32" width="23" height="2" />
          <rect className="theme-preview-task" x={x + 3} y="39" width="33" height="19" rx="1" />
          <rect className="theme-preview-task" x={x + 3} y="63" width="33" height="19" rx="1" />
        </g>
      ))}
    </svg>
  )
}

export function ThemeSelector({
  value,
  disabled,
  onChange,
}: {
  value: Theme
  disabled: boolean
  onChange: (mode: Theme) => void
}) {
  const id = useId()
  return (
    <SettingsGroup legend="UI theme" className="theme-selector" aria-busy={disabled}>
      <div className="theme-choice-grid">
        {(
          [
            ['blue', 'Blue', Layers],
            ['dark', 'Dark', Moon],
            ['light', 'Light', Sun],
          ] as const
        ).map(([mode, label, Icon]) => (
          <Label key={mode} className="theme-choice">
            <Input
              type="radio"
              className="theme-choice-input"
              name={`${id}-mode`}
              value={mode}
              checked={value === mode}
              aria-disabled={disabled}
              data-appearance-mode={mode}
              // Keep keyboard focus in the group while saving. Native disabled
              // radios lose it, breaking the next arrow-key selection.
              onClick={(event) => {
                if (disabled) event.preventDefault()
              }}
              onKeyDown={(event) => {
                if (
                  disabled &&
                  ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)
                )
                  event.preventDefault()
              }}
              onChange={() => {
                if (!disabled) onChange(mode)
              }}
            />
            <span className="theme-choice-body">
              <ThemePreview mode={mode} />
              <span className="theme-choice-label">
                <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                <span>{label}</span>
                <span className="theme-choice-mark" aria-hidden="true">
                  <Check className="size-2.5" strokeWidth={3} />
                </span>
              </span>
            </span>
          </Label>
        ))}
      </div>
    </SettingsGroup>
  )
}
