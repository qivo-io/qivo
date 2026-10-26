/* Where the Roadmap header draws each milestone flag. A label is one line
   that never wraps, so no word breaks across lines, and it runs right from
   its diamond until the next flag in the same row. A flag takes the lowest
   row whose label before it ends in time. When none does, it opens a new
   row, up to MAX_LANES, and after that takes the row whose label ends
   soonest, which cuts that label short with an ellipsis. Flags of one
   week never share a row, so every diamond stays its own target, and a week
   with more milestones than MAX_LANES gets a row each. The band is always at
   least two rows tall, the height it had before flags took rows. */

/** Height of one row of flags, diamond and one line of label. */
export const FLAG_LANE_H = 16
/** The band's rows when nothing needs more, and its padding. */
const BASE_LANES = 2
const BAND_PAD = 4
/** The most rows that labels alone may open. */
const MAX_LANES = 4
/** Diamond, its gap to the label and the label's own right padding. */
const FLAG_CHROME_W = 9 + 8 + 4
/** Space kept between a label's end and the next diamond in its row. */
const LABEL_GAP = 6
/** The widest a label grows, however far the next flag in its row is. */
export const FLAG_LABEL_MAX_W = 200
/** The label's font size, var(--fs-2xs). */
const FONT_PX = 11

type Flag = { id: string; week: number; name: string }
export type FlagPlace = {
  /** Row from the bottom of the band, 0 first. */
  lane: number
  /** Width the label may take, in pixels. */
  room: number
}

/** An estimate of `name`'s width in the label font (Instrument Sans 600 at
    11 px), within about 5% for ordinary names. It only chooses rows: the
    label itself still ends in an ellipsis if it is wider than its room. */
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

/** Each flag's row and label room, for flags at `week` on a grid that
    starts at `w0` with `weekW` pixels a week and ends `end` pixels in.
    Answers the rows used too, at least one. */
export function layoutFlags(
  flags: Flag[],
  { w0, weekW, end }: { w0: number; weekW: number; end: number },
): { lanes: number; places: Map<string, FlagPlace> } {
  const xOf = (f: Flag) => (f.week - w0) * weekW
  const sorted = flags
    .slice()
    .sort((a, b) => a.week - b.week || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  // the last flag of each row, and where its label would end
  const last: { flag: Flag; ends: number }[] = []
  const lanes = new Map<string, number>()
  const next = new Map<string, Flag>()
  for (const f of sorted) {
    const x = xOf(f)
    const open = last.map((l, lane) => ({ ...l, lane })).filter((l) => l.flag.week !== f.week)
    const free = open.find((l) => l.ends + LABEL_GAP <= x)
    let lane: number
    if (free) lane = free.lane
    else if (last.length < MAX_LANES || open.length === 0) lane = last.length
    else lane = open.reduce((a, b) => (b.ends < a.ends ? b : a)).lane
    if (last[lane]) next.set(last[lane].flag.id, f)
    const wants = Math.min(FLAG_LABEL_MAX_W, FLAG_CHROME_W + labelWidth(f.name))
    last[lane] = { flag: f, ends: x + wants }
    lanes.set(f.id, lane)
  }
  const places = new Map<string, FlagPlace>()
  for (const f of sorted) {
    const x = xOf(f)
    const after = next.get(f.id)
    const until = after ? xOf(after) - LABEL_GAP : end
    places.set(f.id, {
      lane: lanes.get(f.id) ?? 0,
      room: Math.max(0, Math.min(FLAG_LABEL_MAX_W, until - x)),
    })
  }
  return { lanes: Math.max(1, last.length), places }
}
