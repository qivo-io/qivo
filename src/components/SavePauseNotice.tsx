import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { floatSlot } from '../lib/floatStack'
import { savePauseWords } from '../lib/noticeText'
import { type SyncStatus, syncStatus } from '../lib/syncStatus'
import { NoticeCard } from './NoticeCard'

/** The notice while Qivo cannot save, for a page without the planner store
    (the operator console). It reads `status` directly and says what the
    app's snapshot notice says about the same pause. */
export function SavePauseNotice({ status = syncStatus }: { status?: SyncStatus }) {
  // a string, so React sees the same snapshot until the pause changes
  useSyncExternalStore(status.subscribe, () => {
    const pause = status.pause()
    return pause ? `${pause.kind}:${pause.waiting}` : ''
  })
  const pause = status.pause()
  const words = pause && savePauseWords(pause)
  // Like the app's notices, the live region stays mounted outside the root,
  // so a screen reader hears it even over a dialog.
  return createPortal(
    <div aria-live="polite">
      {pause && words && <NoticeCard kind={pause.kind} title={words.title} line={words.line} />}
    </div>,
    floatSlot('snapshot'),
  )
}
