import { describe, expect, it } from 'vitest'
import {
  FLAG_LABEL_MAX_W,
  flagBandHeight,
  flagLanesShown,
  labelWidth,
  layoutFlags,
} from './flagLanes'

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
