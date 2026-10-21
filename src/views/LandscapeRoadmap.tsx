import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { useFloatInsets } from '@/lib/floatStack'
import { LandscapeContext } from '@/lib/landscape'
import { useRootMark } from '@/lib/rootMark'
import { useHideOthers } from '@/lib/useHideOthers'
import { useMobileBackLayer } from '@/lib/useMobile'
import { Icon } from '../components/qivo'
import { useAppearance } from '../lib/appearanceContext'

/** A landscape canvas even with the phone's portrait rotation lock enabled.
 * Portaling beside the workspace keeps its entrance animation from becoming
 * the containing block for this full-viewport screen. Task/editor layers can
 * still open above it, and its menus share the transformed coordinate space. */
export function LandscapeRoadmap({
  children,
  title,
  onClose,
  planning,
}: {
  children: ReactNode
  title: string
  onClose: () => void
  planning: boolean
}) {
  const appearance = useAppearance()
  const [size, setSize] = useState(() => ({ width: innerWidth, height: innerHeight }))
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  // the page behind is hidden from assistive technology while this is open;
  // aria-modal would also silence the announcer (lib/announce)
  useHideOthers(frameRef, true)
  // the floating notices keep the window's axis while this covers it
  useRootMark('landscape-roadmap')
  const closeLayer = useMobileBackLayer(true, onClose, true)
  const closeRef = useRef(closeLayer)
  closeRef.current = closeLayer
  // The screen fills the window between the floating notices' bands
  // (lib/floatStack), which stay level while the screen turns.
  const band = useFloatInsets()
  const rotated = size.height > size.width
  const room = Math.max(0, size.height - band.top - band.bottom)
  const width = rotated ? room : size.width
  const height = rotated ? size.width : room

  useEffect(() => {
    const resize = () => setSize({ width: innerWidth, height: innerHeight })
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => {
    frameRef.current?.querySelector<HTMLButtonElement>('[data-landscape-back]')?.focus()
  }, [])

  return createPortal(
    <LandscapeContext.Provider
      value={{
        host,
        rotated,
        width,
        height,
        toLocal: (x, y) =>
          rotated ? { x: y - band.top, y: size.width - x } : { x, y: y - band.top },
      }}
    >
      <div
        ref={frameRef}
        role="dialog"
        aria-label="Landscape timeline and team"
        data-roadmap-landscape={rotated ? 'rotated' : 'natural'}
        className="mobile-roadmap-landscape"
        style={
          {
            top: band.top,
            width,
            height,
            '--landscape-width': `${width}px`,
            '--landscape-height': `${height}px`,
            transform: rotated ? `translateX(${size.width}px) rotate(90deg)` : 'none',
          } as CSSProperties
        }
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.defaultPrevented) {
            event.stopPropagation()
            closeRef.current()
          }
          if (event.key !== 'Tab') return
          const controls = Array.from(
            frameRef.current?.querySelectorAll<HTMLElement>(
              'button, input, select, textarea, a[href], summary, [tabindex]',
            ) ?? [],
          ).filter(
            (el) => el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length,
          )
          const first = controls[0]
          const last = controls.at(-1)
          if (event.shiftKey && document.activeElement === first && last) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last && first) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <div className="appearance-background" aria-hidden="true">
          {appearance.backgroundUrl && (
            <img src={appearance.backgroundUrl} alt="" draggable={false} />
          )}
        </div>
        <header className="mobile-roadmap-landscape-heading">
          <Button
            type="button"
            variant="ghost"
            data-landscape-back
            onClick={closeLayer}
            title={planning ? 'Cancel the current plan and return to the agenda' : undefined}
          >
            <Icon name="chevronLeft" size={16} />
            Back to agenda
          </Button>
          <h1>{title}</h1>
          <span>Timeline &amp; team</span>
        </header>
        {children}
        <div ref={setHost} className="mobile-roadmap-landscape-portals" />
      </div>
    </LandscapeContext.Provider>,
    document.querySelector('.planner-shell') || document.body,
  )
}
