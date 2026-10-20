import type { MessageBoxSyncOptions } from 'electron'

/** The native question shown when the page warns before it unloads. */
export const LEAVE_PROMPT: MessageBoxSyncOptions = {
  type: 'warning',
  buttons: ['Leave', 'Stay'],
  defaultId: 1,
  cancelId: 1,
  title: 'Leave Qivo?',
  message: 'You have changes that are not saved yet.',
  detail: 'If you leave now, they may be lost.',
}

type LeavePromptOptions = {
  /** Shows LEAVE_PROMPT and answers the index of the button chosen. */
  ask: (options: MessageBoxSyncOptions) => number
  /** Runs when the person chose to stay, so a quit that was under way stops. */
  onStay: () => void
}

/* The page asks the browser to warn before it closes or reloads while a
   change is not saved (src/lib/leaveGuard.ts). Electron then cancels the
   close or the navigation without a word, so a closed window would simply
   not close. The `will-prevent-unload` handler this returns asks instead:
   Leave ignores the page's warning, Stay keeps the page. */
export function createLeavePrompt({ ask, onStay }: LeavePromptOptions) {
  return (event: { preventDefault: () => void }) => {
    if (ask(LEAVE_PROMPT) === 0) event.preventDefault()
    else onStay()
  }
}
