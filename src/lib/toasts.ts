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
  /** How many earlier errors folded into this one no longer show their own
      line (mergeErrors). */
  earlier?: number
}

/** The most lines an error toast that holds earlier errors shows. */
const ERROR_LINES = 3

/* An error toast's own lines, without the line that counts earlier ones. */
const linesOf = (t: Toast) => (t.earlier ? t.text.split('\n').slice(1) : t.text.split('\n'))

/* `b` with `a`'s text before its own: a repeated line shows once, at its
   latest place, and past ERROR_LINES the oldest give way to a line that
   counts them, so nothing goes without a word and the toast stays short. */
function mergeErrors(a: Toast, b: Toast): Toast {
  const seen = new Set<string>()
  const lines = [...linesOf(a), ...linesOf(b)]
    .reverse()
    .filter((line) => !seen.has(line) && seen.add(line))
    .reverse()
  const shown = lines.slice(-ERROR_LINES)
  const earlier = (a.earlier ?? 0) + (b.earlier ?? 0) + lines.length - shown.length
  const head = earlier ? [`${earlier} earlier problem${earlier === 1 ? '' : 's'} not listed.`] : []
  return { ...b, text: [...head, ...shown].join('\n'), earlier: earlier || undefined }
}

/** How many toasts show at once, sticky ones aside once they fill it. */
export const TOASTS_SHOWN = 3

/** The toasts after `toast` arrives. One with the `key` of a toast on
    screen replaces that toast's text in place. Otherwise it goes last, and
    older toasts that are not sticky make room so at most TOASTS_SHOWN show,
    or only the sticky ones and the new one when they are more. Successes
    and notices give way first, oldest first. An error, a refusal or failure
    the person must read, never just disappears: when only errors are left
    to give way, the oldest one's text moves into the next error, or into
    the new toast when that is an error (mergeErrors), and otherwise it
    stays. */
export function withToast(list: readonly Toast[], toast: Toast): Toast[] {
  const at = toast.key === undefined ? -1 : list.findIndex((t) => t.key === toast.key)
  if (at >= 0)
    return list.map((t, i) =>
      i === at ? { ...t, text: toast.text, tone: toast.tone, onDismiss: toast.onDismiss } : t,
    )
  const stuck = list.filter((t) => t.sticky)
  const passing = list.filter((t) => !t.sticky)
  const room = Math.max(0, TOASTS_SHOWN - 1 - stuck.length)
  let last = toast
  while (passing.length > room) {
    const quiet = passing.findIndex((t) => t.tone !== 'error')
    if (quiet >= 0) {
      passing.splice(quiet, 1)
      continue
    }
    const [oldest, next] = passing
    if (next !== undefined) passing.splice(0, 2, mergeErrors(oldest, next))
    else if (last.tone === 'error') {
      passing.shift()
      last = mergeErrors(oldest, last)
    } else break
  }
  const kept = new Map(passing.map((t) => [t.id, t]))
  const shown = list.flatMap((t) => {
    const now = t.sticky ? t : kept.get(t.id)
    return now ? [now] : []
  })
  return [...shown, last]
}
