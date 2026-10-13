import { useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { PageTitle, SettingsSection } from '../../components/settingsPage'
import { useUpdateBlocker } from '../../lib/updateSafety'
import { Toggle } from './controls'

const fields = [
  {
    key: 'startAtLogin',
    label: 'Start Qivo at logon',
    hint: 'Start in the system tray when you sign in to your computer.',
  },
  {
    key: 'closeToTray',
    label: 'Close to tray',
    hint: 'Keep Qivo running in the system tray when you close the window.',
  },
  {
    key: 'minimizeToTray',
    label: 'Minimize to tray',
    hint: 'Hide Qivo in the system tray when you minimize the window.',
  },
  {
    key: 'showNotifications',
    label: 'Show notifications',
    hint: 'Show desktop alerts for Inbox messages and app updates.',
  },
] satisfies { key: keyof QivoDesktopSettings; label: string; hint: string }[]

/** Native preferences are local to this installation and save through the shell. */
export function DesktopSettingsPage({
  settings,
}: {
  settings: NonNullable<QivoDesktopBridge['settings']>
}) {
  const id = useId()
  const [values, setValues] = useState<QivoDesktopSettingsSnapshot | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  useUpdateBlocker(saving)

  useEffect(() => {
    let active = true
    setValues(null)
    setError(null)
    void settings.get().then(
      (next) => {
        if (active) setValues(next)
      },
      () => {
        if (active) setError("Couldn't load desktop settings.")
      },
    )
    return () => {
      active = false
    }
  }, [settings, loadAttempt])

  const save = async (patch: Partial<QivoDesktopSettings>) => {
    if (!values || saving) return
    setSaving(true)
    setError(null)
    try {
      setValues(await settings.update(patch))
    } catch {
      setError("Couldn't save desktop settings. Try again.")
      try {
        // A rejected startup change can add a warning without changing the saved values.
        setValues(await settings.get())
      } catch {
        // Keep the confirmed values and save error when the snapshot is unavailable.
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <PageTitle>Desktop app</PageTitle>
      <SettingsSection title="This computer" aria-busy={saving || (!values && !error)}>
        {values ? (
          <div className="space-y-6">
            {fields.map((field) => {
              const controlId = `${id}-${field.key}`
              const hintId = `${controlId}-hint`
              const errorId = `${controlId}-error`
              const startupError =
                field.key === 'startAtLogin' ? values.startAtLoginError : undefined
              return (
                <div key={field.key} className="flex items-center justify-between gap-6">
                  <div className="min-w-0">
                    <label htmlFor={controlId} className="text-base text-text-1">
                      {field.label}
                    </label>
                    <p id={hintId} className="mt-1.5 text-sm leading-normal text-text-2">
                      {field.hint}
                    </p>
                    {startupError && (
                      <div className="mt-2">
                        <p id={errorId} role="alert" className="text-sm leading-normal text-danger">
                          {startupError}
                        </p>
                        <Button
                          type="button"
                          className="mt-2"
                          disabled={saving}
                          onClick={() => void save({ startAtLogin: values.startAtLogin })}
                        >
                          Retry
                        </Button>
                      </div>
                    )}
                  </div>
                  <Toggle
                    id={controlId}
                    aria-label={field.label}
                    aria-describedby={startupError ? `${hintId} ${errorId}` : hintId}
                    on={values[field.key]}
                    disabled={saving}
                    onClick={() => void save({ [field.key]: !values[field.key] })}
                  />
                </div>
              )
            })}
          </div>
        ) : !error ? (
          <p role="status" className="text-sm text-text-2">
            Loading desktop settings…
          </p>
        ) : null}
        {error && (
          <div className={values ? 'mt-4' : undefined}>
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
            {!values && (
              <Button type="button" className="mt-3" onClick={() => setLoadAttempt((n) => n + 1)}>
                Retry
              </Button>
            )}
          </div>
        )}
      </SettingsSection>
    </>
  )
}
