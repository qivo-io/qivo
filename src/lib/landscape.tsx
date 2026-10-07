import { createContext } from 'react'

/** The logical viewport inside the phone's landscape planning layer. */
export type LandscapeViewport = {
  host: HTMLElement | null
  rotated: boolean
  width: number
  height: number
  toLocal: (x: number, y: number) => { x: number; y: number }
}

export const LandscapeContext = createContext<LandscapeViewport | null>(null)

/** Navigation keeps phone Back behavior while this layer spans a wide screen. */
export function isLandscapeRoadmapOpen() {
  return !!document.querySelector('[data-roadmap-landscape]')
}
