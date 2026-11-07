import { describe, expect, it } from 'vitest'
import {
  comparePositions,
  createMilestoneRows,
  type MilestoneAsk,
  type MilestoneRow,
  type MilestoneTake,
  positionOf,
  shownDay,
} from './milestoneRows'

/* The milestone reads' rows and their paints (store/milestoneRows.ts), on
   their own: the anchors, the copies a repaint paints, and where a paint
   puts a row, by the server's rules (convex/model/milestones.ts). */

const AT = '2026-09-14T08:00:00.000Z'
const FROM = '2026-09-14'
const TO = '2026-09-28'

/* Projects: Plan and Ship are top-level, Docs is a sub-project of Plan. */
const TOP: Record<string, string> = { plan: 'plan', ship: 'ship', docs: 'plan' }

/** Milestone `id` of project `project` on stored day `week`. */
const ms = (id: string, week: string, name = id, project = 'plan'): MilestoneRow => ({
  id,
  project_id: project,
  name,
  week,
  created_at: AT,
})

/** A registry whose reads in `stopped` are not subscribed, with the
    milestones the store holds outside the reads, `known`. */
function registry(stopped: readonly string[] = [], known: readonly MilestoneRow[] = []) {
  return createMilestoneRows({
    topOf: (id) => TOP[id] ?? id,
    live: (slot) => !stopped.includes(slot),
    known: () => known,
  })
}

/** An answer of `rows` with `next` and `stopped`. */
const answer = (
  rows: MilestoneRow[],
  next: MilestoneTake['next'] = null,
  extra: Partial<MilestoneTake> = {},
): MilestoneTake => ({ rows, next, stopped: null, ...extra })

const upcoming = (
  over: Partial<Extract<MilestoneAsk, { kind: 'section' }>> = {},
): MilestoneAsk => ({
  kind: 'section',
  projects: ['plan'],
  from: FROM,
  side: 'upcoming',
  limit: 25,
  ...over,
})
/** Plan as a `get` answer names it, in organization `org`. */
const project = (org: string) => ({ id: 'plan', name: 'Plan', key: 'PLAN', org_id: org })
const range: MilestoneAsk = { kind: 'between', projects: ['plan'], from: FROM, to: TO }
const ids = (rows: readonly MilestoneRow[] | undefined) => (rows ?? []).map((r) => r.id)

describe('the anchors', () => {
  it('takes, holds and releases each read, and paints copies over them', () => {
    const r = registry()
    const a = ms('a', '2026-09-15')
    const take = answer([a])
    r.take('s', '{"k":1}', upcoming(), take)
    expect(r.holds('s')).toBe(true)
    expect(r.keyOf('s')).toBe('{"k":1}')
    expect(r.anchorHas('s', 'a')).toBe(true)
    r.beginPaint()
    // with no paint, the rows on screen are the answer's own list
    expect(r.shownOf('s')?.rows).toBe(take.rows)
    r.update('a', { name: 'Alpha' })
    expect(r.shownOf('s')?.rows[0].name).toBe('Alpha')
    // the anchor is as the server sent it
    expect(take.rows[0]).toBe(a)
    expect(a.name).toBe('a')
    r.release('s')
    expect(r.holds('s')).toBe(false)
    expect(r.shownOf('s')).toBeNull()
  })

  it('answers a row and its organization from a live read before a stopped one', () => {
    const r = registry(['kept'])
    // the live read answers first, so the stopped one's copy is its own
    r.take(
      'live',
      'k2',
      { kind: 'get', id: 'a' },
      answer([ms('a', '2026-09-15', 'New')], null, { project: project('o2') }),
    )
    r.take(
      'kept',
      'k1',
      { kind: 'get', id: 'a' },
      answer([ms('a', '2026-09-15', 'Old')], null, { project: project('o1') }),
    )
    r.beginPaint()
    expect(r.shownOf('kept')?.rows[0].name).toBe('Old')
    expect(r.row('a')?.name).toBe('New')
    expect(r.orgOf('a')).toBe('o2')
    expect(r.row('b')).toBeUndefined()
    expect(r.orgOf('b')).toBeUndefined()
  })

  it("has a stopped read's copies follow a live read's answer, in their place or out of the read", () => {
    const r = registry(['kept'])
    const kept = answer([ms('a', '2026-09-15', 'Alpha'), ms('b', '2026-09-22', 'Beta')])
    const up = answer([ms('a', '2026-09-15', 'Alpha'), ms('b', '2026-09-22', 'Beta')])
    r.take('kept', 'k', range, kept)
    r.take('up', 'u', upcoming(), up)
    const get = { kind: 'get', id: 'a' } as const
    r.take('open', 'g', get, answer([ms('a', '2026-09-23', 'Alpha 2')]))
    expect(r.liveHolds('a')).toBe(true)
    expect(r.liveHolds('c')).toBe(false)
    r.beginPaint()
    // the stopped range takes the row, moved after Beta
    expect(r.shownOf('kept')?.rows.map((row) => row.name)).toEqual(['Beta', 'Alpha 2'])
    // a live read's answer is the server's own, which another's never changes
    expect(r.shownOf('up')?.rows).toBe(up.rows)
    // the answer as the server sent it stays as it was
    expect(kept.rows[0].name).toBe('Alpha')
    // a day past the range takes it out of the stopped read
    r.take('open', 'g', get, answer([ms('a', '2026-10-12', 'Alpha 2')]))
    r.beginPaint()
    expect(ids(r.shownOf('kept')?.rows)).toEqual(['b'])
  })
})

describe('the paints', () => {
  it('edits, hides and hides a project in every copy of every read', () => {
    const r = registry()
    r.take('get', 'g', { kind: 'get', id: 'a' }, answer([ms('a', '2026-09-15')]))
    r.take('up', 'u', upcoming(), answer([ms('a', '2026-09-15'), ms('b', '2026-09-22')]))
    r.take(
      'ship',
      's',
      upcoming({ projects: ['ship'] }),
      answer([ms('c', '2026-09-16', 'c', 'ship')]),
    )
    r.beginPaint()
    r.update('a', { name: 'Alpha' })
    expect(r.shownOf('get')?.rows[0].name).toBe('Alpha')
    expect(r.shownOf('up')?.rows[0].name).toBe('Alpha')
    r.hide('a')
    expect(ids(r.shownOf('get')?.rows)).toEqual([])
    expect(ids(r.shownOf('up')?.rows)).toEqual(['b'])
    r.hideProjects(new Set(['ship']))
    expect(ids(r.shownOf('ship')?.rows)).toEqual([])
    expect(ids(r.shownOf('up')?.rows)).toEqual(['b'])
  })

  it('moves an edited row to its place, out of a read it left and into one it joined', () => {
    const r = registry()
    r.take('range', 'r', range, answer([ms('a', '2026-09-15'), ms('b', '2026-09-22')]))
    r.take('far', 'f', { ...range, from: '2026-10-26', to: '2026-11-09' }, answer([]))
    r.beginPaint()
    // a rename that sorts it after b on the same day keeps it before b,
    // which is on a later day
    r.update('a', { name: 'zzz' })
    expect(ids(r.shownOf('range')?.rows)).toEqual(['a', 'b'])
    // a move past b
    r.update('a', { week: '2026-09-23' })
    expect(ids(r.shownOf('range')?.rows)).toEqual(['b', 'a'])
    // five weeks out: it leaves this range and joins the far one
    r.update('a', { week: '2026-10-27' })
    expect(ids(r.shownOf('range')?.rows)).toEqual(['b'])
    expect(ids(r.shownOf('far')?.rows)).toEqual(['a'])
    expect(r.shownOf('far')?.rows[0].name).toBe('zzz')
  })

  it('skips an edit when no copy is left, and takes the fallback row otherwise', () => {
    const r = registry()
    r.take('range', 'r', range, answer([]))
    r.beginPaint()
    r.update('x', { week: '2026-09-16' })
    expect(ids(r.shownOf('range')?.rows)).toEqual([])
    r.update('x', { week: '2026-09-16' }, ms('x', '2026-12-01'))
    expect(ids(r.shownOf('range')?.rows)).toEqual(['x'])
    expect(r.shownOf('range')?.rows[0].week).toBe('2026-09-16')
  })
})

describe("a batch's own last row", () => {
  it('stays when a rename or a move keeps it before every milestone the read lacks', () => {
    const a = ms('a', '2026-09-15', 'Alpha')
    const b = ms('b', '2026-09-22', 'Beta')
    const r = registry([], [a, b])
    // a one-row section: the following batch starts after Alpha
    r.take('next', 'k', upcoming({ limit: 1 }), answer([a], positionOf(a)))
    r.beginPaint()
    r.update('a', { name: 'Zed' })
    expect(r.shownOf('next')?.rows.map((row) => row.name)).toEqual(['Zed'])
    r.beginPaint()
    r.update('a', { week: '2026-09-21' })
    expect(ids(r.shownOf('next')?.rows)).toEqual(['a'])
  })

  it('must fail: leaves the batch once it moves past a milestone the read lacks', () => {
    const a = ms('a', '2026-09-15', 'Alpha')
    const b = ms('b', '2026-09-22', 'Beta')
    const r = registry([], [a, b])
    r.take('next', 'k', upcoming({ limit: 1 }), answer([a], positionOf(a)))
    r.beginPaint()
    r.update('a', { week: '2026-09-29' })
    expect(ids(r.shownOf('next')?.rows)).toEqual([])
    // another read's answer tells of a milestone the batch lacks too
    const other = registry()
    other.take('next', 'k', upcoming({ limit: 1 }), answer([a], positionOf(a)))
    other.take('range', 'r', range, answer([a, b]))
    other.beginPaint()
    other.update('a', { name: 'Zed', week: '2026-09-22' })
    expect(ids(other.shownOf('next')?.rows)).toEqual([])
    // a row that is not the batch's last still leaves past `next`
    const c = ms('c', '2026-09-16', 'Gamma')
    const third = registry()
    third.take('next', 'k', upcoming({ limit: 1 }), answer([a], positionOf(a)))
    third.beginPaint()
    third.insert({ ...c, week: '2026-09-20' })
    expect(ids(third.shownOf('next')?.rows)).toEqual(['a'])
  })
})

describe('a create', () => {
  it('goes into an upcoming section only on or after its first day', () => {
    const r = registry()
    r.take('up', 'u', upcoming(), answer([]))
    r.beginPaint()
    r.insert(ms('before', '2026-09-13'))
    r.insert(ms('on', FROM))
    expect(ids(r.shownOf('up')?.rows)).toEqual(['on'])
  })

  it('goes into a past section only before its first day, newest first', () => {
    const r = registry()
    r.take('past', 'p', upcoming({ side: 'past' }), answer([ms('old', '2026-08-03')]))
    r.beginPaint()
    r.insert(ms('on', FROM))
    r.insert(ms('newer', '2026-09-07'))
    expect(ids(r.shownOf('past')?.rows)).toEqual(['newer', 'old'])
  })

  it('goes into a range only inside [from, to)', () => {
    const r = registry()
    r.take('range', 'r', range, answer([]))
    r.beginPaint()
    for (const [id, day] of [
      ['early', '2026-09-13'],
      ['first', FROM],
      ['last', '2026-09-27'],
      ['to', TO],
    ])
      r.insert(ms(id, day))
    expect(ids(r.shownOf('range')?.rows)).toEqual(['first', 'last'])
  })

  it('goes only into a read of its project, a sub-project standing for its parent', () => {
    const r = registry()
    r.take('docs', 'd', upcoming({ projects: ['docs'] }), answer([]))
    r.take('ship', 's', upcoming({ projects: ['ship'] }), answer([]))
    r.beginPaint()
    r.insert(ms('a', '2026-09-15'))
    expect(ids(r.shownOf('docs')?.rows)).toEqual(['a'])
    expect(ids(r.shownOf('ship')?.rows)).toEqual([])
  })

  it('goes only where the search matches every word, ignoring case and accents', () => {
    const r = registry()
    r.take('search', 's', upcoming({ search: 'beta CAFE' }), answer([]))
    r.beginPaint()
    r.insert(ms('hit', '2026-09-15', 'Café beta review'))
    r.insert(ms('miss', '2026-09-15', 'Beta review'))
    expect(ids(r.shownOf('search')?.rows)).toEqual(['hit'])
  })

  it("goes only between the ask's after and the answer's next", () => {
    const r = registry()
    const first = ms('m1', '2026-09-15')
    const last = ms('m3', '2026-09-29')
    r.take(
      'batch',
      'b',
      upcoming({ after: positionOf(first), limit: 1 }),
      answer([last], positionOf(last)),
    )
    r.beginPaint()
    r.insert(ms('early', '2026-09-14'))
    r.insert(ms('between', '2026-09-22'))
    r.insert(ms('late', '2026-10-06'))
    expect(ids(r.shownOf('batch')?.rows)).toEqual(['between', 'm3'])
  })

  it('never goes into a get read, nor twice into a read', () => {
    const r = registry()
    r.take('get', 'g', { kind: 'get', id: 'a' }, answer([]))
    r.take('up', 'u', upcoming(), answer([]))
    r.beginPaint()
    r.insert(ms('a', '2026-09-15'))
    r.insert(ms('a', '2026-09-15'))
    expect(ids(r.shownOf('get')?.rows)).toEqual([])
    expect(ids(r.shownOf('up')?.rows)).toEqual(['a'])
  })

  it('orders one day by name key and then id, by UTF-16 code units', () => {
    const r = registry()
    r.take('up', 'u', upcoming(), answer([]))
    r.beginPaint()
    // localeCompare puts "é" before "z"; code units put "z" (U+007A)
    // before "é" (U+00E9), and nameKey keeps "é" in the key only as "e",
    // so take one it keeps: "ø" (U+00F8)
    r.insert(ms('b', '2026-09-15', 'ø'))
    r.insert(ms('a', '2026-09-15', 'z'))
    r.insert(ms('c', '2026-09-15', 'z'))
    expect('ø'.localeCompare('z')).toBeLessThan(0)
    expect(ids(r.shownOf('up')?.rows)).toEqual(['a', 'c', 'b'])
  })

  it("says an upcoming first batch's projects now hold a past milestone", () => {
    const r = registry()
    r.take('up', 'u', upcoming(), answer([], null, { past: false }))
    r.beginPaint()
    r.insert(ms('later', '2026-09-15'))
    expect(r.shownOf('up')?.past).toBe(false)
    r.insert(ms('old', '2026-08-03'))
    expect(r.shownOf('up')?.past).toBe(true)
  })
})

describe("a section read with mine (My view's)", () => {
  /** My view's Upcoming, its projects found by the server. */
  const mine = (over: Partial<Extract<MilestoneAsk, { kind: 'section' }>> = {}): MilestoneAsk =>
    upcoming({ projects: [], mine: true, ...over })

  it("paints a create, an edit and a past create by its answer's projects, a sub-project standing for its parent", () => {
    const r = registry()
    r.take('mine', 'm', mine(), answer([], null, { projects: ['plan'], past: false }))
    r.take('pastMine', 'p', mine({ side: 'past' }), answer([], null, { projects: ['plan'] }))
    r.beginPaint()
    r.insert(ms('a', '2026-09-15'))
    r.insert(ms('d', '2026-09-16', 'd', 'docs'))
    // must fail: a project the answer does not list
    r.insert(ms('s', '2026-09-15', 's', 'ship'))
    expect(ids(r.shownOf('mine')?.rows)).toEqual(['a', 'd'])
    // an edit moves a row out to Past by the same projects
    r.update('a', { week: '2026-09-07' })
    expect(ids(r.shownOf('mine')?.rows)).toEqual(['d'])
    expect(ids(r.shownOf('pastMine')?.rows)).toEqual(['a'])
    // the first batch's `past` turns true for a listed project's past create
    expect(r.shownOf('mine')?.past).toBe(true)
  })

  it("must fail: covers nothing before its answer names projects, and nothing of another's", () => {
    const r = registry()
    // an answer with no projects, as an older backend's would be
    r.take('bare', 'b', mine(), answer([], null, { past: false }))
    r.take('ship', 's', mine(), answer([], null, { projects: ['ship'], past: false }))
    r.beginPaint()
    r.insert(ms('a', '2026-09-15'))
    r.insert(ms('old', '2026-08-03'))
    expect(ids(r.shownOf('bare')?.rows)).toEqual([])
    expect(ids(r.shownOf('ship')?.rows)).toEqual([])
    expect(r.shownOf('ship')?.past).toBe(false)
    expect(r.covers('ship', ms('x', '2026-09-15', 'x', 'ship'))).toBe(true)
    expect(r.covers('ship', ms('x', '2026-09-15'))).toBe(false)
  })
})

describe('must fail', () => {
  it('an insert into a section of another project', () => {
    const r = registry()
    r.take('ship', 's', upcoming({ projects: ['ship'] }), answer([]))
    r.beginPaint()
    r.insert(ms('a', '2026-09-15'))
    expect(r.shownOf('ship')?.rows).toEqual([])
  })

  it("an insert past the answer's next", () => {
    const r = registry()
    const a = ms('a', '2026-09-15')
    r.take('up', 'u', upcoming({ limit: 1 }), answer([a], positionOf(a)))
    r.beginPaint()
    r.insert(ms('b', '2026-09-16'))
    expect(ids(r.shownOf('up')?.rows)).toEqual(['a'])
  })

  it('a past insert on the first day itself', () => {
    const r = registry()
    r.take('past', 'p', upcoming({ side: 'past' }), answer([]))
    r.beginPaint()
    r.insert(ms('a', FROM))
    expect(ids(r.shownOf('past')?.rows)).toEqual([])
  })
})

describe('days and the order', () => {
  it('places a day that does not exist on the day it overflows to', () => {
    expect(shownDay('2026-02-31')).toBe('2026-03-03')
    expect(shownDay('2026-09-14')).toBe('2026-09-14')
    expect(shownDay('soon')).toBeNull()
  })

  it('compares positions by stored day, name key and id', () => {
    const p = (week: string, key: string, id: string) => ({ week, key, id })
    expect(comparePositions(p('2026-09-14', 'b', 'x'), p('2026-09-15', 'a', 'a'))).toBeLessThan(0)
    expect(comparePositions(p('2026-09-14', 'a', 'y'), p('2026-09-14', 'b', 'a'))).toBeLessThan(0)
    expect(comparePositions(p('2026-09-14', 'a', 'b'), p('2026-09-14', 'a', 'a'))).toBeGreaterThan(
      0,
    )
    expect(comparePositions(p('2026-09-14', 'a', 'a'), p('2026-09-14', 'a', 'a'))).toBe(0)
  })
})
