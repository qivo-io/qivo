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
export function isSelectInteractionKey(event: FocusKey) {
  if (event.ctrlKey || event.metaKey) return false
  if (event.altKey) return event.key === 'ArrowDown' || event.key === 'ArrowUp'
  return navigationKeys.has(event.key) || event.key === 'F4' || event.key.length === 1
}

// Native selects release focus after a pointer pick. Keep that same policy
// when a confirmation returns to one; other controls keep their Tab anchor
// and use the shared CSS gate to restore focus silently after pointer use.
export function restoreFocus(element: HTMLElement | null | undefined) {
  element?.focus({ preventScroll: true })
  if (
    element?.matches('[data-slot="native-select"]') &&
    document.documentElement.dataset.focusModality === 'pointer'
  ) {
    element.blur()
  }
}

export function installFocusVisibility() {
  const root = document.documentElement
  const pointer = () => {
    root.dataset.focusModality = 'pointer'
  }
  const keyboard = (event: KeyboardEvent) => {
    // Radix menus/selects support letter typeahead as well as arrows. A
    // letter typed in an ordinary editor is not navigation, but one that
    // selects an option or jumps to a menu item must reveal keyboard focus.
    const typeahead =
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      event.key.length === 1 &&
      event.target instanceof Element &&
      event.target.closest(
        '[data-slot="select-trigger"], [data-slot="select-content"], [data-slot="dropdown-menu-content"], [data-slot="dropdown-menu-sub-content"]',
      )
    if (
      !isFocusNavigationKey(event) &&
      !(event.target instanceof HTMLSelectElement && isSelectInteractionKey(event)) &&
      !typeahead
    ) {
      return
    }
    root.dataset.focusModality = 'keyboard'
  }
  // Capture before a dialog/menu consumes the event. Hover and window blur
  // leave the current mode alone; opening a screenshot overlay changes neither.
  // Until the first interaction, keep the browser's native focus indication.
  document.addEventListener('pointerdown', pointer, true)
  document.addEventListener('keydown', keyboard, true)
  return () => {
    document.removeEventListener('pointerdown', pointer, true)
    document.removeEventListener('keydown', keyboard, true)
    delete root.dataset.focusModality
  }
}
