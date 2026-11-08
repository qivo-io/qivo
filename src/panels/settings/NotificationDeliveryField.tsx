/* Notification delivery on Settings › Your preferences › Notifications: where
   the account's desktop alerts appear, Most recently active session or All
   enabled sessions (convex/notifications.ts settings and setDelivery).

   It reads the setting live on the visibility gate (lib/liveView.ts
   useLiveView), so its read stops while the tab is hidden; the leader tab's
   own watch of the same query is not a view's and runs on
   (lib/notificationLeader.ts). It keeps its last answer, so on a return it
   shows that value marked as refreshing, with the select disabled, until
   the new answer comes. It shows no choice as saved before the server
   answered, and says so on a failure, with Try again. A choice saves
   through the store (P.setNotificationDelivery); while it runs the select
   is disabled and shows the choice, and once it answers the read owns what
   shows, so a newer choice from another tab wins. A refusal returns the
   select to the read's value and shows the server's sentence, the demo's
   change limit included.

   It chooses destinations only: it turns no alert on, asks for no
   permission and changes no switch of the desktop app. Its line about this
   browser or app reads lib/notify.ts canNotify and watchCapability, with
   no server read. */
import { useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { api } from '../../../convex/_generated/api'
import { SettingsField } from '../../components/settingsPage'
import { useLiveView } from '../../lib/liveView'
import type { Delivery } from '../../lib/notificationLeader'
import { canNotify, watchCapability } from '../../lib/notify'
import { useUpdateBlocker } from '../../lib/updateSafety'
import { P } from '../../store/planner'

/** The choices, in the order the select lists them. */
const CHOICES: { value: Delivery; label: string }[] = [
  { value: 'recent', label: 'Most recently active session' },
  { value: 'all', label: 'All enabled sessions' },
]

/** What each choice does, in plain sentences. */
const HINTS: Record<Delivery, string> = {
  recent:
    'Qivo shows desktop alerts only in the browser or desktop app you used last that can show them. When it closes or goes offline, the next one takes over.',
  all: 'Qivo shows desktop alerts in every browser and desktop app that can show them, once in each.',
}

/* The sentence of a refused save, as the server words it in a
   ConvexError's data. */
function refusalText(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'data' in error) {
    const { data } = error
    if (typeof data === 'object' && data !== null && 'message' in data) {
      const { message } = data
      if (typeof message === 'string' && message) return message
    }
  }
  return "Notification delivery couldn't be saved. Try again."
}

/** The line that says whether this browser or desktop app can show alerts,
    which follows canNotify(). */
function useCapabilityLine(): string {
  const [can, setCan] = useState(canNotify)
  useEffect(() => {
    setCan(canNotify())
    return watchCapability(setCan)
  }, [])
  if (typeof window !== 'undefined' && window.qivoDesktop)
    return can
      ? 'This desktop app can show alerts.'
      : 'Show notifications is off in this desktop app.'
  return can ? 'This browser can show alerts.' : "This browser can't show alerts."
}

/** The Notification delivery field, on the server's setting. */
export function NotificationDeliveryField() {
  const id = useId()
  const view = useLiveView<{ delivery: Delivery }>(api.notifications.settings, '{}')
  // the last answer, which shows marked as refreshing until the next one
  const [held, setHeld] = useState<Delivery | null>(null)
  const [saving, setSaving] = useState<Delivery | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const capability = useCapabilityLine()
  useUpdateBlocker(saving !== null)
  const current = view.value?.delivery
  useEffect(() => {
    if (current !== undefined) setHeld(current)
  }, [current])
  const failed = view.error !== undefined && current === undefined
  const shown = saving ?? current ?? held
  const refreshing = current === undefined && held !== null && !failed
  const desktop = typeof window !== 'undefined' && !!window.qivoDesktop

  const choose = async (delivery: Delivery) => {
    if (saving !== null || current === undefined || delivery === current) return
    setSaving(delivery)
    setError('')
    setNotice('')
    try {
      await P.setNotificationDelivery(delivery)
      setNotice('Notification delivery saved.')
    } catch (failure) {
      setError(refusalText(failure))
    } finally {
      setSaving(null)
    }
  }

  if (failed)
    return (
      <div
        role="alert"
        data-notification-delivery-state="unavailable"
        className="space-y-2 text-sm"
      >
        <p className="text-danger">Notification delivery couldn't be loaded.</p>
        <Button type="button" onClick={view.retry}>
          Try again
        </Button>
      </div>
    )
  if (shown === null)
    return (
      <p role="status" data-notification-delivery-state="loading" className="text-sm text-text-2">
        Loading notification delivery…
      </p>
    )
  const hintId = `${id}-hint`
  return (
    <div
      data-notification-delivery-state={
        saving !== null ? 'saving' : refreshing ? 'refreshing' : 'ready'
      }
      aria-busy={refreshing || saving !== null || undefined}
    >
      <SettingsField
        label="Notification delivery"
        width={400}
        hint={
          <span id={hintId}>
            {HINTS[shown]}
            <br />
            {desktop
              ? 'This does not turn alerts on. Turn them on with Show notifications in Settings → User account → Desktop app.'
              : 'This does not turn alerts on. Turn them on with Enable notifications in Inbox, or with Show notifications in the desktop app.'}
          </span>
        }
      >
        <NativeSelect
          value={shown}
          data-notification-delivery={shown}
          aria-label="Notification delivery"
          aria-describedby={hintId}
          disabled={saving !== null || refreshing}
          onChange={(e) => {
            const choice = CHOICES.find((c) => c.value === e.target.value)
            if (choice) void choose(choice.value)
          }}
          className="h-control min-w-60 bg-surface-1 font-sans text-base"
        >
          {CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </NativeSelect>
      </SettingsField>
      <p data-notification-capability className="-mt-3 text-sm text-text-2">
        {capability}
      </p>
      {saving !== null && (
        <p role="status" className="mt-3 text-sm text-text-2">
          Saving…
        </p>
      )}
      {error && (
        <p role="alert" data-notification-delivery-error className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" data-notification-delivery-saved className="mt-3 text-sm text-text-2">
          {notice}
        </p>
      )}
    </div>
  )
}
