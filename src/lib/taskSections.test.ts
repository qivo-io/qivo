import { describe, expect, it } from 'vitest'
import {
  byCreation,
  byNumber,
  groupTotals,
  type LinkEnds,
  linkViews,
  type SectionState,
  type Standing,
  shownIds,
  shows,
  type TotalsRow,
  workspaceTotals,
} from './taskSections'

const AT = '2026-09-14T08:00:00.000Z'
const LATER = '2026-09-14T09:00:00.000Z'

describe('the merge of a section answer with the rows on screen', () => {
  it('lets the painted rows decide where they differ from the applied ones', () => {
    // a layer adds it, which the answer cannot know yet
    expect(shows({ base: false, painted: true, answer: false })).toBe(true)
    // a layer takes it away, which the answer still holds
    expect(shows({ base: true, painted: false, answer: true })).toBe(false)
  })

  it('lets the answer decide where the applied and the painted rows agree', () => {
    // held nowhere in the workspace, such as a task still to arrive
    expect(shows({ base: false, painted: false, answer: true })).toBe(true)
    // the workspace holds it, but the server no longer lists it
    expect(shows({ base: true, painted: true, answer: false })).toBe(false)
    expect(shows({ base: true, painted: true, answer: true })).toBe(true)
    expect(shows({ base: false, painted: false, answer: false })).toBe(false)
  })

  it('names each shown candidate once, in the order first named', () => {
    const standing: Record<string, Standing> = {
      // only the answer holds it
      answerOnly: { base: false, painted: false, answer: true },
      // a layer moved this subtask away, the answer still lists it
      movedAway: { base: true, painted: false, answer: true },
      // a layer made this a subtask before the server knows it
      paintedNew: { base: false, painted: true, answer: false },
      // base and painted agree on it, the answer does not
      dropped: { base: true, painted: true, answer: false },
      kept: { base: true, painted: true, answer: true },
    }
    const ids = shownIds(
      ['answerOnly', 'movedAway', 'kept', 'kept', 'dropped', 'paintedNew', 'answerOnly'],
      (id) => standing[id],
    )
    expect(ids).toEqual(['answerOnly', 'kept', 'paintedNew'])
  })

  it('orders subtasks by number, then id, and the rest by creation, then id', () => {
    const tasks = [
      { id: 'b', num: 2 },
      { id: 'c', num: 1 },
      { id: 'a', num: 2 },
    ]
    expect([...tasks].sort(byNumber).map((t) => t.id)).toEqual(['c', 'a', 'b'])
    const rows = [
      { id: 'y', created_at: LATER },
      { id: 'z', created_at: AT },
      { id: 'x', created_at: AT },
    ]
    expect([...rows].sort(byCreation).map((r) => r.id)).toEqual(['x', 'z', 'y'])
  })
})

describe("a task's links as its window lists them", () => {
  const link = (id: string, source: string, target: string, type: string, at = AT): LinkEnds => ({
    id,
    source_id: source,
    target_id: target,
    type,
    created_at: at,
  })

  it('reads each link from the open task, one row for each other task, oldest link first', () => {
    const links = [
      link('l4', 'd', 't', 'relates', LATER),
      link('l2', 'b', 't', 'blocks'),
      link('l1', 't', 'a', 'blocks'),
      link('l3', 't', 'c', 'relates'),
      // a second link to a, which the first one stands for
      link('l5', 'a', 't', 'relates', LATER),
    ]
    expect(linkViews('t', links, () => true)).toEqual([
      { other: 'a', type: 'blocks', link: 'l1' },
      { other: 'b', type: 'blocked_by', link: 'l2' },
      { other: 'c', type: 'relates', link: 'l3' },
      { other: 'd', type: 'relates', link: 'l4' },
    ])
  })

  it('leaves out a link whose other task is not shown', () => {
    const links = [link('l1', 't', 'hidden', 'blocks'), link('l2', 'b', 't', 'blocks')]
    expect(linkViews('t', links, (other) => other !== 'hidden')).toEqual([
      { other: 'b', type: 'blocked_by', link: 'l2' },
    ])
    expect(linkViews('t', links, () => false)).toEqual([])
  })

  it('reads an unknown kind from the other end as relates', () => {
    expect(linkViews('t', [link('l1', 'b', 't', 'unknown')], () => true)).toEqual([
      { other: 'b', type: 'relates', link: 'l1' },
    ])
  })
})

describe("a group's Progress and Remaining", () => {
  const leaf = (done: boolean, remaining?: number): TotalsRow => ({
    isGroup: false,
    done,
    remaining,
  })
  const list = (
    state: SectionState,
    rows: TotalsRow[],
    extra: Partial<{ complete: boolean; delivered: boolean; hidden: boolean }> = {},
  ) => ({ state, rows, complete: true, delivered: true, hidden: false, ...extra })

  it('says loading before the list arrives, also while a retry runs before any answer', () => {
    const loading = { progress: { state: 'loading' }, remaining: { state: 'loading' } }
    expect(groupTotals(list('loading', [], { complete: false, delivered: false }))).toEqual(loading)
    expect(groupTotals(list('retrying', [], { complete: false, delivered: false }))).toEqual(
      loading,
    )
  })

  it('says unknown without a whole list, partial once rows were read', () => {
    const unknown = (partial: boolean) => ({
      progress: { state: 'unknown', partial },
      remaining: { state: 'unknown' },
    })
    expect(groupTotals(list('failed', [], { complete: false, delivered: false }))).toEqual(
      unknown(false),
    )
    expect(groupTotals(list('failed', [leaf(true, 1)]))).toEqual(unknown(true))
    expect(groupTotals(list('retrying', [leaf(true, 1)]))).toEqual(unknown(true))
    expect(groupTotals(list('unavailable', [], { complete: false }))).toEqual(unknown(false))
    expect(groupTotals(list('ready', [leaf(false, 2)], { complete: false }))).toEqual(unknown(true))
  })

  it('counts the leaves of a whole list and sums the open hours, rounded to tenths', () => {
    const totals = groupTotals(
      list('ready', [leaf(true, 4), leaf(false, 1.04), leaf(false), leaf(false, 2.03)]),
    )
    expect(totals).toEqual({
      progress: { state: 'complete', done: 1, total: 4, pct: 25 },
      // the Done leaf's hours and the leaf without hours do not count
      remaining: { state: 'complete', hours: 3.1 },
    })
  })

  it('has no hours when no open leaf has any, and no subtasks yet for an empty whole list', () => {
    expect(groupTotals(list('ready', [leaf(true, 5), leaf(false)])).remaining).toEqual({
      state: 'complete',
      hours: undefined,
    })
    expect(groupTotals(list('ready', []))).toEqual({
      progress: { state: 'complete', done: 0, total: 0, pct: 0 },
      remaining: { state: 'complete', hours: undefined },
    })
  })

  it('counts the visible subtasks beside hidden ones, and sums their hours', () => {
    expect(groupTotals(list('ready', [leaf(true), leaf(false, 3)], { hidden: true }))).toEqual({
      progress: { state: 'visible', done: 1, total: 2 },
      remaining: { state: 'visible', hours: 3 },
    })
  })

  it('cannot total a list with a group row, whose own subtasks the list lacks', () => {
    const group: TotalsRow = { isGroup: true, done: false, remaining: 8 }
    expect(groupTotals(list('ready', [leaf(true), group, leaf(false, 1)]))).toEqual({
      progress: { state: 'visible', done: 1, total: 2 },
      remaining: { state: 'unknown' },
    })
  })
})

describe("a group's totals by the workspace's rules", () => {
  it('counts every visible leaf, and says completion is unknown beside hidden subtasks', () => {
    expect(workspaceTotals({ done: 1, total: 3, pct: 33, unknown: false }, 4.5)).toEqual({
      progress: { state: 'complete', done: 1, total: 3, pct: 33 },
      remaining: { state: 'complete', hours: 4.5 },
    })
    expect(workspaceTotals({ done: 2, total: 5, pct: 40, unknown: true }, undefined)).toEqual({
      progress: { state: 'visible', done: 2, total: 5 },
      // the subtree's own total, never unknown, as before the sections
      remaining: { state: 'complete', hours: undefined },
    })
  })
})
