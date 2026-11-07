import { describe, expect, it } from 'vitest'
import { TODAY_WEEK, weekToISO } from '../../lib/dates'
import {
  type Marker,
  type MarkerAnswer,
  type MarkerPlan,
  type MarkerRead,
  markerAsk,
  markerLine,
  markerProjects,
  markerView,
  nextPlan,
  retryPlan,
  swapPlan,
} from './roadmapMilestones'

/* What the Roadmap reads of its milestone flags and what it draws of
   them: the projects each scope names, the range of the weeks on screen,
   the two slots a new window alternates, the rows of an answer kept for
   the weeks both windows cover, every state a read can be in, and the
   line that says what is missing. */

const W = TODAY_WEEK
const project = (id: string) => ({ wide: false, mine: false, id, metas: [{ id: 'plan' }] })
const MINE = { wide: true, mine: true, id: 'mine', metas: [{ id: 'plan' }, { id: 'luma' }] }
const ALL = { wide: true, mine: false, id: 'all', metas: [{ id: 'plan' }, { id: 'luma' }] }
const TRACKS = [
  { proj: { id: 'plan' }, subIds: ['plan-a', 'plan-b'] },
  { proj: { id: 'luma' }, subIds: ['luma-a'] },
  { proj: { id: 'cloud' }, subIds: ['cloud-a'] },
]

const row = (id: string, week: number, proj = 'plan'): Marker => ({
  id,
  project: proj,
  name: `Milestone ${id}`,
  week,
})
const answerOf = (rows: Marker[], stopped: string | null = null): MarkerAnswer<Marker> => ({
  rows,
  stored: new Map(rows.map((r) => [r.id, { name: r.name, week: weekToISO(r.week) }])),
  stopped,
})
const ok = (rows: Marker[], current = true, stopped: string | null = null): MarkerRead<Marker> => ({
  state: 'ok',
  current,
  answer: answerOf(rows, stopped),
})
const LOADING: MarkerRead<Marker> = { state: 'loading' }

/** A plan whose shown slot asks `projects` for the weeks `w0` to `w1`. */
const planOf = (projects: string[], w0: number, w1: number) =>
  nextPlan(null, markerAsk(projects, w0, w1), false) as MarkerPlan

describe('markerProjects', () => {
  it("names a project's top-level project, and a sub-project's", () => {
    expect(markerProjects(project('plan'), [], null)).toEqual(['plan'])
    // a sub-project held with its parent names the parent
    expect(markerProjects(project('plan-a'), [], null)).toEqual(['plan'])
    // one held without its parent names itself, which the server folds
    expect(markerProjects({ ...project('orphan'), metas: [] }, [], null)).toEqual(['orphan'])
  })

  it("names My view's tracks once each and sorted, before the filters prune them", () => {
    const held = new Set(['luma-a', 'plan-b', 'plan-a'])
    expect(markerProjects(MINE, TRACKS, held)).toEqual(['luma', 'plan'])
    // must fail: a visible project with no sub-project of the answer's
    expect(markerProjects(MINE, TRACKS, held)).not.toContain('cloud')
  })

  it('names nothing in All projects, or in My view before an answer names its tracks', () => {
    expect(markerProjects(ALL, TRACKS, new Set(['plan-a']))).toBeNull()
    expect(markerProjects(MINE, TRACKS, null)).toBeNull()
    expect(markerProjects(MINE, TRACKS, new Set())).toBeNull()
  })

  it("keeps My view's last tracks while its answer reloads", () => {
    expect(markerProjects(MINE, TRACKS, null, ['luma', 'plan'])).toEqual(['luma', 'plan'])
    // an answer that names the tracks wins over the kept ones
    expect(markerProjects(MINE, TRACKS, new Set(['cloud-a']), ['plan'])).toEqual(['cloud'])
  })
})

describe('markerAsk', () => {
  it('asks the days of the weeks on screen, from the first day to the day after the last', () => {
    expect(markerAsk(['plan'], W, W)).toEqual({
      kind: 'between',
      projects: ['plan'],
      from: weekToISO(W),
      to: weekToISO(W + 1),
    })
    // the default window, two weeks back to six ahead
    const nine = markerAsk(['plan'], W - 2, W + 6)
    expect([nine.from, nine.to]).toEqual([weekToISO(W - 2), weekToISO(W + 7)])
    // the window's maximum
    const most = markerAsk(['plan'], W, W + 259)
    const days = (Date.parse(most.to) - Date.parse(most.from)) / 86_400_000
    expect(Math.round(days)).toBe(260 * 7)
  })

  it('names each project once, sorted, and asks new days for new weeks', () => {
    expect(markerAsk(['plan', 'luma', 'plan'], W, W).projects).toEqual(['luma', 'plan'])
    expect(markerAsk(['plan'], W + 1, W + 1).from).not.toBe(markerAsk(['plan'], W, W).from)
  })
})

describe('the plan of slots', () => {
  const nine = markerAsk(['plan'], W - 2, W + 6)
  const later = markerAsk(['plan'], W, W + 8)
  const further = markerAsk(['plan'], W + 2, W + 10)

  it('asks a pan under the other slot while the shown one stays, and swaps once it answers', () => {
    const first = nextPlan(null, nine, false) as MarkerPlan
    expect(first.shown.n).toBe(0)
    const panned = nextPlan(first, later, true) as MarkerPlan
    expect(panned.shown).toBe(first.shown)
    expect(panned.pending).toMatchObject({ n: 1, ask: later, attempt: 0 })
    const swapped = swapPlan(panned)
    expect(swapped).toEqual({ shown: panned.pending, pending: null })
    // the next pan goes back to the first slot
    expect(nextPlan(swapped, further, true)?.pending?.n).toBe(0)
  })

  it('drops the pending ask on a pan back, and replaces it on a second pan', () => {
    const first = nextPlan(null, nine, false) as MarkerPlan
    const panned = nextPlan(first, later, true) as MarkerPlan
    expect(nextPlan(panned, nine, true)).toEqual({ ...first, pending: null })
    expect(nextPlan(panned, further, true)?.pending).toMatchObject({ n: 1, ask: further })
    // the same ask again keeps the plan as it is
    expect(nextPlan(panned, later, true)).toBe(panned)
  })

  it('asks in place of a shown slot with nothing to show, and keeps the plan with no ask', () => {
    const first = nextPlan(null, nine, false) as MarkerPlan
    expect(nextPlan(first, later, false)).toEqual({
      shown: { n: 0, ask: later, key: expect.any(String), attempt: 0 },
      pending: null,
    })
    expect(nextPlan(first, null, true)).toBe(first)
  })

  it("bumps only the failed slot's attempt on Retry", () => {
    const panned = nextPlan(nextPlan(null, nine, false), later, true) as MarkerPlan
    const pending = retryPlan(panned, { shown: false, pending: true })
    expect([pending.shown.attempt, pending.pending?.attempt]).toEqual([0, 1])
    const shown = retryPlan(panned, { shown: true, pending: false })
    expect([shown.shown.attempt, shown.pending?.attempt]).toEqual([1, 0])
  })
})

describe('markerView', () => {
  it("shows the shown answer's flags in the window and of the projects named now, with their stored values", () => {
    const plan = planOf(['gone', 'luma', 'plan'], W - 2, W + 6)
    const read = ok([row('a', W), row('b', W + 3, 'luma'), row('c', W + 5, 'gone')])
    const view = markerView(plan, read, null, W - 2, W + 6, ['gone', 'luma', 'plan'])
    expect(view.state).toBe('ok')
    expect(view.busy).toBe(false)
    expect(view.rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(view.stored.get('b')).toEqual({ name: 'Milestone b', week: weekToISO(W + 3) })
    // must fail: while the read of fewer projects is on its way, a flag of
    // a project no longer named
    const fewer = nextPlan(plan, markerAsk(['luma', 'plan'], W - 2, W + 6), true) as MarkerPlan
    const narrowed = markerView(fewer, read, LOADING, W - 2, W + 6, ['luma', 'plan'])
    expect(narrowed.rows.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it("shows the rows a sub-project's read answers for a top-level project the store does not hold", () => {
    // a sub-project held without its parent names itself, which the server
    // folds to the parent, whose milestones it answers
    const projects = markerProjects({ ...project('orphan'), metas: [] }, [], null) ?? []
    const plan = planOf(projects, W - 2, W + 6)
    const view = markerView(plan, ok([row('a', W, 'parent')]), null, W - 2, W + 6, projects)
    // must fail: every row dropped as one of a project not named
    expect(view.rows.map((r) => r.id)).toEqual(['a'])
  })

  it('shows a kept answer only for the weeks both windows cover while the new one loads', () => {
    const plan = nextPlan(
      planOf(['plan'], W - 2, W + 6),
      markerAsk(['plan'], W + 2, W + 10),
      true,
    ) as MarkerPlan
    const read = ok([row('old', W - 1), row('both', W + 4), row('edge', W + 6)])
    const view = markerView(plan, read, LOADING, W + 2, W + 10, ['plan'])
    expect(view.state).toBe('refreshing')
    expect(view.busy).toBe(true)
    // must fail: a flag of a week the new window left, or a week the shown
    // answer never read
    expect(view.rows.map((r) => r.id)).toEqual(['both', 'edge'])
    const unread = ok([row('far', W + 9)])
    const bare = markerView(plan, unread, LOADING, W + 2, W + 10, ['plan'])
    expect(bare.rows).toEqual([])
    // the shown answer read the shared weeks, so the new window's read is
    // no wait to announce, whether a flag of it shows or none does
    expect(view.waiting).toBe(false)
    // must fail: a line that comes and goes on each pan whose shared weeks
    // hold no flag
    expect(bare.waiting).toBe(false)
  })

  it('says a new read waits while the shown answer read none of the weeks or projects on screen', () => {
    const shown = planOf(['plan'], W - 2, W + 6)
    const later = nextPlan(shown, markerAsk(['plan'], W + 8, W + 14), true) as MarkerPlan
    const read = ok([row('a', W)])
    const view = markerView(later, read, LOADING, W + 8, W + 14, ['plan'])
    // the slots and Retry stay as for any refresh
    expect(view).toMatchObject({ state: 'refreshing', busy: true, rows: [], retry: null })
    // must fail: an empty display that reads as finished
    expect(view.waiting).toBe(true)
    // a shown answer that stopped at its budget waits the same way
    const stopped = ok([row('a', W)], true, weekToISO(W + 1))
    expect(markerView(later, stopped, LOADING, W + 8, W + 14, ['plan'])).toMatchObject({
      state: 'partial',
      waiting: true,
    })
    // once the new read answers and shows, nothing waits
    const swapped = markerView(swapPlan(later), ok([]), null, W + 8, W + 14, ['plan'])
    expect(swapped).toMatchObject({ state: 'ok', waiting: false })
    // a kept answer that refreshes with no flag in its window is no new read
    expect(markerView(shown, ok([], false), null, W - 2, W + 6, ['plan']).waiting).toBe(false)
    // must fail: projects none of which the shown answer read wait the same
    // way, as after My view's tracks move to other projects
    const other = nextPlan(shown, markerAsk(['luma'], W - 2, W + 6), true) as MarkerPlan
    expect(markerView(other, read, LOADING, W - 2, W + 6, ['luma']).waiting).toBe(true)
    // one more project beside those the shown answer read is no such wait
    const more = nextPlan(shown, markerAsk(['luma', 'plan'], W - 2, W + 6), true) as MarkerPlan
    expect(markerView(more, ok([]), LOADING, W - 2, W + 6, ['luma', 'plan']).waiting).toBe(false)
  })

  it('says a stopped answer is partial, with its flags up to the stop and the day it stopped at', () => {
    const plan = planOf(['plan'], W - 2, W + 6)
    const stopped = weekToISO(W + 1)
    const view = markerView(plan, ok([row('a', W)], true, stopped), null, W - 2, W + 6, ['plan'])
    expect(view.state).toBe('partial')
    expect(view.state).not.toBe('ok')
    expect(view.stopped).toBe(stopped)
    expect(view.rows.map((r) => r.id)).toEqual(['a'])
  })

  it('names each other state, keeping the flags a failure or refusal kept', () => {
    const plan = planOf(['plan'], W - 2, W + 6)
    const kept = answerOf([row('a', W)])
    const view = (read: MarkerRead<Marker>, pending: MarkerRead<Marker> | null = null) =>
      markerView(plan, read, pending, W - 2, W + 6, ['plan'])
    expect(view(LOADING)).toMatchObject({ state: 'loading', busy: true, rows: [] })
    expect(view(ok([row('a', W)], false))).toMatchObject({ state: 'refreshing', busy: true })
    const failed = view({ state: 'failed', kept })
    expect(failed).toMatchObject({ state: 'failed', retry: { shown: true, pending: false } })
    expect(failed.rows.map((r) => r.id)).toEqual(['a'])
    const refused = view({ state: 'refused', reason: 'access_unchecked', sentence: 'No.', kept })
    expect(refused).toMatchObject({
      state: 'refused',
      refusal: { reason: 'access_unchecked', sentence: 'No.' },
      retry: null,
    })
    // a new window's failure keeps the shown flags and retries its own slot
    const pendingFailed = view(ok([row('a', W)]), { state: 'failed', kept: null })
    expect(pendingFailed).toMatchObject({ state: 'failed', retry: { shown: false, pending: true } })
    // must fail: too many projects is no wait and draws no flag
    const many = view({ state: 'too_many' })
    expect(many.state).toBe('too_many')
    expect(many.state).not.toBe('none')
    expect(many.rows).toEqual([])
  })

  it('draws nothing while nothing is asked or no project is named', () => {
    const plan = planOf(['plan'], W - 2, W + 6)
    expect(markerView(null, null, null, W - 2, W + 6, ['plan']).state).toBe('none')
    expect(markerView(plan, ok([row('a', W)]), null, W - 2, W + 6, null)).toMatchObject({
      state: 'none',
      rows: [],
    })
  })
})

describe('markerLine', () => {
  const day = (iso: string) => `[${iso}]`
  const line = (view: Parameters<typeof markerLine>[0], mine = false) => markerLine(view, mine, day)
  const of = (state: Parameters<typeof markerLine>[0]['state']) => ({
    state,
    waiting: false,
    stopped: null,
    refusal: null,
  })

  it('says a wait at once, a failure, a refusal in the server words and too many projects', () => {
    expect(line(of('loading'))).toBe('Loading milestones…')
    expect(line(of('failed'))).toBe("Couldn't load milestones.")
    const tooLarge = { reason: 'milestone_read_too_large', sentence: 'Too large.' }
    expect(line({ ...of('refused'), refusal: tooLarge })).toBe('Too large.')
    expect(line({ ...of('refused'), refusal: tooLarge }, true)).toBe(
      'Too large. Open a project to see its milestones.',
    )
    const unchecked = { reason: 'access_unchecked', sentence: 'Contact support.' }
    expect(line({ ...of('refused'), refusal: unchecked }, true)).toBe('Contact support.')
    expect(line(of('too_many'), true)).toBe(
      'The app reads the milestones of at most 200 projects at once. Choose fewer projects. Open a project to see its milestones.',
    )
  })

  it('says where a stopped answer ends, and what narrows it in a project and in My view', () => {
    const stopped = { ...of('partial'), stopped: '2026-12-07' }
    expect(line(stopped)).toBe(
      'Milestones from [2026-12-07] on may be missing. Choose a shorter window.',
    )
    expect(line(stopped, true)).toBe(
      'Milestones from [2026-12-07] on may be missing. Choose a shorter window or open a project.',
    )
  })

  it('says nothing while the flags are whole, refreshing or not asked', () => {
    for (const state of ['ok', 'refreshing', 'none'] as const) expect(line(of(state))).toBeNull()
  })

  it('says a new read is loading while the shown answer read nothing on screen, also beside a stopped answer', () => {
    // must fail: nothing said while the new window's flags are on their way
    // and the shown answer read none of its weeks
    expect(line({ ...of('refreshing'), waiting: true })).toBe('Loading milestones…')
    const stopped = { ...of('partial'), stopped: '2026-12-07', waiting: true }
    expect(line(stopped, true)).toBe('Loading milestones…')
  })
})
