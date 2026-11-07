import { describe, expect, it } from 'vitest'
import { BY_IDS_MAX, LIMITS, LIST_BATCH } from '../../convex/lib/limits'
import { NO_WRITE_ACCESS, REVIEWER_ON_GROUP } from '../../convex/model/issues'
import {
  type ForcedOwners,
  type OwnerPickerArgs,
  ownerPickersStandIn,
  STAND_IN_SENTENCES,
} from './ownerPickersStandIn.setup'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* The stand-in of a task's people pickers holds the server's shapes, order,
   search, batches, cursors and refusals, and answers each forced state. */

type Batch = Extract<ReturnType<typeof ownerPickersStandIn>, { next: unknown }>

/** The fixture with the people `names` names, users unless `roles` says
    otherwise, and task `t1`. */
function workspace(names: string[], roles: Record<string, string> = {}): Snapshot {
  const snap = plannerFixture()
  const me = snap.profiles[0]
  names.forEach((name, i) => {
    snap.profiles.push({
      ...me,
      id: `p${String(i).padStart(3, '0')}`,
      name,
      auth_user_id: `account-${i}`,
      org_role: (roles[name] ?? 'user') as Snapshot['profiles'][number]['org_role'],
    })
  })
  snap.issues.push({
    id: 't1',
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
    num: 1,
    title: 'Ship the report',
    description: '',
    status: 'todo',
    priority: 'medium',
    paused: false,
    created_at: me.created_at,
    updated_at: me.created_at,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  return snap
}

const ask = (
  ws: Snapshot,
  name: string,
  over: Partial<OwnerPickerArgs> = {},
  force: ForcedOwners = new Set(),
) =>
  ownerPickersStandIn(
    ws,
    name,
    { org_id: ws.orgs[0].id, issue_id: 't1', field: 'assignee', ...over },
    force,
  )

function batch(answer: ReturnType<typeof ownerPickersStandIn>): Batch {
  if (answer.state !== 'ready' || !('next' in answer)) throw new Error(`no batch: ${answer.state}`)
  return answer
}

describe('the owner pickers stand-in', () => {
  it('lists owners in name key order with ties by id, without viewers or switched-off people', () => {
    const ws = workspace(['Émile Roy', 'emile roy', 'Ana Silva', 'Vic Viewer', 'Off Person'], {
      'Vic Viewer': 'viewer',
    })
    const off = ws.profiles.find((p) => p.name === 'Off Person')
    if (off) off.active = false
    const rows = batch(ask(ws, 'pickers:taskOwners')).rows.map((r) => r.name)
    // the caller, an admin, is an owner too
    expect(rows).toEqual(['Ana Silva', 'Émile Roy', 'emile roy', 'Planner'])
    const ids = batch(ask(ws, 'pickers:taskOwners')).rows.map((r) => r.id)
    expect(ids.slice(1, 3)).toEqual(['p000', 'p001'])
  })

  it('lists recipients without agents, switched-off people or the caller', () => {
    const ws = workspace(['Ana Silva', 'Vic Viewer'], { 'Vic Viewer': 'viewer' })
    ws.profiles.push({ ...ws.profiles[1], id: 'agent', name: 'Build Bot', kind: 'agent' })
    const rows = batch(ask(ws, 'pickers:syncRecipients')).rows.map((r) => r.name)
    expect(rows).toEqual(['Ana Silva', 'Vic Viewer'])
  })

  it('keeps every word of the search in the name, ignoring case and accents, never an id', () => {
    const ws = workspace(['Café Owner', 'John Smith', 'Smith Jones'])
    expect(
      batch(ask(ws, 'pickers:taskOwners', { search: 'cafe' })).rows.map((r) => r.name),
    ).toEqual(['Café Owner'])
    expect(
      batch(ask(ws, 'pickers:taskOwners', { search: 'smith john' })).rows.map((r) => r.name),
    ).toEqual(['John Smith'])
    expect(batch(ask(ws, 'pickers:taskOwners', { search: 'jsm' })).rows).toEqual([])
    expect(batch(ask(ws, 'pickers:taskOwners', { search: 'p001' })).rows).toEqual([])
  })

  it('answers LIST_BATCH a batch, and the next batch from its cursor, each person once', () => {
    const names = Array.from({ length: 60 }, (_, i) => `Person ${String(i).padStart(2, '0')}`)
    const ws = workspace(names)
    const first = batch(ask(ws, 'pickers:taskOwners'))
    expect(first.rows).toHaveLength(LIST_BATCH)
    expect(first.next).not.toBeNull()
    const second = batch(ask(ws, 'pickers:taskOwners', { after: first.next ?? undefined }))
    const third = batch(ask(ws, 'pickers:taskOwners', { after: second.next ?? undefined }))
    const all = [...first.rows, ...second.rows, ...third.rows].map((r) => r.id)
    expect(new Set(all).size).toBe(61)
    expect(third.next).toBeNull()
  })

  it('refuses a cursor of another list, field or search, and a search past its limit', () => {
    const ws = workspace(Array.from({ length: 30 }, (_, i) => `Person ${i}`))
    const { next } = batch(ask(ws, 'pickers:taskOwners'))
    const after = next ?? ''
    expect(() => ask(ws, 'pickers:taskOwners', { field: 'reviewer', after })).toThrow(
      STAND_IN_SENTENCES.ownersCursor,
    )
    expect(() => ask(ws, 'pickers:taskOwners', { search: 'person', after })).toThrow(
      STAND_IN_SENTENCES.ownersCursor,
    )
    expect(() => ask(ws, 'pickers:syncRecipients', { after })).toThrow(
      STAND_IN_SENTENCES.recipientsCursor,
    )
    expect(() => ask(ws, 'pickers:taskOwners', { after: 'not a cursor' })).toThrow()
    expect(() =>
      ask(ws, 'pickers:taskOwners', { search: 'a'.repeat(LIMITS.search.max + 1) }),
    ).toThrow(LIMITS.search.refusal)
    // the same search's cursor opens
    expect(() => ask(ws, 'pickers:taskOwners', { after })).not.toThrow()
  })

  it('checks people by id in the order asked, each once, null for one the organization lacks', () => {
    const ws = workspace(['Ana Silva', 'Vic Viewer'], { 'Vic Viewer': 'viewer' })
    const answer = ask(ws, 'pickers:canOwn', { ids: ['p001', 'gone', 'p000', 'p001'] })
    expect(answer).toEqual({
      state: 'ready',
      rows: [
        { id: 'p001', person: expect.objectContaining({ name: 'Vic Viewer' }), eligible: false },
        { id: 'gone', person: null, eligible: false },
        { id: 'p000', person: expect.objectContaining({ name: 'Ana Silva' }), eligible: true },
      ],
    })
    // a viewer may be mentioned
    const recipient = ask(ws, 'pickers:canOwn', { field: 'recipient', ids: ['p001'] })
    expect(recipient).toMatchObject({ state: 'ready', rows: [{ eligible: true }] })
    expect(() =>
      ask(ws, 'pickers:canOwn', {
        ids: Array.from({ length: BY_IDS_MAX + 1 }, (_, i) => `id-${i}`),
      }),
    ).toThrow(`ids must name at most ${BY_IDS_MAX} people`)
    expect(() =>
      ask(ws, 'pickers:canOwn', { ids: Array.from({ length: BY_IDS_MAX }, (_, i) => `id-${i}`) }),
    ).not.toThrow()
  })

  it('answers a task by its organization, unavailable only for one it holds archived', () => {
    const ws = workspace(['Ana Silva'])
    // a task only a view's answer brings
    expect(batch(ask(ws, 'pickers:taskOwners', { issue_id: 'far' })).rows).not.toEqual([])
    const task = ws.issues[0]
    Object.assign(task, { archived_at: '2026-09-15T08:00:00.000Z' })
    expect(ask(ws, 'pickers:taskOwners')).toEqual({ state: 'unavailable' })
    expect(() => ask(ws, 'pickers:taskOwners', { org_id: 'another-org' })).toThrow(
      'no profile in this organization',
    )
  })

  it('answers every forced state', () => {
    const ws = workspace(Array.from({ length: 30 }, (_, i) => `Person ${i}`))
    const forced = (...states: string[]) => new Set(states)
    const stopped = batch(ask(ws, 'pickers:taskOwners', {}, forced('stopped')))
    expect(stopped.stopped).toBe(true)
    expect(stopped.rows.length).toBe(Math.ceil(LIST_BATCH / 2))
    expect(batch(ask(ws, 'pickers:taskOwners', {}, forced('small'))).rows).toHaveLength(5)
    expect(ask(ws, 'pickers:taskOwners', {}, forced('not-ready'))).toEqual({ state: 'not_ready' })
    expect(ask(ws, 'pickers:taskOwners', {}, forced('refused'))).toEqual({
      state: 'refused',
      message: NO_WRITE_ACCESS,
    })
    expect(ask(ws, 'pickers:taskOwners', { field: 'reviewer' }, forced('group'))).toEqual({
      state: 'refused',
      message: REVIEWER_ON_GROUP,
    })
    expect(ask(ws, 'pickers:taskOwners', {}, forced('group')).state).toBe('ready')
    expect(ask(ws, 'pickers:taskOwners', {}, forced('unavailable'))).toEqual({
      state: 'unavailable',
    })
    expect(ask(ws, 'pickers:taskOwners', {}, forced('over-budget'))).toEqual({
      state: 'over_budget',
    })
    expect(() => ask(ws, 'pickers:taskOwners', {}, forced('error'))).toThrow()
    const ids = { ids: ['p000'] }
    expect(() => ask(ws, 'pickers:canOwn', ids, forced('check-error'))).toThrow()
    expect(ask(ws, 'pickers:canOwn', ids, forced('check-ineligible'))).toMatchObject({
      rows: [{ id: 'p000', eligible: false }],
    })
    expect(ask(ws, 'pickers:canOwn', ids, forced('over-budget'))).toEqual({ state: 'over_budget' })
    expect(ask(ws, 'pickers:canOwn', ids, forced('refused')).state).toBe('refused')
    // the lists' failure leaves the check alone, and the check's the lists
    expect(ask(ws, 'pickers:canOwn', ids, forced('error')).state).toBe('ready')
    expect(ask(ws, 'pickers:taskOwners', {}, forced('check-error')).state).toBe('ready')
  })

  it('keeps the server’s sentences', async () => {
    const source = (await import('node:fs')).readFileSync(
      new URL('../../convex/model/pickers.ts', import.meta.url),
      'utf8',
    )
    expect(STAND_IN_SENTENCES.noWrite).toBe(NO_WRITE_ACCESS)
    expect(STAND_IN_SENTENCES.onGroup).toBe(REVIEWER_ON_GROUP)
    expect(source).toContain(STAND_IN_SENTENCES.ownersCursor)
    expect(source).toContain(STAND_IN_SENTENCES.recipientsCursor)
  })
})
