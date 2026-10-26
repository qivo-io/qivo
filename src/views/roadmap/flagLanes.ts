/* Where the Roadmap header draws each milestone flag. A label is one line
   that never wraps, so no word breaks across lines. It runs right from its
   diamond, or left when the timeline ends first, until the next flag in its
   row. A flag takes the lowest row where its whole label fits. When none
   does, it opens a new row, up to the rows the header has room for, and
   after that shares the row that leaves the most room, which cuts the
   labels there short with an ellipsis. Flags of one week never share a row,
   so every diamond stays its own target: a week with more milestones than
   the header has room for gets a row each, and the band scrolls
   (FlagBand in TimelineMarks.tsx). The band is always at least two rows
   tall, the height it had before flags took rows. While it scrolls, a
   dragged flag keeps to the rows in sight, the layout counts the flags out
   of sight for the band's "+N more" signs, and labels end before a
   scrollbar that takes space. Rows and sides still come from the whole
   timeline, so a scrollbar never moves a flag, at most cuts a name short. */

/** Height of one row of flags, diamond and one line of label. */
export const FLAG_LANE_H = 16
/** The band's rows when nothing needs more, and its padding. */
const BASE_LANES = 2
const BAND_PAD = 4
/** The diamond's box, centred on its week's line. */
const DIAMOND_W = 9
const HALF = DIAMOND_W / 2
/** The label's gap to its diamond and its padding at the far end. */
const LABEL_CHROME_W = 8 + 4
/** Space kept between a label's end and the next flag in its row. */
const LABEL_GAP = 6
/** Space kept between two labels that run towards each other. */
const FACING_GAP = 20
/** The widest a flag grows, diamond and label, however much room it has. */
export const FLAG_LABEL_MAX_W = 200
/** The label's font size, var(--fs-2xs). */
const FONT_PX = 11

type Flag = {
  id: string
  /** The week the milestone is saved in, which picks its row. */
  week: number
  name: string
  /** The week a drag holds it in now, if that differs. */
  live?: number
}
export type FlagSide = 'right' | 'left'
export type FlagPlace = {
  /** Row from the bottom of the band, 0 first. */
  lane: number
  /** The side of its diamond the label runs to. */
  side: FlagSide
  /** The widest the flag may be, diamond and label, in pixels. */
  room: number
  /** The flag's offset from the band's bottom edge, in pixels. */
  bottom: number
}
type Grid = { w0: number; weekW: number; end: number }
/** What a scrolling band shows: its rows `lo` to `hi` whole, and `bar`
    pixels at its right edge that its scrollbar takes, 0 where scrollbars
    overlay the content. */
export type FlagView = { lo: number; hi: number; bar: number }
/** A flag at the week it is drawn in, with its label's full width. */
type Item = { id: string; week: number; x: number; side: FlagSide; label: number }

/** An estimate of `name`'s width in the label font (Instrument Sans 600 at
    11 px), within about 5% for ordinary names. It only chooses rows and
    sides: the label itself still ends in an ellipsis if it is wider than
    its room. */
export function labelWidth(name: string): number {
  let em = 0
  for (const c of name) {
    if (c === ' ') em += 0.27
    else if (c === 'W' || c === 'M') em += 0.9
    else if (/[A-Z0-9]/.test(c)) em += 0.64
    else if (/[iljtf.,'’-]/.test(c)) em += 0.3
    else em += 0.55
  }
  return em * FONT_PX
}

/** The band's height for `lanes` rows of flags. */
export function flagBandHeight(lanes: number): number {
  return BAND_PAD + Math.max(BASE_LANES, lanes) * FLAG_LANE_H
}

/** The offset of `lane`'s bottom edge from the bottom of `lanes` rows. */
const laneBottom = (lanes: number, lane: number) =>
  (flagBandHeight(lanes) - lanes * FLAG_LANE_H) / 2 + lane * FLAG_LANE_H

/** The rows of `lanes` that a band `height` pixels tall shows whole, give
    or take a pixel, when it is scrolled `from` pixels up from their bottom
    edge. */
export function flagLanesShown(
  lanes: number,
  from: number,
  height: number,
): Pick<FlagView, 'lo' | 'hi'> {
  const pad = laneBottom(lanes, 0)
  return {
    lo: Math.max(0, Math.ceil((from - 1 - pad) / FLAG_LANE_H)),
    hi: Math.min(lanes - 1, Math.floor((from + height + 1 - pad) / FLAG_LANE_H) - 1),
  }
}

/** The rows of flags a band of `px` pixels shows, never fewer than two. */
export function flagLanesIn(px: number): number {
  return Math.max(BASE_LANES, Math.floor((px - BAND_PAD) / FLAG_LANE_H))
}

/** `flag` drawn at `week`: its label runs right unless the timeline ends
    before the label does and the left has more room. */
function itemAt(flag: Flag, week: number, { w0, weekW, end }: Grid): Item {
  const x = (week - w0) * weekW
  const label = Math.min(FLAG_LABEL_MAX_W, DIAMOND_W + LABEL_CHROME_W + labelWidth(flag.name))
  const right = end - x - HALF
  const left = x - HALF
  const side = label - DIAMOND_W <= right || right >= left ? 'right' : 'left'
  return { id: flag.id, week, x, side, label: label - DIAMOND_W }
}

/** The gap two neighbours in a row keep, `a` before `b`. Two labels that
    run towards each other keep a wider one, so neither name reads as the
    other diamond's. */
const gapOf = (a: Item, b: Item) =>
  a.side === 'right' && b.side === 'left' ? FACING_GAP : LABEL_GAP

/** How two neighbours in a row, `a` before `b`, split the space between
    their diamonds: each label that runs into it gets its full width and
    half of what is left when both fit, else the shorter keeps its width up
    to half. */
function share(a: Item, b: Item): { a: number; b: number } {
  const space = Math.max(0, b.x - a.x - DIAMOND_W - gapOf(a, b))
  const wa = a.side === 'right' ? a.label : 0
  const wb = b.side === 'left' ? b.label : 0
  if (!wb) return { a: space, b: 0 }
  if (!wa) return { a: 0, b: space }
  if (wa + wb <= space) {
    const spare = (space - wa - wb) / 2
    return { a: wa + spare, b: wb + spare }
  }
  const half = space / 2
  if (wa <= half) return { a: wa, b: space - wa }
  if (wb <= half) return { a: space - wb, b: wb }
  return { a: half, b: half }
}

/** The space `b` leaves after `a` in a row, negative when their labels
    would meet. */
const slack = (a: Item, b: Item) =>
  b.x -
  a.x -
  DIAMOND_W -
  gapOf(a, b) -
  (a.side === 'right' ? a.label : 0) -
  (b.side === 'left' ? b.label : 0)

/** The room for `label`, at most the widest flag. */
const roomFor = (label: number) =>
  DIAMOND_W + Math.max(0, Math.min(FLAG_LABEL_MAX_W - DIAMOND_W, label))

/** Each flag's row, side and room, for flags on a grid that starts at week
    `w0` with `weekW` pixels a week and ends `end` pixels in. Labels open at
    most `maxLanes` rows; only a week with more flags opens more. Rows come
    from the saved weeks, so a flag being dragged moves alone: the others
    keep their places and the band its height until the drop. In a band
    that scrolls, `view` is what it shows: a dragged flag stays in the rows
    in sight, `above` and `below` count the flags in the rows above and
    below them, and no label runs under the scrollbar. Answers the rows used
    too, at least one. */
export function layoutFlags(
  flags: Flag[],
  grid: Grid & { maxLanes: number; view?: FlagView | null },
): { lanes: number; places: Map<string, FlagPlace>; above: number; below: number } {
  const sorted = flags
    .slice()
    .sort((a, b) => a.week - b.week || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const rows: Item[][] = []
  for (const flag of sorted) {
    const it = itemAt(flag, flag.week, grid)
    // the rows whose last flag is in another week, the only ones it may join
    const open = rows.flatMap((row, lane) => {
      const last = row[row.length - 1]
      return last.week === it.week ? [] : [{ lane, room: slack(last, it) }]
    })
    const fits = open.find((r) => r.room >= 0)
    const lane = fits
      ? fits.lane
      : rows.length < grid.maxLanes || open.length === 0
        ? rows.length
        : open.reduce((a, b) => (b.room > a.room ? b : a)).lane
    rows[lane] = [...(rows[lane] ?? []), it]
  }
  const lanes = Math.max(1, rows.length)
  const bottom = (lane: number) => laneBottom(lanes, lane)
  const { view } = grid
  const inSight = (lane: number) => !view || (lane >= view.lo && lane <= view.hi)
  // where a label must end, short of the band's scrollbar
  const shownEnd = grid.end - (view?.bar ?? 0)
  const places = new Map<string, FlagPlace>()
  // A label may take all the room it has, as the estimate can fall short of
  // the drawn name; the flag stays as wide as the name it shows. Each row
  // keeps the boxes its names take, where a dragged flag must not land.
  const boxes = rows.map((row, lane) =>
    row.map((it, i) => {
      const label =
        it.side === 'right'
          ? i < row.length - 1
            ? share(it, row[i + 1]).a
            : shownEnd - it.x - HALF
          : i > 0
            ? share(row[i - 1], it).b
            : it.x - HALF
      const room = roomFor(label)
      places.set(it.id, { lane, side: it.side, room, bottom: bottom(lane) })
      const shown = Math.min(room, DIAMOND_W + it.label)
      const from = it.side === 'right' ? it.x - HALF : it.x + HALF - shown
      return { id: it.id, from, to: from + shown }
    }),
  )
  for (const flag of sorted) {
    if (flag.live === undefined || flag.live === flag.week) continue
    const it = itemAt(flag, flag.live, grid)
    let best: FlagPlace | null = null
    for (const [lane, row] of boxes.entries()) {
      if (!inSight(lane)) continue
      const others = row.filter((b) => b.id !== flag.id)
      // its diamond must land clear of every other flag in the row
      const lo = it.x - HALF - LABEL_GAP
      const hi = it.x + HALF + LABEL_GAP
      if (others.some((b) => b.to > lo && b.from < hi)) continue
      // the label runs to the nearest flag on its side, or the edge
      const after = others.filter((b) => b.from >= hi).map((b) => b.from - LABEL_GAP)
      const before = others.filter((b) => b.to <= lo).map((b) => b.to + LABEL_GAP)
      const room = roomFor(
        it.side === 'right'
          ? Math.min(shownEnd, ...after) - (it.x + HALF)
          : it.x - HALF - Math.max(0, ...before),
      )
      // the lowest row where the whole name fits, else the one with most room
      const fits = (p: FlagPlace | null) => !!p && p.room >= DIAMOND_W + it.label
      if (!best || (!fits(best) && room > best.room))
        best = { lane, side: it.side, room, bottom: bottom(lane) }
    }
    // no row in sight has room for its diamond: it passes over the others
    // in its own, the row it was pressed in
    const own = places.get(flag.id)
    const edge = it.side === 'right' ? shownEnd - it.x - HALF : it.x - HALF
    if (best) places.set(flag.id, best)
    else if (own) places.set(flag.id, { ...own, side: it.side, room: roomFor(edge) })
  }
  const lanesOf = [...places.values()].map((p) => p.lane)
  return {
    lanes,
    places,
    above: view ? lanesOf.filter((lane) => lane > view.hi).length : 0,
    below: view ? lanesOf.filter((lane) => lane < view.lo).length : 0,
  }
}
