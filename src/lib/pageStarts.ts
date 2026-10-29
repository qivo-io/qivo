/* The starts of the pages a list with Previous and Next walked to, the page
   on screen last, for Previous: null for the first page, then each page's
   next_cursor (main Search's palette, panels/Palette.tsx). The stack keeps
   PAGE_STARTS.most starts and drops the oldest past them, so Previous stops
   at the oldest page still held, and the retained starts stay bounded
   however far the list goes. */

/** How many page starts a list keeps (`most`). Tests lower it. */
export const PAGE_STARTS = { most: 1000 }

/** `starts` with `cursor`, the start of the next page, after them, less
    the oldest past PAGE_STARTS.most. */
export const withStart = (
  starts: readonly (string | null)[],
  cursor: string,
): (string | null)[] => [...starts, cursor].slice(-PAGE_STARTS.most)
