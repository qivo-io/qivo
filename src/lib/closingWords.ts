import { useRef } from 'react'

/** `words` while a window is open, and the words of its last open render
    while it closes. Radix keeps a closed dialog, popover or menu on screen
    for its closing animation, so a close that clears or changes the state
    its words come from (the selection a question names, a busy label)
    would otherwise fade out showing blanks or other words. Handlers read
    the live state, never these words, and a closing window takes no press
    (lib/closingGuard.ts). */
export function useClosingWords<T>(open: boolean, words: T): T {
  const kept = useRef(words)
  if (open) kept.current = words
  return kept.current
}
