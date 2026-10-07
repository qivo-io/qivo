import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { LandscapeContext } from '@/lib/landscape'
import { useMobileBackLayer } from '@/lib/useMobile'
import { useAppearance } from '../AppearanceProvider'
import { Icon } from '../components/qivo'

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
  const closeLayer = useMobileBackLayer(true, onClose, true)
  const closeRef = useRef(closeLayer)
  closeRef.current = closeLayer
  const rotated = size.height > size.width
  const width = rotated ? size.height : size.width
  const height = rotated ? size.width : size.height

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
        toLocal: (x, y) => (rotated ? { x: y, y: size.width - x } : { x, y }),
      }}
    >
      <div
        ref={frameRef}
        role="dialog"
        aria-modal="true"
        aria-label="Landscape timeline and team"
        data-roadmap-landscape={rotated ? 'rotated' : 'natural'}
        className="mobile-roadmap-landscape"
        style={
          {
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
