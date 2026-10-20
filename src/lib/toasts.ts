import type { Politeness } from './announce'

/* How a toast reads at a glance. 'success' confirms an action the user asked
   for, 'error' reports something that failed, was refused, reverted or
   discarded, and 'info' is a neutral notice about an automatic adjustment. */
export type ToastTone = 'success' | 'error' | 'info'

/* The Icon name, its colour and how a screen reader hears each tone (see
   announce). An error interrupts; successes and notices wait for a pause. */
const LOOKS: Record<ToastTone, { icon: string; color: string; politeness: Politeness }> = {
  success: { icon: 'check', color: 'var(--success)', politeness: 'polite' },
  error: { icon: 'alert', color: 'var(--danger)', politeness: 'assertive' },
  info: { icon: 'info', color: 'var(--text-2)', politeness: 'polite' },
}

/** How a toast of this tone looks. A toast without a tone is a success. */
export function toastLook(tone: ToastTone = 'success') {
  return LOOKS[tone]
}

/** One toast on screen. A sticky one stays until the person closes it and
    no newer toast pushes it out; `key` names one the store shows again with
    new text. */
export type Toast = {
  id: number
  text: string
  tone?: ToastTone
  sticky?: boolean
  key?: string
  /** Runs when the person closes the toast. */
  onDismiss?: () => void
}

/** How many toasts show at once, sticky ones aside once they fill it. */
export const TOASTS_SHOWN = 3

/** The toasts after `toast` arrives. One with the `key` of a toast on
    screen replaces that toast's text in place. Otherwise it goes last, and
    the oldest toasts that are not sticky give way so at most TOASTS_SHOWN
    show, or only the sticky ones and the new one when they are more. */
export function withToast(list: readonly Toast[], toast: Toast): Toast[] {
  const at = toast.key === undefined ? -1 : list.findIndex((t) => t.key === toast.key)
  if (at >= 0)
    return list.map((t, i) =>
      i === at ? { ...t, text: toast.text, tone: toast.tone, onDismiss: toast.onDismiss } : t,
    )
  const stuck = list.filter((t) => t.sticky)
  const passing = list.filter((t) => !t.sticky)
  const room = Math.max(0, TOASTS_SHOWN - 1 - stuck.length)
  const kept = new Set([...stuck, ...passing.slice(passing.length - room)])
  return [...list.filter((t) => kept.has(t)), toast]
}
