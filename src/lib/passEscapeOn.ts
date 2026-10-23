/** Sends an Escape that a closing tooltip consumed on to whatever lies below.

    While a tooltip shows, it is the topmost Radix layer, so Escape reaches it
    first and Radix gives nothing below it the key: the task window, a dialog
    or a pop would need a second press. Once the closed tooltip has left the
    DOM, and the layer below has had a frame to take Escape back, this sends
    the same Escape again from where it was pressed, so the press does what it
    would do without the tooltip. */
export function passEscapeOn(pressed: EventTarget | null, tooltip: HTMLElement | null) {
  const send = () => {
    const target =
      pressed instanceof Element && pressed.isConnected
        ? pressed
        : (document.activeElement ?? document.body)
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    )
  }
  // A tooltip still in the DOM after about a second keeps the Escape: sent
  // again, it would reach that tooltip once more instead of the layer below.
  let frames = 60
  const waitForClose = () => {
    if (!tooltip?.isConnected) requestAnimationFrame(() => setTimeout(send, 0))
    else if (--frames > 0) requestAnimationFrame(waitForClose)
  }
  requestAnimationFrame(waitForClose)
}

/** True while a tooltip shows or plays its closing animation. It is then
    the topmost Radix layer, so it takes Escape and passes it on
    (passEscapeOn). An Escape handler that sees the press as well (window
    or document capture) skips it and acts on the one passed on, so one
    press acts once. */
export function hasTooltip() {
  return !!document.querySelector('[data-slot="tooltip-content"]')
}
