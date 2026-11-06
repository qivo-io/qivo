/* The page's former scope, roster and blocker rules, which the Team sync
   parity oracle keeps (store/teamSyncOracle.setup.ts) since the page reads
   the server's agenda, with the tests they had in src/lib/teamSync.test.ts.
   The oracle still falls back to All projects for a scope it cannot
   honour; the page and the agenda never do (src/lib/teamSync.test.ts and
   store/teamSyncParity.test.ts pin that). */

import { describe, expect, it, vi } from 'vitest'
import type { SyncIssue } from '../lib/teamSync'
import {
  type BlockerIssue,
  blockersOf,
  resolveSyncScope,
  type ScopeWorld,
  type SyncProject,
  scopeMetaIds,
  scopeProjectIds,
  syncRoster,
} from './teamSyncOracle.setup'

// the oracle reads the store only when meetingOf runs, which no case here
// calls
vi.mock('./planner', () => ({ P: {} }))

/* A task with the owner rule applied (convex/lib/review.ts): the reviewer
   while In Review with one, else the assignee. */
const task = (o: Partial<SyncIssue> & { key: string }): SyncIssue => {
  const t: SyncIssue = {
    id: o.key,
    uuid: `uuid-${o.key}`,
    project: 'S1',
    status: 'todo',
    priority: 'medium',
    assignee: undefined,
    reviewer: undefined,
    owner: undefined,
    isGroup: false,
    children: [],
    hasHiddenSubtasks: false,
    links: [],
    start: null,
    due: undefined,
    remaining: 4,
    paused: false,
    updatedAt: 0,
    doneAt: null,
    reviewAt: null,
    statusAt: null,
    createdAt: 0,
    ...o,
  }
  if (!('owner' in o)) t.owner = t.status === 'review' && t.reviewer ? t.reviewer : t.assignee
  return t
}
const byId = (...list: SyncIssue[]): Record<string, BlockerIssue> =>
  Object.fromEntries(list.map((t) => [t.id, t]))

describe("the oracle's scope", () => {
  // M1 (S1, hidden S2) and M2 (S3) at home; a foreign org's F1 (FS1).
  // Team T1 is shared with M1 and, on its own, with S3.
  const meta = (id: string, children: string[], o: Partial<SyncProject> = {}): SyncProject => ({
    id,
    type: 'meta',
    org: 'home',
    parent: undefined,
    children,
    teamAccess: {},
    ...o,
  })
  const sub = (id: string, parent: string, o: Partial<SyncProject> = {}): SyncProject => ({
    id,
    type: 'project',
    org: 'home',
    parent,
    children: undefined,
    teamAccess: {},
    ...o,
  })
  const world: ScopeWorld = {
    homeOrg: 'home',
    projects: [
      meta('M1', ['S1', 'S2'], { teamAccess: { T1: 'user' } }),
      sub('S1', 'M1'),
      sub('S2', 'M1'),
      meta('M2', ['S3']),
      sub('S3', 'M2', { teamAccess: { T1: 'viewer' } }),
      meta('F1', ['FS1'], { org: 'away' }),
      sub('FS1', 'F1', { org: 'away' }),
    ],
    teams: [
      { id: 'T1', org: 'home' },
      { id: 'T2', org: 'away' },
    ],
    canSee: (id) => id !== 'S2',
  }
  const ids = (s: Set<string>) => [...s].sort()

  it('covers every visible home sub-project for all', () => {
    expect(ids(scopeProjectIds({ kind: 'all' }, world))).toEqual(['S1', 'S3'])
    expect(ids(scopeMetaIds({ kind: 'all' }, world))).toEqual(['M1', 'M2'])
  })
  it("covers a team's shares, a meta's through its visible children", () => {
    const team = { kind: 'team', id: 'T1' } as const
    expect(ids(scopeProjectIds(team, world))).toEqual(['S1', 'S3'])
    expect(ids(scopeMetaIds(team, world))).toEqual(['M1', 'M2'])
  })
  it('covers one project, or one sub-project', () => {
    expect(ids(scopeProjectIds({ kind: 'project', id: 'M1' }, world))).toEqual(['S1'])
    expect(ids(scopeProjectIds({ kind: 'project', id: 'S3' }, world))).toEqual(['S3'])
    expect(ids(scopeMetaIds({ kind: 'project', id: 'S3' }, world))).toEqual(['M2'])
  })
  it('falls back to all for a team or project that is gone, foreign or hidden', () => {
    for (const s of [
      { kind: 'team', id: 'gone' },
      { kind: 'team', id: 'T2' },
      { kind: 'project', id: 'gone' },
      { kind: 'project', id: 'F1' },
      { kind: 'project', id: 'S2' },
    ] as const) {
      expect(resolveSyncScope(s, world)).toEqual({ kind: 'all' })
      expect(ids(scopeProjectIds(s, world))).toEqual(['S1', 'S3'])
    }
    expect(resolveSyncScope({ kind: 'team', id: 'T1' }, world)).toEqual({ kind: 'team', id: 'T1' })
  })
})

describe("the oracle's roster", () => {
  const rows = [
    task({ key: 'QN-1', status: 'todo', assignee: 'ben' }),
    task({ key: 'QN-2', status: 'progress', assignee: 'aisha' }),
    task({ key: 'QN-3', status: 'review', assignee: 'leo', reviewer: 'nora' }),
    task({ key: 'QN-4', status: 'progress', assignee: 'atlas' }),
  ]
  const users = [
    { id: 'nora', name: 'Nora Berg', isAgent: false, teams: ['T1'] },
    { id: 'aisha', name: 'Aisha Rahman', isAgent: false, teams: [] },
    { id: 'atlas', name: 'Atlas', isAgent: true, teams: ['T1'] },
    { id: 'ben', name: 'Ben Carter', isAgent: false, teams: ['T1'] },
    { id: 'leo', name: 'Leo Martins', isAgent: false, teams: ['T1'] },
  ]

  it('walks the owners by name, agents last, a reviewer in place of the assignee', () => {
    const r = syncRoster(rows, users, { kind: 'all' })
    expect(r.humans.map((u) => u.id)).toEqual(['aisha', 'ben', 'nora'])
    expect(r.agents.map((u) => u.id)).toEqual(['atlas'])
  })
  it("keeps only the team's members in team scope", () => {
    const r = syncRoster(rows, users, { kind: 'team', id: 'T1' })
    expect(r.humans.map((u) => u.id)).toEqual(['ben', 'nora'])
    expect(r.agents.map((u) => u.id)).toEqual(['atlas'])
  })
})

describe("the oracle's blockers", () => {
  it('lists the open blockers the viewer can see', () => {
    const open = task({ key: 'QN-12', status: 'progress' })
    const done = task({ key: 'QN-13', status: 'done' })
    const t = task({
      key: 'QN-1',
      links: [
        { type: 'blocked_by', id: 'QN-12' },
        { type: 'blocked_by', id: 'QN-13' },
        { type: 'blocked_by', id: 'QN-99' }, // not visible to the viewer
        { type: 'blocks', id: 'QN-14' },
      ],
    })
    expect(blockersOf(t, byId(open, done))).toEqual(['QN-12'])
  })
  it('treats a group blocker as open until all its leaves are done', () => {
    const leafA = task({ key: 'QN-2', status: 'done' })
    const leafB = task({ key: 'QN-3', status: 'progress' })
    const group = task({ key: 'QN-1', status: 'todo', children: ['QN-2', 'QN-3'] })
    const t = task({ key: 'QN-9', links: [{ type: 'blocked_by', id: 'QN-1' }] })
    expect(blockersOf(t, byId(group, leafA, leafB))).toEqual(['QN-1'])
    expect(blockersOf(t, byId(group, leafA, { ...leafB, status: 'done' }))).toEqual([])
  })
})
