import { describe, expect, it } from 'vitest'
import { FLAG_LABEL_MAX_W, flagBandHeight, labelWidth, layoutFlags } from './flagLanes'

/* The Roadmap header's milestone flags: no two flags of one week share a
   row, no label runs into the next flag of its row, and the band keeps its
   two-row height until a week or a crowd of labels needs more. */

const WEEK_W = 48
const grid = { w0: 0, weekW: WEEK_W, end: 20 * WEEK_W }
const flag = (id: string, week: number, name = id) => ({ id, week, name })
const place = (flags: ReturnType<typeof flag>[]) => layoutFlags(flags, grid)

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

  it('gives a row to each of more same-week milestones than labels may open', () => {
    const week = Array.from({ length: 6 }, (_, i) => flag(`m${i}`, 4))
    const { lanes, places } = place(week)
    expect(lanes).toBe(6)
    expect(new Set([...places.values()].map((p) => p.lane)).size).toBe(6)
  })

  it('keeps flags far apart in the bottom row, each label running to the next', () => {
    const { lanes, places } = place([flag('a', 1, 'Revision B ready'), flag('b', 6, 'Launch')])
    expect(lanes).toBe(1)
    expect(places.get('a')).toEqual({ lane: 0, room: FLAG_LABEL_MAX_W })
    expect(places.get('b')?.lane).toBe(0)
  })

  it('moves a close neighbour up a row rather than cutting the label before it', () => {
    const name = 'Dashboard ready for feedback'
    const { places } = place([flag('a', 2, name), flag('b', 3, 'Prototype validated')])
    expect(places.get('b')?.lane).toBe(1)
    expect(places.get('a')?.room).toBeGreaterThanOrEqual(labelWidth(name))
  })

  it('never lets a label run into the next flag of its row', () => {
    const weekly = Array.from({ length: 12 }, (_, i) => flag(`w${i}`, i, 'Prototype validated'))
    const { places } = place(weekly)
    const rows = new Map<number, { x: number; room: number }[]>()
    for (const f of weekly) {
      const p = places.get(f.id)
      if (!p) throw new Error(`no place for ${f.id}`)
      rows.set(p.lane, [...(rows.get(p.lane) ?? []), { x: f.week * WEEK_W, room: p.room }])
    }
    for (const row of rows.values())
      for (let i = 1; i < row.length; i++)
        expect(row[i - 1].x + row[i - 1].room).toBeLessThan(row[i].x)
  })

  it('cuts the label that ends soonest once labels have opened four rows', () => {
    // four long labels in weeks 0 to 3 fill four rows; a second flag in
    // week 3 lands on the row whose label ends soonest, week 0's
    const long = 'Regulatory submission package'
    const flags = [0, 1, 2, 3].map((w) => flag(`l${w}`, w, long))
    const { lanes, places } = place([...flags, flag('e', 3, 'Wrap-up')])
    expect(lanes).toBe(4)
    expect(places.get('e')?.lane).toBe(places.get('l0')?.lane)
    expect(places.get('l0')?.room).toBe(3 * WEEK_W - 6)
  })

  it('stops a long name at the widest label', () => {
    const { places } = place([flag('a', 0, 'Customer acceptance and handover to operations')])
    expect(places.get('a')?.room).toBe(FLAG_LABEL_MAX_W)
  })
})
