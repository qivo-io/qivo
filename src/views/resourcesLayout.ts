/* The sizes of the Roadmap's team heatmap (Resources.tsx), which the Roadmap
   reads to give the strip its height. */

/** The strip's header height. */
export const STRIP_HEAD_H = 48
// One line per person: a 40px row plus its divider.
export const STRIP_ROW_H = 41

// Header, body's top rule, rows and panel borders.
export function stripHeight(n: number) {
  return STRIP_HEAD_H + 1 + (n ? n * STRIP_ROW_H : 38) + 2
}
