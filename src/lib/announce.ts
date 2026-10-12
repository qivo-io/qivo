/* Screen reader announcements for short-lived messages such as toasts.

   A live region is read reliably only when it is on the page before its text
   arrives, so installAnnouncer() puts one polite and one assertive region in
   <body> at startup, and announce() adds each message to them as a new node.
   The markup follows React Aria's LiveAnnouncer.

   The regions stay audible over modal layers. Radix dialogs, selects and
   popovers and the landscape Roadmap hide the rest of the page with
   aria-hidden's hideOthers(), which leaves [aria-live] elements exposed. The
   task window makes the page behind inert but skips [data-top-layer], which
   also marks the toasts and the update notice. The app avoids
   aria-modal="true" for the same reason: Safari, and Chrome on macOS and
   Android, ignore everything outside such a dialog, these regions included. */

export type Politeness = 'polite' | 'assertive'

const ROOT = 'data-live-announcer'
// React Aria's lifetime, which leaves slower screen readers time to read the
// text; an additions-only region does not announce the removal
const LIFETIME_MS = 7000

/** Puts the page's live regions in place once. Returns a function that
    removes them, for hot reloads. */
export function installAnnouncer(): () => void {
  if (typeof document === 'undefined' || document.querySelector(`[${ROOT}]`)) return () => {}
  const root = document.createElement('div')
  root.setAttribute(ROOT, '')
  root.setAttribute('data-top-layer', '')
  root.className = 'sr-only'
  for (const politeness of ['assertive', 'polite'] as const) {
    const region = document.createElement('div')
    region.setAttribute('role', 'log')
    region.setAttribute('aria-live', politeness)
    region.setAttribute('aria-relevant', 'additions')
    root.append(region)
  }
  document.body.prepend(root)
  return () => root.remove()
}

/** Reads `text` aloud once. Assertive interrupts the screen reader, polite
    waits for a pause. Repeating the same text adds a new message, so it is
    read again. Does nothing before installAnnouncer() has run. */
export function announce(text: string, politeness: Politeness = 'polite') {
  if (typeof document === 'undefined' || !text) return
  const region = document.querySelector(`[${ROOT}] [aria-live="${politeness}"]`)
  if (!region) return
  const message = document.createElement('div')
  message.textContent = text
  region.append(message)
  setTimeout(() => message.remove(), LIFETIME_MS)
}
