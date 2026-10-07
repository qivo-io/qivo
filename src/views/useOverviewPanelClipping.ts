import { useLayoutEffect, useState } from 'react'

type PaintProperty = 'clip-path' | '--overview-panel-clip'
type ClipStyle = { original: string; priority: string; applied: string }
type ClipUpdate = { element: HTMLElement; property: PaintProperty; value: string | null }

/* Each section keeps its own panel material. Cut material and scrolling rows
   to the sticky rounded border, leaving no empty strip inside the panel. */
export function useOverviewPanelClipping(enabled: boolean) {
  const [pane, setPane] = useState<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    if (!enabled || !pane) return

    let frame = 0
    const painted = new Map<HTMLElement, Map<PaintProperty, ClipStyle>>()
    const observed = new Set<Element>()
    const view = pane.closest('[data-workspace-view]')

    const restore = (element: HTMLElement, property: PaintProperty) => {
      const properties = painted.get(element)
      const entry = properties?.get(property)
      if (!entry) return
      if (element.style.getPropertyValue(property) === entry.applied) {
        if (entry.original) {
          element.style.setProperty(property, entry.original, entry.priority)
        } else {
          element.style.removeProperty(property)
        }
      }
      properties.delete(property)
      if (!properties.size) painted.delete(element)
    }
    const paint = (element: HTMLElement, property: PaintProperty, value: string | null) => {
      if (value === null) {
        restore(element, property)
        return
      }
      let properties = painted.get(element)
      if (!properties) {
        properties = new Map()
        painted.set(element, properties)
      }
      let entry = properties.get(property)
      if (!entry) {
        entry = {
          original: element.style.getPropertyValue(property),
          priority: element.style.getPropertyPriority(property),
          applied: '',
        }
        properties.set(property, entry)
      }
      if (element.style.getPropertyValue(property) !== value) {
        element.style.setProperty(property, value)
      }
      entry.applied = element.style.getPropertyValue(property)
    }

    const update = () => {
      frame = 0
      const paneRect = pane.getBoundingClientRect()
      const viewportTop = paneRect.top + pane.clientTop
      const viewportBottom = viewportTop + pane.clientHeight
      const updates: ClipUpdate[] = []

      for (const panel of pane.querySelectorAll<HTMLElement>('.overview-section')) {
        const body = panel.querySelector<HTMLElement>(':scope > .overview-section-body')
        const foot = panel.querySelector<HTMLElement>(':scope > .overview-section-foot')
        if (!body || !foot) continue

        const panelRect = panel.getBoundingClientRect()
        const bodyRect = body.getBoundingClientRect()
        const footRect = foot.getBoundingClientRect()
        const bottom = Math.min(panelRect.bottom, footRect.bottom, viewportBottom)
        const visible = bottom > Math.max(panelRect.top, viewportTop)
        const panelClip = Math.max(0, panelRect.bottom - Math.max(panelRect.top, bottom))
        const bodyBottom = Math.max(bodyRect.top, Math.min(bodyRect.bottom, bottom - 1))
        const bodyClip = Math.max(0, bodyRect.bottom - bodyBottom)

        updates.push({
          element: panel,
          property: 'clip-path',
          value: !visible
            ? 'inset(0 0 100% 0)'
            : panelClip > 0
              ? `inset(0px 0px ${panelClip}px 0px round 12px)`
              : null,
        })
        updates.push({
          element: panel,
          property: '--overview-panel-clip',
          value: panelClip > 0 ? `${panelClip}px` : null,
        })
        updates.push({
          element: body,
          property: 'clip-path',
          value: bodyClip > 0 ? `inset(0px 0px ${bodyClip}px 0px)` : null,
        })
      }
      const entering = view?.getAnimations().some((animation) => animation.playState === 'running')

      // Geometry is read before any clips are changed. Fully visible sections
      // keep their shadow without an extra clipping surface.
      const present = new Set<HTMLElement>()
      for (const { element, property, value } of updates) {
        present.add(element)
        paint(element, property, value)
      }
      for (const [element, properties] of painted) {
        if (!present.has(element)) {
          for (const property of properties.keys()) restore(element, property)
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
        ...pane.children,
        ...pane.querySelectorAll(
          '.overview-section, .overview-section-body, .overview-section-foot',
        ),
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
    // Live task changes can add sections or move their natural edges. Ignore
    // attributes so the clips themselves never trigger another measurement.
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
      for (const [element, properties] of painted) {
        for (const property of properties.keys()) restore(element, property)
      }
    }
  }, [enabled, pane])

  return { paneRef: setPane }
}
