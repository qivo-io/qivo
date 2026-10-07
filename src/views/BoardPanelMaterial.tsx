import type { Ref } from 'react'
import { createPortal } from 'react-dom'
import { useAppearance } from '../AppearanceProvider'

/* Keep one filtered photograph fixed to the viewport. The union clip follows
   visible panel shapes without re-capturing a live backdrop during scrolling. */
export function BoardPanelMaterial({ materialRef }: { materialRef: Ref<HTMLDivElement> }) {
  const { backgroundUrl } = useAppearance()
  const root = document.getElementById('root')
  return root
    ? createPortal(
        <div ref={materialRef} aria-hidden="true" className="board-panel-material">
          {backgroundUrl && (
            <div className="board-panel-photo">
              <img key={backgroundUrl} src={backgroundUrl} alt="" draggable={false} />
            </div>
          )}
        </div>,
        root,
      )
    : null
}
