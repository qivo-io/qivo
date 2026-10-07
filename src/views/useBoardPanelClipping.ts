import { useLayoutEffect, useRef, useState } from 'react'

type PaintBounds = {
  element: HTMLElement
  rect: DOMRect
  top: number
  bottom: number
  lowerCurve?: {
    left: number
    right: number
    bottom: number
    radius: number
    frameTop: number
    borderLeft: number
    borderRight: number
    borderBottom: number
  }
}
type PaintProperty = 'clip-path' | 'clip'
type StylePaint = { original: string; value: string; applied: string }

function panelPath(
  left: number,
  top: number,
  right: number,
  bottom: number,
  topRadius: number,
  bottomRadius: number,
) {
  const limit = Math.min((right - left) / 2, (bottom - top) / 2)
  const t = Math.min(topRadius, limit)
  const b = Math.min(bottomRadius, limit)
  return `M ${left + t} ${top} H ${right - t} A ${t} ${t} 0 0 1 ${right} ${top + t} V ${bottom - b} A ${b} ${b} 0 0 1 ${right - b} ${bottom} H ${left + b} A ${b} ${b} 0 0 1 ${left} ${bottom - b} V ${top + t} A ${t} ${t} 0 0 1 ${left + t} ${top} Z`
}

/* Intersect the body's visible rectangle with the material's actual lower
   corners. A natural body can end above the corner, or partway through it;
   rounding that shorter rectangle would put the arc at the wrong height. */
function bodyPath(
  left: number,
  top: number,
  right: number,
  bottom: number,
  panelBottom: number,
  radius: number,
  frameTop: number,
  borderLeft: number,
  borderRight: number,
  borderBottom: number,
) {
  if (bottom <= frameTop) {
    return `M ${left} ${top} H ${right} V ${bottom} H ${left} Z`
  }
  // Above the foot, keep the body's side borders. Under its border-only
  // frame, clip to the inner edge so translucent strokes never paint twice.
  const frameStart = Math.max(top, frameTop)
  const innerLeft = left + borderLeft
  const innerRight = right - borderRight
  const curveTop = panelBottom - radius
  const radiusY = Math.max(0, radius - borderBottom)
  const radiusLeft = Math.max(0, radius - borderLeft)
  const radiusRight = Math.max(0, radius - borderRight)
  const arcTop = Math.max(frameStart, curveTop)
  const offset = (y: number, radiusX: number) => {
    if (radiusY === 0) return 0
    const fraction = Math.min(1, Math.max(0, (y - curveTop) / radiusY))
    return radiusX * (1 - Math.sqrt(Math.max(0, 1 - fraction * fraction)))
  }
  const startLeft = innerLeft + offset(frameStart, radiusLeft)
  const startRight = innerRight - offset(frameStart, radiusRight)
  const path =
    frameStart > top
      ? `M ${left} ${top} H ${right} V ${frameStart} H ${startRight}`
      : `M ${startLeft} ${top} H ${startRight}`
  const lower =
    radiusY > 0 && bottom > arcTop
      ? `V ${arcTop} A ${radiusRight} ${radiusY} 0 0 1 ${innerRight - offset(bottom, radiusRight)} ${bottom} H ${innerLeft + offset(bottom, radiusLeft)} A ${radiusLeft} ${radiusY} 0 0 1 ${innerLeft + offset(arcTop, radiusLeft)} ${arcTop}`
      : `V ${bottom} H ${startLeft}`
  return `${path} ${lower} V ${frameStart}${frameStart > top ? ` H ${left}` : ''} Z`
}

/* Clip hidden cards out of the pinned chrome, and paint all visible panel
   shapes through one fixed material surface below the workspace content. */
export function useBoardPanelClipping() {
  const [pane, setPane] = useState<HTMLDivElement | null>(null)
  const materialRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const material = materialRef.current
    if (!pane || !material) return

    let frame = 0
    const painted = new Map<HTMLElement, Map<PaintProperty, StylePaint>>()
    const observed = new Set<Element>()
    const paneStyle = getComputedStyle(pane)
    const borderRight = Number.parseFloat(paneStyle.borderRightWidth) || 0
    const borderBottom = Number.parseFloat(paneStyle.borderBottomWidth) || 0

    const restore = (element: HTMLElement, properties: Map<PaintProperty, StylePaint>) => {
      for (const [property, entry] of properties) {
        if (element.style.getPropertyValue(property) !== entry.applied) continue
        if (entry.original) element.style.setProperty(property, entry.original)
        else element.style.removeProperty(property)
      }
    }
    const paint = (element: HTMLElement, property: PaintProperty, value: string) => {
      let properties = painted.get(element)
      if (!properties) {
        properties = new Map()
        painted.set(element, properties)
      }
      let entry = properties.get(property)
      if (!entry) {
        entry = { original: element.style.getPropertyValue(property), value: '', applied: '' }
        properties.set(property, entry)
      }
      if (entry.value !== value) {
        element.style.setProperty(property, value)
        entry.value = value
        entry.applied = element.style.getPropertyValue(property)
      }
    }
    const view = pane.closest('[data-workspace-view]')
    const update = () => {
      frame = 0
      const paneRect = pane.getBoundingClientRect()
      const viewportTop = paneRect.top + pane.clientTop
      const viewportLeft = paneRect.left + pane.clientLeft
      // The pane paints out to its padding edges, not to its client area: a
      // reserved scrollbar gutter and a transparent scrollbar track both show
      // the cards beneath them. The material has to reach as far as the cards
      // do, or a board cut off at the pane's edge stands on the bare photo
      // for the width of the gutter.
      const viewportRight = paneRect.right - borderRight
      const viewportBottom = paneRect.bottom - borderBottom
      // The shared status header is outside the body scrollport, so the
      // viewport itself keeps departing lanes below its header and gap.
      const pinLine = viewportTop
      const bounds: PaintBounds[] = []
      const paths: string[] = []

      for (const panel of pane.querySelectorAll<HTMLElement>('.board-lane, [data-board-group]')) {
        const body = panel.querySelector<HTMLElement>('.board-lane-body')
        const foot = panel.querySelector<HTMLElement>('[data-lane-foot]')
        if (!body || !foot) continue
        const heading = panel.querySelector<HTMLElement>('.board-panel-heading')
        const panelRect = panel.getBoundingClientRect()
        const bodyRect = body.getBoundingClientRect()
        const footRect = foot.getBoundingClientRect()
        const headingRect = heading?.getBoundingClientRect()
        const footStyle = getComputedStyle(foot)
        const footBorder = Number.parseFloat(footStyle.borderBottomWidth) || 0
        const headingBottom = Math.min(viewportBottom, footRect.top)
        const top = Math.max(pinLine, headingRect?.top ?? bodyRect.top)
        const bottom = Math.min(viewportBottom, footRect.bottom)
        const topRadius = Number.parseFloat(panel.style.borderTopLeftRadius) || 0
        const bottomRadius = Number.parseFloat(panel.style.borderBottomLeftRadius) || 0

        if (bottom > top && panelRect.right > viewportLeft && panelRect.left < viewportRight) {
          paths.push(
            panelPath(panelRect.left, top, panelRect.right, bottom, topRadius, bottomRadius),
          )
        }
        bounds.push({
          element: body,
          rect: bodyRect,
          top: Math.max(pinLine, headingRect?.bottom ?? pinLine),
          bottom: Math.min(viewportBottom, footRect.bottom - footBorder),
          lowerCurve: {
            left: panelRect.left,
            right: panelRect.right,
            bottom,
            frameTop: footRect.top,
            borderLeft: Number.parseFloat(footStyle.borderLeftWidth) || 0,
            borderRight: Number.parseFloat(footStyle.borderRightWidth) || 0,
            borderBottom: footBorder,
            radius: Math.max(0, Math.min(bottomRadius, panelRect.width / 2, (bottom - top) / 2)),
          },
        })
        bounds.push({ element: foot, rect: footRect, top: pinLine, bottom: viewportBottom })
        if (heading && headingRect) {
          bounds.push({ element: heading, rect: headingRect, top: pinLine, bottom: headingBottom })
        }
      }
      // The view enters with a short translation. Follow it only while its
      // animation runs; a portal does not inherit the view's transform.
      const entering = view?.getAnimations().some((animation) => animation.playState === 'running')

      // Finish all geometry reads before writes. Keep the rounded panel paths
      // intact and intersect them with the pane's rectangle on the same fixed
      // element, so horizontal scrolling does not invent new rounded edges.
      paint(
        material,
        'clip',
        `rect(${viewportTop}px, ${viewportRight}px, ${viewportBottom}px, ${viewportLeft}px)`,
      )
      paint(
        material,
        'clip-path',
        paths.length ? `path('${paths.join(' ')}')` : 'inset(0 0 100% 0)',
      )
      const present = new Set<HTMLElement>([material])
      for (const { element, rect, top, bottom, lowerCurve } of bounds) {
        present.add(element)
        const visibleTop = Math.min(rect.bottom, Math.max(rect.top, top))
        const visibleBottom = Math.min(rect.bottom, Math.max(visibleTop, bottom))
        const clipTop = `${visibleTop - rect.top}px`
        const clipBottom = `${rect.bottom - visibleBottom}px`
        const clip =
          lowerCurve && visibleBottom > visibleTop
            ? `path('${bodyPath(
                lowerCurve.left - rect.left,
                visibleTop - rect.top,
                lowerCurve.right - rect.left,
                visibleBottom - rect.top,
                lowerCurve.bottom - rect.top,
                lowerCurve.radius,
                lowerCurve.frameTop - rect.top,
                lowerCurve.borderLeft,
                lowerCurve.borderRight,
                lowerCurve.borderBottom,
              )}')`
            : `inset(${clipTop} 0px ${clipBottom} 0px)`
        paint(element, 'clip-path', clip)
      }
      for (const [element, entry] of painted) {
        if (!present.has(element)) {
          restore(element, entry)
          painted.delete(element)
        }
      }
      if (entering) schedule()
    }

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    const onViewAnimation = (event: Event) => {
      if (event.target === view) schedule()
    }
    const resizeObserver = new ResizeObserver(schedule)
    const syncObserved = () => {
      const next = new Set<Element>([
        pane,
        ...pane.querySelectorAll('.board-panel-heading, .board-lane-body, [data-lane-foot]'),
      ])
      for (const element of observed) {
        if (!next.has(element)) {
          resizeObserver.unobserve(element)
          observed.delete(element)
        }
      }
      for (const element of next) {
        if (!observed.has(element)) {
          resizeObserver.observe(element)
          observed.add(element)
        }
      }
    }
    // Groups can appear or disappear after filters, scope changes or live
    // updates. Attribute changes are excluded so our own clips do not loop.
    const mutationObserver = new MutationObserver(() => {
      syncObserved()
      schedule()
    })
    mutationObserver.observe(pane, { childList: true, subtree: true })
    pane.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    view?.addEventListener('animationstart', onViewAnimation)
    view?.addEventListener('animationend', onViewAnimation)
    view?.addEventListener('animationcancel', onViewAnimation)
    syncObserved()
    update()

    return () => {
      if (frame) cancelAnimationFrame(frame)
      pane.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      view?.removeEventListener('animationstart', onViewAnimation)
      view?.removeEventListener('animationend', onViewAnimation)
      view?.removeEventListener('animationcancel', onViewAnimation)
      mutationObserver.disconnect()
      resizeObserver.disconnect()
      for (const [element, entry] of painted) restore(element, entry)
    }
  }, [pane])

  return { paneRef: setPane, materialRef }
}
