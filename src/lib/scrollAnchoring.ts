/** Whether the browser keeps a scroller's reading position itself when
    content above it goes (CSS scroll anchoring). Chromium, so the desktop
    app, and Firefox do; where it does not, as in Safari, the Overview's
    lists (views/Overview.tsx OvList) and the Milestones window's sections
    (panels/Modals.tsx MilestoneSectionPart) keep their place by hand when
    their first rows leave. */
export const SCROLL_ANCHORING =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('overflow-anchor', 'auto')
