import { describe, expect, it } from 'vitest'
import {
  FLAG_LABEL_MAX_W,
  FLAG_LANE_H,
  flagBandHeight,
  flagLanesShown,
  labelWidth,
  layoutFlags,
  layoutTrackFlags,
  TRACK_FLAG_LANES,
  TRACK_FLAGS_H,
} from './flagLanes'
import { ROW_H } from './layout'

/* The Roadmap header's milestone flags: no two flags of one week share a
   row, no label runs into the next flag of its row, a label near the
   timeline's end runs left, labels open rows up to what the header has
   room for, and a drag moves only the dragged flag, within the rows a
   scrolled band shows. */

const WEEK_W = 48
const grid: Parameters<typeof layoutFlags>[1] = {
  w0: 0,
  weekW: WEEK_W,
  end: 20 * WEEK_W,
  maxLanes: 4,
}
const flag = (id: string, week: number, name = id) => ({ id, week, name })
const place = (flags: Parameters<typeof layoutFlags>[0], over: Partial<typeof grid> = {}) =>
  layoutFlags(flags, { ...grid, ...over })
/** The width `name`'s flag wants, diamond and label. */
const wants = (name: string) => Math.min(FLAG_LABEL_MAX_W, 9 + 12 + labelWidth(name))
/** Each flag's box, [from, to] in pixels, by row. */
function boxes(flags: ReturnType<typeof flag>[], over: Partial<typeof grid> = {}) {
  const { places } = place(flags, over)
  const rows = new Map<number, [number, number][]>()
  for (const f of flags) {
    const p = places.get(f.id)
    if (!p) throw new Error(`no place for ${f.id}`)
    const x = (f.week - grid.w0) * WEEK_W
    const from = p.side === 'right' ? x - 4.5 : x + 4.5 - p.room
    rows.set(p.lane, [...(rows.get(p.lane) ?? []), [from, from + p.room]])
  }
  return [...rows.values()].map((row) => row.sort((a, b) => a[0] - b[0]))
}

describe('layoutFlags', () => {
  it('puts the milestones of one week in rows of their own', () => {
    const { lanes, places } = place([flag('a', 3, 'Cloud beta ready'), flag('b', 3, 'Pilot batch')])
    expect(new Set([places.get('a')?.lane, places.get('b')?.lane]).size).toBe(2)
    expect(lanes).toBe(2)
    expect(flagBandHeight(lanes)).toBe(flagBandHeight(1))
  })

  it('gives each of three in one week a row, and the band a third row', () => {
    const { lanes, places } = place([flag('a', 3), flag('b', 3), flag('c', 3)])
    expect([...places.values()].map((p) => p.lane).sort()).toEqual([0, 1, 2])
    expect(flagBandHeight(lanes)).toBeGreaterThan(flagBandHeight(2))
  })

  it('gives a row to each of more same-week milestones than the header shows', () => {
    const week = Array.from({ length: 6 }, (_, i) => flag(`m${i}`, 4))
    const { lanes, places } = place(week, { maxLanes: 2 })
    expect(lanes).toBe(6)
    expect(new Set([...places.values()].map((p) => p.lane)).size).toBe(6)
  })

  it('keeps flags far apart in the bottom row, each with room for its name', () => {
    const { lanes, places } = place([flag('a', 1, 'Revision B ready'), flag('b', 6, 'Launch')])
    expect(lanes).toBe(1)
    // all the room to the next flag, as a drawn name can outrun its estimate
    expect(places.get('a')).toEqual({ lane: 0, side: 'right', room: FLAG_LABEL_MAX_W, bottom: 10 })
    expect(places.get('b')?.room).toBeGreaterThanOrEqual(wants('Launch'))
  })

  it('moves a close neighbour up a row rather than cutting the label before it', () => {
    const name = 'Dashboard ready for feedback'
    const { places } = place([flag('a', 2, name), flag('b', 3, 'Prototype validated')])
    expect(places.get('b')?.lane).toBe(1)
    expect(places.get('a')?.room).toBeGreaterThanOrEqual(wants(name))
  })

  it('never lets a label run into the next flag of its row', () => {
    const weekly = Array.from({ length: 20 }, (_, i) => flag(`w${i}`, i, 'Prototype validated'))
    for (const row of boxes(weekly))
      for (let i = 1; i < row.length; i++) expect(row[i - 1][1]).toBeLessThan(row[i][0])
  })

  it('opens the rows a dense stretch needs, so every name fits', () => {
    // two milestones a week for eight weeks, each name about three weeks wide
    const dense = Array.from({ length: 16 }, (_, i) =>
      flag(`d${i}`, i >> 1, `Regulatory submission ${i}`),
    )
    const { lanes, places } = place(dense, { maxLanes: 8 })
    expect(lanes).toBeGreaterThan(4)
    for (const f of dense) expect(places.get(f.id)?.room).toBeGreaterThanOrEqual(wants(f.name))
  })

  it('opens no more rows than the header shows, and shortens names instead', () => {
    const long = 'Regulatory submission package'
    const flags = [0, 1, 2, 3].map((w) => flag(`l${w}`, w, long))
    const { lanes, places } = place([...flags, flag('e', 3, 'Wrap-up')], { maxLanes: 2 })
    expect(lanes).toBe(2)
    // week 3's second flag shares a row with week 2's or week 1's, not week 3's
    expect(places.get('e')?.lane).not.toBe(places.get('l3')?.lane)
    expect(Math.min(...[...places.values()].map((p) => p.room))).toBeLessThan(wants(long))
  })

  it('runs a label left when the timeline ends before it would', () => {
    const name = 'Pilot launch review'
    const { places } = place([flag('a', 19, name), flag('b', 10, name)])
    expect(places.get('a')).toMatchObject({ side: 'left' })
    expect(places.get('a')?.room).toBeGreaterThanOrEqual(wants(name))
    expect(places.get('b')).toMatchObject({ side: 'right' })
  })

  it('keeps two names that run towards each other well apart', () => {
    // a name keeps 8 px from its own diamond, so more than twice that
    // between two names tells which diamond each belongs to
    const flags = [flag('a', 13, 'Customer acceptance'), flag('b', 19, 'Pilot launch review')]
    const [row, ...rest] = boxes(flags)
    expect(rest).toEqual([])
    expect(row[1][0] - row[0][1]).toBeGreaterThan(16)
  })

  it('stops a long name at the widest label', () => {
    const { places } = place([flag('a', 0, 'Customer acceptance and handover to operations')])
    expect(places.get('a')?.room).toBe(FLAG_LABEL_MAX_W)
  })

  it('moves only the dragged flag, and keeps the band height, while it passes others', () => {
    const still = [flag('beta', 3, 'Beta'), flag('gamma', 3, 'Gamma')]
    const before = place([flag('alpha', 1, 'Alpha'), ...still])
    for (const live of [1, 2, 3, 4, 5]) {
      const during = place([{ ...flag('alpha', 1, 'Alpha'), live }, ...still])
      expect(during.lanes).toBe(before.lanes)
      expect(during.places.get('beta')).toEqual(before.places.get('beta'))
      expect(during.places.get('gamma')).toEqual(before.places.get('gamma'))
    }
  })

  it('puts a dragged flag in the lowest row where its diamond is clear of the others', () => {
    // Beta takes row 0 and Go row 1; at week 4 Alpha is clear only of Go,
    // as Beta's label runs past week 4's line, and at week 12 of both
    const still = [flag('beta', 3, 'Beta, the long name'), flag('go', 3, 'Go')]
    const at = (live: number) =>
      place([{ ...flag('alpha', 1, 'Alpha'), live }, ...still]).places.get('alpha')
    expect(at(4)).toMatchObject({ lane: 1, side: 'right' })
    expect(at(4)?.room).toBeGreaterThanOrEqual(wants('Alpha'))
    expect(at(12)?.lane).toBe(0)
  })

  it('keeps a dragged flag in the rows a scrolled band shows', () => {
    // six in week 4 and two rows in sight, scrolled up to the top two
    const week = Array.from({ length: 6 }, (_, i) => flag(`m${i}`, 4))
    const top = flagLanesShown(6, flagBandHeight(6) - flagBandHeight(2), flagBandHeight(2))
    expect(top).toEqual({ lo: 4, hi: 5 })
    const view = { ...top, bar: 0 }
    const at = (live: number) =>
      place([...week.slice(0, 5), { ...week[5], live }], { maxLanes: 2, view }).places.get('m5')
    expect(at(4)?.lane).toBe(5)
    // every row is clear at week 8, and row 4 is the lowest in sight
    expect(at(8)?.lane).toBe(4)
    expect(
      place([{ ...week[5], live: 8 }, ...week.slice(0, 5)], { maxLanes: 2 }).places.get('m5')?.lane,
    ).toBe(0)
  })

  it('counts the flags in the rows above and below those a scrolled band shows', () => {
    const week = Array.from({ length: 6 }, (_, i) => flag(`m${i}`, 4))
    const counts = (view: Parameters<typeof layoutFlags>[1]['view']) => {
      const { above, below } = place(week, { maxLanes: 2, view })
      return [above, below]
    }
    expect(counts(null)).toEqual([0, 0])
    expect(counts({ ...flagLanesShown(6, 0, flagBandHeight(2)), bar: 0 })).toEqual([4, 0])
    expect(counts({ lo: 2, hi: 3, bar: 0 })).toEqual([2, 2])
  })

  it("ends a label before the band's scrollbar without moving its flag", () => {
    // the name fits to the timeline's end, but not with 10 px less
    const name = 'Pilot review'
    const end = 18 * WEEK_W + 4.5 + 12 + labelWidth(name) + 5
    const at = (bar: number) =>
      place([flag('a', 18, name)], { end, view: { lo: 0, hi: 1, bar } }).places.get('a')
    expect(at(10)).toMatchObject({ lane: 0, side: 'right' })
    expect(at(10)?.room).toBe((at(0)?.room ?? 0) - 10)
  })
})

describe('flagLanesShown', () => {
  it('names the rows a band shows whole, not those it cuts', () => {
    const band = flagBandHeight(2)
    expect(flagLanesShown(6, 0, band)).toEqual({ lo: 0, hi: 1 })
    // half a row up: row 0 is cut at the bottom and row 2 at the top
    expect(flagLanesShown(6, 8, band)).toEqual({ lo: 1, hi: 1 })
    expect(flagLanesShown(6, 2 * 16, band)).toEqual({ lo: 2, hi: 3 })
    expect(flagLanesShown(3, 0, flagBandHeight(3))).toEqual({ lo: 0, hi: 2 })
  })
})

/* My view's flags on a track row: the rows of flags its height holds,
   names cut short rather than run into the next flag, every flag of a
   crowded week in sight, apart and drawn so each keeps a strip to point
   at, and a drag that moves one flag alone. */
describe('layoutTrackFlags', () => {
  const row = { w0: 0, weekW: WEEK_W, end: 20 * WEEK_W }
  type TrackFlag = Parameters<typeof layoutTrackFlags>[0][number]
  /** Each flag's box, diamond and label at its room, [from, to] in pixels,
      by row and sorted, from the places layoutTrackFlags gives, at the week
      each is drawn in. */
  const trackBoxes = (flags: TrackFlag[], g = row) => {
    const places = layoutTrackFlags(flags, g)
    const rows = new Map<number, [number, number][]>()
    for (const f of flags) {
      const p = places.get(f.id)
      if (!p) throw new Error(`no place for ${f.id}`)
      const x = ((f.live ?? f.week) - g.w0) * g.weekW + (p.shift ?? 0)
      const from = p.side === 'right' ? x - 4.5 : x + 4.5 - p.room
      rows.set(p.lane, [...(rows.get(p.lane) ?? []), [from, from + p.room]])
    }
    return [...rows.values()].map((lane) => lane.sort((a, b) => a[0] - b[0]))
  }
  /** How much of `box` none of `over` covers, in pixels. */
  const uncovered = (box: [number, number], over: [number, number][]) => {
    let free = [box]
    for (const [a, b] of over)
      free = free.flatMap(([s, e]) => {
        const left: [number, number] = [s, Math.min(e, a)]
        const right: [number, number] = [Math.max(s, b), e]
        return [left, right].filter(([x, y]) => y > x)
      })
    return free.reduce((sum, [s, e]) => sum + e - s, 0)
  }
  /** Each flag's diamond box, [from, to] in pixels, and its bottom. */
  const diamonds = (flags: ReturnType<typeof flag>[], over: Partial<typeof row> = {}) => {
    const g = { ...row, ...over }
    const places = layoutTrackFlags(flags, g)
    return flags.map((f) => {
      const p = places.get(f.id)
      if (!p) throw new Error(`no place for ${f.id}`)
      const x = (f.week - g.w0) * g.weekW + (p.shift ?? 0)
      return { id: f.id, from: x - 4.5, to: x + 4.5, bottom: p.bottom, lane: p.lane, room: p.room }
    })
  }

  it('holds the two rows of flags a track row has room for', () => {
    expect(TRACK_FLAG_LANES).toBe(2)
    expect(TRACK_FLAGS_H).toBeLessThanOrEqual(ROW_H.track)
    // must fail: a third row would not fit the row
    expect(flagBandHeight(TRACK_FLAG_LANES + 1)).toBeGreaterThan(ROW_H.track)
  })

  it('puts two long names of neighbouring weeks in two rows, each whole', () => {
    const a = 'Supplier contract review signed off'
    const b = 'Pilot batch ready for the field test'
    const places = layoutTrackFlags([flag('a', 3, a), flag('b', 4, b)], row)
    expect(places.get('a')?.lane).not.toBe(places.get('b')?.lane)
    expect(places.get('a')?.room).toBeGreaterThanOrEqual(wants(a))
    expect(places.get('b')?.room).toBeGreaterThanOrEqual(wants(b))
  })

  it('cuts a third nearby name short in a shared row, never past the row', () => {
    const long = 'A milestone with a long name'
    const flags = [flag('a', 3, long), flag('b', 4, long), flag('c', 5, long)]
    const places = layoutTrackFlags(flags, row)
    const lanes = [...places.values()].map((p) => p.lane)
    expect(Math.max(...lanes)).toBeLessThan(TRACK_FLAG_LANES)
    expect([...places.values()].some((p) => p.room < wants(long))).toBe(true)
    // must fail: a label of the track row that runs into the next flag of
    // its row
    for (const lane of trackBoxes(flags))
      for (let i = 1; i < lane.length; i++) expect(lane[i - 1][1]).toBeLessThanOrEqual(lane[i][0])
  })

  it('keeps each of three milestones of one week in sight, apart and inside its week', () => {
    const week = [
      flag('a', 4, 'Pilot batch ready'),
      flag('b', 4, 'Cloud beta'),
      flag('c', 4, 'Audit'),
    ]
    for (const weekW of [WEEK_W, 24]) {
      const shown = diamonds(week, { weekW })
      for (const d of shown) {
        expect(d.bottom).toBeGreaterThanOrEqual(0)
        expect(d.bottom + FLAG_LANE_H).toBeLessThanOrEqual(TRACK_FLAGS_H)
        expect(d.lane).toBeLessThan(TRACK_FLAG_LANES)
        // within the week's column
        expect(d.from).toBeGreaterThanOrEqual(4 * weekW - 4.5)
        expect(d.to).toBeLessThanOrEqual(5 * weekW)
      }
      // must fail: two diamonds stacked on one spot, where one hides the other
      const spots = shown.map((d) => `${d.from}|${d.bottom}`)
      expect(new Set(spots).size).toBe(3)
      // the nudged ones show their diamonds alone, beside the one in the top row
      const top = shown.filter((d) => d.lane === TRACK_FLAG_LANES - 1)
      expect(top).toHaveLength(2)
      expect(top.every((d) => d.room === 9)).toBe(true)
    }
  })

  it("stops a later week's label short of a crowded week's nudged diamonds", () => {
    // four in week 4, of milestones stored before the weekly rule, and one
    // in each of the next two weeks, near the timeline's end so names run
    // left
    const flags = [
      flag('a', 4, 'Alpha supplier contract review'),
      flag('b', 4, 'Beta supplier contract review'),
      flag('g', 4, 'Gamma check'),
      flag('z', 4, 'Zeta check'),
      flag('d', 5, 'Delta field test'),
      flag('e', 6, 'Epsilon supplier contract review'),
    ]
    const g = { w0: 0, weekW: 36, end: 252 }
    const places = layoutTrackFlags(flags, g)
    expect(places.get('g')?.shift).toBeGreaterThan(0)
    expect(places.get('z')?.shift).toBeGreaterThan(0)
    // must fail: Epsilon's left-running label over Zeta's diamond, where it
    // takes Zeta's clicks
    for (const lane of trackBoxes(flags, g))
      for (let i = 1; i < lane.length; i++) expect(lane[i - 1][1]).toBeLessThanOrEqual(lane[i][0])
    expect(places.get('e')?.room).toBeGreaterThan(9)
  })

  it('draws a crowded week in the order of its shifts, each diamond with a strip to point at', () => {
    // six in one week, saved before the weekly rule, the days in another
    // order than the names, as the server answers them by day
    const byDay = ['Zeta', 'Epsilon', 'Alpha', 'Delta', 'Beta', 'Gamma'].map((name, i) =>
      flag(`d${i}`, 4, name),
    )
    for (const [weekW, strip] of [
      [WEEK_W, 9],
      [24, 3.75],
    ] as const) {
      const g = { ...row, weekW, end: 20 * weekW }
      const places = layoutTrackFlags(byDay, g)
      expect([...places.keys()].sort()).toEqual(byDay.map((f) => f.id).sort())
      // the order to draw them in, each diamond's box
      const drawn = [...places].map(([id, p]) => {
        const x = 4 * weekW + (p.shift ?? 0)
        const from = p.side === 'right' ? x - 4.5 : x + 4.5 - p.room
        return { id, lane: p.lane, x, box: [from, from + p.room] as [number, number] }
      })
      const top = drawn.filter((d) => d.lane === TRACK_FLAG_LANES - 1)
      expect(top).toHaveLength(5)
      // must fail: drawn by day, a diamond before both its neighbours
      for (let i = 1; i < top.length; i++) expect(top[i].x).toBeGreaterThan(top[i - 1].x)
      for (const [i, d] of drawn.entries()) {
        const later = drawn.slice(i + 1).filter((o) => o.lane === d.lane)
        const diamond: [number, number] = [d.x - 4.5, d.x + 4.5]
        const over = later.map((o) => o.box)
        expect(uncovered(diamond, over)).toBeGreaterThanOrEqual(strip)
      }
    }
  })

  it('moves a dragged flag of a crowded week alone, to its new week, with a place every time', () => {
    // three in week 4 and two in week 12, each drawn at the week trackFlags
    // passes as live, its saved week until dragged
    const still = (id: string, week: number, name: string) => ({
      ...flag(id, week, name),
      live: week,
    })
    const crowded = [still('a', 4, 'Alpha'), still('b', 4, 'Beta'), still('c', 4, 'Gamma')]
    const other = [still('p', 12, 'Pilot'), still('q', 12, 'Quality')]
    const before = layoutTrackFlags([...crowded, ...other], row)
    expect(before.get('c')?.shift).toBeGreaterThan(0)
    const during = (id: string, live: number) => {
      const flags = [...crowded, ...other].map((f) => (f.id === id ? { ...f, live } : f))
      const places = layoutTrackFlags(flags, row)
      // must fail: a flag with no place, which the row does not draw
      expect([...places.keys()].sort()).toEqual(flags.map((f) => f.id).sort())
      // must fail: another flag that moves, or loses its nudge, meanwhile
      for (const f of flags) if (f.id !== id) expect(places.get(f.id)).toEqual(before.get(f.id))
      return places.get(id)
    }
    // the nudged one, to an empty week and to the other crowded week, on
    // the week's line in the row's rows
    for (const live of [9, 12]) {
      const place = during('c', live)
      expect(place?.lane).toBeLessThan(TRACK_FLAG_LANES)
      // must fail: a nudge kept from the week it left
      expect(place?.shift).toBeUndefined()
    }
    expect(during('c', 9)?.room).toBeGreaterThanOrEqual(wants('Gamma'))
    // one of the first two, to an empty week, with room for its name
    const alpha = during('a', 9)
    expect(alpha?.lane).toBeLessThan(TRACK_FLAG_LANES)
    expect(alpha?.room).toBeGreaterThanOrEqual(wants('Alpha'))
  })

  it("keeps the name of a week's only milestone after a crowded week", () => {
    const flags = [
      flag('a', 4, 'Alpha supplier contract review'),
      flag('b', 4, 'Beta supplier contract review'),
      flag('c', 4, 'Gamma check'),
      flag('d', 5, 'Delta field test'),
      flag('e', 6, 'Epsilon'),
    ]
    const places = layoutTrackFlags(flags, { ...row, weekW: 36, end: 20 * 36 })
    expect([...places.values()].every((p) => p.lane < TRACK_FLAG_LANES)).toBe(true)
    // the crowded week's third is nudged beside the one in the top row
    expect(places.get('c')?.shift).toBeGreaterThan(0)
    // must fail: a later week's only milestone nudged, its name gone
    for (const id of ['d', 'e']) {
      expect(places.get(id)?.shift).toBeUndefined()
      expect(places.get(id)?.room).toBeGreaterThan(9)
    }
  })
})
