// Native :focus-visible can light a pointer-focused button on Shift (including
// Win+Shift+S), Escape, or programmatic refocus from a text box. Only actual
// keyboard navigation should opt buttons into focus cues after a pointer press.
// Keep DOM focus intact so Tab order, shortcuts and assistive technology work.
const navigationKeys = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Enter',
  ' ',
])

type FocusKey = Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey'>

function isFocusNavigationKey(event: FocusKey) {
  return !event.altKey && !event.ctrlKey && !event.metaKey && navigationKeys.has(event.key)
}

// Native select popups also support typeahead, F4 and Alt+Arrow. These are
// selection keys only on a select, not global navigation or OS shortcuts.
function isSelectInteractionKey(event: FocusKey) {
  if (event.ctrlKey || event.metaKey) return false
  if (event.altKey) return event.key === 'ArrowDown' || event.key === 'ArrowUp'
  return navigationKeys.has(event.key) || event.key === 'F4' || event.key.length === 1
}

/* True when the latest input was a pointer press rather than keyboard use.
   NativeSelect releases focus after a pointer pick by this, so a value picked
   with the keyboard, even in a list opened with the mouse, keeps focus. */
export function lastInputWasPointer() {
  return document.documentElement.dataset.focusModality === 'pointer'
}

// Native selects release focus after a pointer pick. Keep that same policy
// when a confirmation returns to one; other controls keep their Tab anchor
// and use the shared CSS gate to restore focus silently after pointer use.
// Keyboard focus that lands wholly outside the window, as on a control
// above a phone's scrolled page, scrolls into view as a plain focus would.
export function restoreFocus(element: HTMLElement | null | undefined) {
  element?.focus({ preventScroll: true })
  if (!element || document.activeElement !== element) return
  if (lastInputWasPointer()) {
    if (element.matches('[data-slot="native-select"]')) element.blur()
  } else if (outOfView(element)) element.scrollIntoView({ block: 'nearest' })
}

/** Whether `element` has a box and none of it is inside the window. */
function outOfView(element: HTMLElement) {
  const box = element.getBoundingClientRect()
  if (!box.width && !box.height) return false
  return box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth
}

// A customizable select (tokens.css) draws its open list in the page, so the
// keys used in that list also reach the page's own key handlers, where an
// OS-drawn list kept them to itself. Escape would close Settings, the task
// window, dialogs and pops. True for any key pressed in an open list. The
// browser still acts on it, and nothing else should.
export function isOpenSelectKey(event: Pick<KeyboardEvent, 'target'>) {
  if (!(event.target instanceof Element)) return false
  const select = event.target.closest('select')
  if (!select) return false
  try {
    return select.matches(':open')
  } catch {
    // a browser without :open has no in-page list either
    return false
  }
}

/* Installs the shared input-modality tracking, and the guard that keeps an
   open select's keys from the page. Call it before anything else registers a
   key listener. Window capture runs first and in registration order, so the
   guard sees a key before any dialog, pop or page does. It records the key's
   modality first, because nothing after it sees an open list's keys. */
export function installFocusVisibility() {
  const root = document.documentElement
  const pointer = () => {
    root.dataset.focusModality = 'pointer'
  }
  const keydown = (event: KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target : null
    // Radix selects support letter typeahead as well as arrows. A letter
    // typed in an ordinary editor is not navigation, but one that selects an
    // option must reveal keyboard focus.
    const typeahead =
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      event.key.length === 1 &&
      target?.closest('[data-slot="select-trigger"], [data-slot="select-content"]')
    // A native select's keys arrive from the select, or from an option in
    // its open customizable list.
    if (
      isFocusNavigationKey(event) ||
      (target?.closest('select') && isSelectInteractionKey(event)) ||
      typeahead
    ) {
      root.dataset.focusModality = 'keyboard'
    }
    if (isOpenSelectKey(event)) event.stopImmediatePropagation()
  }
  // Capture before a dialog/menu consumes the event. Hover and window blur
  // leave the current mode alone; opening a screenshot overlay changes neither.
  // Until the first interaction, keep the browser's native focus indication.
  document.addEventListener('pointerdown', pointer, true)
  window.addEventListener('keydown', keydown, true)
  return () => {
    document.removeEventListener('pointerdown', pointer, true)
    window.removeEventListener('keydown', keydown, true)
    delete root.dataset.focusModality
  }
}
