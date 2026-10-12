/* How a toast reads at a glance. 'success' confirms an action the user asked
   for, 'error' reports something that failed, was refused, reverted or
   discarded, and 'info' is a neutral notice about an automatic adjustment. */
export type ToastTone = 'success' | 'error' | 'info'

/* The Icon name, its colour and the live-region role for each tone. An error
   interrupts a screen reader (role "alert"); successes and notices are read
   at its next pause (role "status"). */
const LOOKS: Record<ToastTone, { icon: string; color: string; role: 'alert' | 'status' }> = {
  success: { icon: 'check', color: 'var(--success)', role: 'status' },
  error: { icon: 'alert', color: 'var(--danger)', role: 'alert' },
  info: { icon: 'info', color: 'var(--text-2)', role: 'status' },
}

/** How a toast of this tone looks. A toast without a tone is a success. */
export function toastLook(tone: ToastTone = 'success') {
  return LOOKS[tone]
}
