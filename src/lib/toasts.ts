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
