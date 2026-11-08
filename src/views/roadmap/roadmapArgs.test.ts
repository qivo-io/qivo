import { describe, expect, it } from 'vitest'
import { LIMITS } from '../../../convex/lib/limits'
import { resolveWin, setWeekConfig, TODAY_WEEK, weekToISO } from '../../lib/dates'
import type { IssueFilters } from '../../store/planner'
import { keepsRoadmap, roadmapRequest, textChanged } from './roadmapArgs'

/* The Roadmap's request (roadmapArgs.ts): one key in a fixed order for the
   selection, the filter row and the window on screen, the dependency read's
   key its scope alone, and which changes keep the last answer on screen. */

const ROW: IssueFilters = {
  mine: false,
  assignees: [],
  priority: null,
  stale: false,
  focus: false,
  search: '',
}
const project = { wide: false, mine: false, id: 'plan', proj: { org: 'org-1' } }
const mine = { wide: true, mine: true, id: 'mine', proj: null }
const win = { w0: TODAY_WEEK - 2, w1: TODAY_WEEK + 6 }

/** The arguments of a request that asks. */
function argsOf(request: ReturnType<typeof roadmapRequest>) {
  if (request.kind !== 'ask') throw new Error(`asks nothing: ${request.kind}`)
  return { key: JSON.parse(request.key), deps: JSON.parse(request.deps), raw: request }
}

describe("the Roadmap's request", () => {
  it('names the scope, the filter row, the window and the planned task in a fixed order', () => {
    const { key, raw } = argsOf(
      roadmapRequest(
        project,
        { ...ROW, assignees: ['b', 'a', 'b'], priority: 'high', search: '  pcb  ' },
        win,
        { id: 'task-1', project_id: 'sub-1' },
      ),
    )
    expect(Object.keys(key)).toEqual(['scope', 'filters', 'window', 'planned_task'])
    expect(Object.keys(key.filters)).toEqual(['mine', 'owners', 'priority', 'search'])
    expect(key).toEqual({
      scope: { kind: 'project', org_id: 'org-1', project_id: 'plan' },
      // the people deduplicated and sorted, the text trimmed
      filters: { mine: false, owners: ['a', 'b'], priority: 'high', search: 'pcb' },
      window: { from: weekToISO(win.w0), to: weekToISO(win.w1) },
      planned_task: { id: 'task-1', project_id: 'sub-1' },
    })
    // equal selections share one key, whatever the order of the people
    const again = roadmapRequest(
      project,
      { ...ROW, assignees: ['a', 'b'], priority: 'high', search: 'pcb' },
      win,
      { id: 'task-1', project_id: 'sub-1' },
    )
    expect(again.kind === 'ask' && again.key).toBe(raw.key)
  })

  it('asks My view for the person’s own tasks with no people filter, and nothing planned', () => {
    const { key } = argsOf(roadmapRequest(mine, { ...ROW, assignees: ['a'] }, win, null))
    expect(key.scope).toEqual({ kind: 'mine' })
    expect(key.filters).toEqual({ mine: true, owners: [], priority: null, search: '' })
    expect(key).not.toHaveProperty('planned_task')
  })

  it('sends a Priority only the server knows, and a text filter past its limit not at all', () => {
    expect(
      argsOf(roadmapRequest(project, { ...ROW, priority: 'none' }, win, null)).key.filters,
    ).toMatchObject({ priority: null })
    const long = 'x'.repeat(LIMITS.search.max + 1)
    expect(roadmapRequest(project, { ...ROW, search: long }, win, null)).toEqual({
      kind: 'search_limit',
    })
    // at the limit it is sent
    const at = 'x'.repeat(LIMITS.search.max)
    expect(roadmapRequest(project, { ...ROW, search: at }, win, null).kind).toBe('ask')
  })

  it('asks for My view as the mine scope, and never asks to choose a project', () => {
    expect(roadmapRequest(mine, ROW, win, null).kind).toBe('ask')
  })

  it('sends the first days of the window’s first and last weeks, on a grid whose week starts on Sunday too', () => {
    const { w0, w1 } = resolveWin({
      start: { mode: 'weeks', value: -2 },
      end: { mode: 'weeks', value: 6 },
    })
    const monday = argsOf(roadmapRequest(project, ROW, { w0, w1 }, null)).key.window
    expect(new Date(`${monday.from}T00:00:00Z`).getUTCDay()).toBe(1)
    expect((Date.parse(monday.to) - Date.parse(monday.from)) / 86_400_000).toBe((w1 - w0) * 7)
    setWeekConfig(0)
    try {
      const sunday = argsOf(roadmapRequest(project, ROW, { w0, w1 }, null)).key.window
      expect(new Date(`${sunday.from}T00:00:00Z`).getUTCDay()).toBe(0)
      // the grid moved, so the window asks afresh
      expect(sunday).not.toEqual(monday)
    } finally {
      setWeekConfig()
    }
  })

  it('keeps the dependency read’s key on a pan, a filter and a keystroke, and changes it with the scope', () => {
    const base = argsOf(roadmapRequest(project, ROW, win, null))
    const moved = [
      roadmapRequest(project, ROW, { w0: win.w0 + 5, w1: win.w1 + 5 }, null),
      roadmapRequest(project, { ...ROW, priority: 'high' }, win, null),
      roadmapRequest(project, { ...ROW, search: 'p' }, win, null),
      roadmapRequest(project, ROW, win, { id: 't', project_id: 's' }),
    ]
    for (const request of moved) {
      const { key, raw } = argsOf(request)
      expect(raw.deps).toBe(base.raw.deps)
      expect(key).not.toEqual(base.key)
    }
    expect(base.deps).toEqual({ scope: { kind: 'project', org_id: 'org-1', project_id: 'plan' } })
    // a key that holds the window would rerun the dependency read on a pan
    const withWindow = JSON.stringify({ scope: base.key.scope, window: base.key.window })
    expect(withWindow).not.toBe(base.raw.deps)
    expect(argsOf(roadmapRequest(mine, ROW, win, null)).raw.deps).not.toBe(base.raw.deps)
  })
})

describe('which changes keep the last answer on screen', () => {
  const key = (
    filters: Partial<IssueFilters>,
    w = win,
    planned = null as null | { id: string; project_id: string },
  ) => {
    const request = roadmapRequest(project, { ...ROW, ...filters }, w, planned)
    if (request.kind !== 'ask') throw new Error('asks nothing')
    return request.key
  }
  it('keeps it for a pan, a new planned task and typing that narrows the text', () => {
    expect(keepsRoadmap(key({}), key({}, { w0: win.w0 + 3, w1: win.w1 + 3 }))).toBe(true)
    expect(keepsRoadmap(key({}), key({}, win, { id: 't', project_id: 's' }))).toBe(true)
    expect(keepsRoadmap(key({ search: 'pc' }), key({ search: 'pcb' }))).toBe(true)
    expect(keepsRoadmap(key({ search: 'pcb' }), key({ search: 'pcb review' }))).toBe(true)
    // the first letters typed narrow a Roadmap with no text filter
    expect(keepsRoadmap(key({}), key({ search: 'pcb' }))).toBe(true)
    expect(textChanged(key({ search: 'pc' }), key({ search: 'pcb' }))).toBe(true)
    expect(textChanged(key({}), key({}, { w0: win.w0 + 3, w1: win.w1 + 3 }))).toBe(false)
  })
  it('drops it for another filter, a deleted letter, another scope or the same key', () => {
    expect(keepsRoadmap(key({}), key({ priority: 'high' }))).toBe(false)
    expect(keepsRoadmap(key({}), key({ mine: true }))).toBe(false)
    expect(keepsRoadmap(key({ search: 'pcb' }), key({ search: 'pc' }))).toBe(false)
    const other = roadmapRequest({ ...project, id: 'other' }, ROW, win, null)
    expect(keepsRoadmap(key({}), other.kind === 'ask' ? other.key : '')).toBe(false)
    expect(keepsRoadmap(key({}), key({}))).toBe(false)
  })
})
