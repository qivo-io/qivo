/** Whether the browser says it keeps a scroller's reading position itself
    when content above it goes (CSS scroll anchoring). Chromium, so the
    desktop app, Firefox and WebKit 26.6 say so; where a browser does not, the
    Overview's lists (views/Overview.tsx OvList) and the Milestones window's
    sections (panels/Modals.tsx MilestoneSectionPart) keep their place by
    hand when their first rows leave. WebKit's answer does not hold for every
    change: it lost the task window's place when many rows above went, so
    that window keeps its place by hand in every browser
    (panels/IssueDetail.tsx). Whether the Overview's and the Milestones
    window's place holds in WebKit has not been checked. */
export const SCROLL_ANCHORING =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('overflow-anchor', 'auto')
