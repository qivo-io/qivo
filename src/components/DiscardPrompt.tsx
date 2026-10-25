import { useEffect, useSyncExternalStore } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useClosingWords } from '@/lib/closingWords'
import {
  closeQuestion,
  currentQuestion,
  discardAndClose,
  noteFocus,
  subscribe,
  takeReturnField,
  unsentList,
} from '@/lib/discardQuestion'
import { restoreFocus } from '@/lib/focusVisibility'
import { OUT_OF_USE } from '@/lib/viewHidden'

/* The Keep editing or Discard question (lib/discardQuestion has its state
   and the closeOrAsk every window's close goes through). */

/** The one Keep editing or Discard question, mounted once at the root. */
export function DiscardPrompt() {
  const ask = useSyncExternalStore(subscribe, currentQuestion)
  // the last question's words, for its last render as it closes
  const shown = useClosingWords(!!ask, ask)
  useEffect(() => {
    const record = (event: FocusEvent) => noteFocus(event.target)
    document.addEventListener('focusin', record)
    return () => document.removeEventListener('focusin', record)
  }, [])
  return (
    <AlertDialog
      open={!!ask}
      onOpenChange={(open) => {
        if (!open) closeQuestion()
      }}
    >
      <AlertDialogContent
        data-discard-prompt
        // no fade-out: a fading question would still hold focus and Escape
        overlayClassName="z-[130] data-[state=closed]:!animate-none"
        className="z-[131] data-[state=closed]:!animate-none"
        onCloseAutoFocus={(event) => {
          // back to the text after Keep editing or Escape
          const field = takeReturnField()
          if (!field?.isConnected || field.closest(OUT_OF_USE)) return
          event.preventDefault()
          restoreFocus(field)
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Discard your unsent {unsentList(shown?.what ?? [])}?</AlertDialogTitle>
          <AlertDialogDescription>It was not sent, and Qivo keeps no copy.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-discard-keep>Keep editing</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            data-discard-confirm
            onClick={() => {
              if (ask) discardAndClose(ask)
            }}
          >
            Discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
