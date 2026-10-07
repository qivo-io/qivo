/* The /v1/* REST surface — convex-test coverage of the internal endpoint
 * functions plus an authenticated task-route round trip through t.fetch.
 * The live contract suite additionally checks deployed routing, CORS,
 * authentication envelopes and real concurrency.
 *
 * Byte-asserts every refusal sentence, the 403-vs-404 oracle asymmetry (the
 * ONE oracle is POST /v1/tasks' top-level project ref), the viewer-agent
 * write refusals (0102, both viewer shapes), and the machine activity grammar
 * (verb + `— via the REST API (<keyName>)` suffix) including the folded
 * fields+archived single PATCH: one row write, one fan-out, one activity row,
 * plus the cascade with its suppression semantics. */

import { describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { Refusal, RefusalCode } from '../lib/functions'
import { classifySecret, REST_AUTH_401, sha256hex } from '../machine/auth'
import {
  activityFor,
  expectRefusal,
  messagesFor,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  plantSubscription,
  type T,
  tick,
  uuid,
  withOrg,
} from './helpers.setup'

const KEY = 'drive'
const VIA = 'via the REST API (drive)'
const NO_WRITE = 'this agent has no write access to that project'

/* Byte-exact refusal assertion. */
async function refused(p: Promise<unknown>, code: RefusalCode, sentence: string): Promise<Refusal> {
  const e = await expectRefusal(p, code)
  const data = e.data as Refusal
  expect(data.message).toBe(sentence)
  return data
}

/* withOrg + an agent-shaped grant: the fixture agent holds a `user`
 * grant on the TBED meta (reads+writes FW/PCB); SKNK stays invisible. */
async function machineOrg(t: T): Promise<OrgFixture> {
  const f = await withOrg(t)
  await t.run(async (ctx) => {
    await ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    })
  })
  return f
}

async function plantAgent(
  t: T,
  orgId: string,
  name: string,
  orgRole: 'user' | 'viewer',
): Promise<Doc<'profiles'>> {
  return await t.run(async (ctx) => {
    const _id = await ctx.db.insert('profiles', {
      id: uuid(),
      org_id: orgId,
      name,
      initials: 'AG',
      color: '#444444',
      org_role: orgRole,
      active: true,
      kind: 'agent',
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'profiles'>
  })
}

const grant = (
  t: T,
  projectId: string,
  profileId: string,
  level: 'user' | 'viewer',
): Promise<void> =>
  t.run(async (ctx) => {
    await ctx.db.insert('project_access', { project_id: projectId, profile_id: profileId, level })
  })

const archiveProject = (t: T, p: Doc<'projects'>): Promise<void> =>
  t.run(async (ctx) => {
    await ctx.db.patch(p._id, { archived_at: NOW })
  })

const issueRow = (t: T, id: string): Promise<Doc<'issues'> | null> =>
  t.run(
    async (ctx) =>
      await ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique(),
  )

/* ------------------------------------------------------------------- auth */

describe('REST task routes', () => {
  it('serves task CRUD and comments under /v1/tasks and refuses the old resource name', async () => {
    const t = newT()
    const fixture = await machineOrg(t)
    const secret = `qva_${'task-route'.repeat(6)}`
    const keyHash = await sha256hex(secret)
    await t.run(async (ctx) => {
      await ctx.db.insert('agent_keys', {
        id: uuid(),
        profile_id: fixture.agent.id,
        name: KEY,
        key_prefix: secret.slice(0, 11),
        key_hash: keyHash,
        created_at: NOW,
      })
    })
    const http = t as unknown as {
      fetch(
        path: string,
        init: { method: string; headers: Record<string, string>; body?: string },
      ): Promise<Response>
    }
    const request = (method: string, path: string, body?: unknown) =>
      http.fetch(path, {
        method,
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    const jsonBody = async (response: Response): Promise<unknown> =>
      JSON.parse(await (response as unknown as { text(): Promise<string> }).text())

    const created = await request('POST', '/v1/tasks', {
      project: fixture.sub.key,
      title: 'Task route round trip',
    })
    expect(created.status).toBe(201)
    const task = (await jsonBody(created)) as { id: string; key: string }
    const path = `/v1/tasks/${task.key}`
    const fetched = await request('GET', path)
    expect(fetched.status).toBe(200)
    expect(await jsonBody(fetched)).toMatchObject(task)
    const listed = await request('GET', '/v1/tasks')
    expect(listed.status).toBe(200)
    expect(await jsonBody(listed)).toEqual([expect.objectContaining({ id: task.id })])

    const commented = await request('POST', `${path}/comments`, { body: 'A task comment' })
    expect(commented.status).toBe(201)
    const comment = await jsonBody(commented)
    expect(comment).toMatchObject({ task_id: task.id, body: 'A task comment' })
    expect(comment).not.toHaveProperty('issue_id')
    const comments = await request('GET', `${path}/comments`)
    expect(comments.status).toBe(200)
    expect(await jsonBody(comments)).toEqual([comment])

    for (const [method, oldPath, body] of [
      ['GET', '/v1/issues'],
      ['POST', '/v1/issues', { project: fixture.sub.key, title: 'Old route' }],
      ['GET', `/v1/issues/${task.key}`],
      ['PATCH', `/v1/issues/${task.key}`, { title: 'Old route' }],
      ['DELETE', `/v1/issues/${task.key}`],
      ['GET', `/v1/issues/${task.key}/comments`],
      ['POST', `/v1/issues/${task.key}/comments`, { body: 'Old route' }],
    ] as const) {
      const refused = await request(method, oldPath, body)
      expect(refused.status).toBe(404)
      expect(await jsonBody(refused)).toEqual({ error: 'unknown route' })
    }

    const patched = await request('PATCH', path, { title: 'Updated task' })
    expect(patched.status).toBe(200)
    expect(await jsonBody(patched)).toMatchObject({ id: task.id, title: 'Updated task' })
    const deleted = await request('DELETE', path)
    expect(deleted.status).toBe(200)
    expect(await jsonBody(deleted)).toEqual({ deleted: true, id: task.id, key: task.key })
  })
})

describe('REST auth surface', () => {
  it('the five 401 sentences are the deployed bytes; wrong_kind reads as unknown', () => {
    expect(REST_AUTH_401).toEqual({
      missing: 'missing agent key (Authorization: Bearer qva_…)',
      unknown: 'unknown agent key',
      revoked: 'this agent key has been revoked',
      inactive: 'this agent has been deactivated',
      wrong_kind: 'unknown agent key',
    })
  })

  it('prefix routing: qva_ only — a qvt_ on REST is the missing failure, pre-hash', () => {
    expect(classifySecret('qva_abc', { person: false })).toEqual({ isAgent: true })
    expect(classifySecret('qvt_abc', { person: false })).toBeNull() // → REST_AUTH_401.missing
    expect(classifySecret('qvt_abc', { person: true })).toEqual({ isAgent: false })
    expect(classifySecret('sk-something', { person: false })).toBeNull()
    expect(classifySecret('', { person: false })).toBeNull()
  })

  it('lookupCredential walks unknown → revoked → wrong_kind → inactive in order', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const hash = 'a'.repeat(64)
    expect(await t.query(internal.machine.auth.lookupCredential, { hash, isAgent: true })).toEqual({
      ok: false,
      why: 'unknown',
      isAgent: true,
    })
    const keyId = uuid()
    await t.run(async (ctx) => {
      await ctx.db.insert('agent_keys', {
        id: keyId,
        profile_id: f.agent.id,
        name: 'Default key',
        key_prefix: 'qva_test',
        key_hash: hash,
        created_at: NOW,
      })
    })
    const ok = await t.query(internal.machine.auth.lookupCredential, { hash, isAgent: true })
    expect(ok).toEqual({
      ok: true,
      cred: {
        profileId: f.agent.id,
        orgId: f.org.id,
        tokenId: keyId,
        rowId: expect.any(String),
        isAgent: true,
        keyName: 'Default key',
      },
    })
    // a revoked key of a deactivated agent answers revoked — order is observable
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('agent_keys')
        .withIndex('by_hash', (q) => q.eq('key_hash', hash))
        .unique()
      await ctx.db.patch(row!._id, { revoked_at: NOW })
      await ctx.db.patch(f.agent._id, { active: false })
    })
    expect(await t.query(internal.machine.auth.lookupCredential, { hash, isAgent: true })).toEqual({
      ok: false,
      why: 'revoked',
      isAgent: true,
    })
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('agent_keys')
        .withIndex('by_hash', (q) => q.eq('key_hash', hash))
        .unique()
      await ctx.db.patch(row!._id, { revoked_at: undefined })
    })
    expect(await t.query(internal.machine.auth.lookupCredential, { hash, isAgent: true })).toEqual({
      ok: false,
      why: 'inactive',
      isAgent: true,
    })
  })

  it('the auth-to-dispatch race: gone/deactivated callers answer their reason marks', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const gone = await refused(
      t.query(internal.machine.rest.listUsers, { callerId: uuid() }),
      'forbidden',
      'unknown agent key',
    )
    expect(gone.reason).toBe('caller_gone')
    await t.run(async (ctx) => {
      await ctx.db.patch(f.agent._id, { active: false })
    })
    const dead = await refused(
      t.query(internal.machine.rest.listUsers, { callerId: f.agent.id }),
      'forbidden',
      'this agent has been deactivated',
    )
    expect(dead.reason).toBe('caller_deactivated')
  })
})

/* --------------------------------------------------------------- projects */

describe('GET /v1/projects', () => {
  it('lists readable projects with access flags, key-sorted; archived= flips the axis', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const rows = await t.query(internal.machine.rest.listProjects, { callerId: f.agent.id })
    expect(rows.map((p) => p.key)).toEqual(['FW', 'PCB', 'TBED']) // SKNK invisible
    expect(rows[2]).toEqual({
      id: f.meta.id,
      key: 'TBED',
      num: 1,
      name: 'Testbed platform',
      type: 'meta',
      parent_id: null,
      team_id: null,
      description: '',
      archived: false,
      archived_at: null,
      access: { read: true, write: true },
    })
    await archiveProject(t, f.sub2)
    const live = await t.query(internal.machine.rest.listProjects, { callerId: f.agent.id })
    expect(live.map((p) => p.key)).toEqual(['FW', 'TBED'])
    const archived = await t.query(internal.machine.rest.listProjects, {
      callerId: f.agent.id,
      archived: 'true',
    })
    expect(archived.map((p) => p.key)).toEqual(['PCB'])
    expect(archived[0].archived).toBe(true)
    expect(typeof archived[0].archived_at).toBe('string')
    await refused(
      t.query(internal.machine.rest.listProjects, { callerId: f.agent.id, archived: 'maybe' }),
      'bad_request',
      'archived must be true or false',
    )
  })

  it('the viewer ceiling (0102): both viewer shapes read, neither writes', async () => {
    const t = newT()
    const f = await withOrg(t)
    const roleViewer = await plantAgent(t, f.org.id, 'Role viewer bot', 'viewer')
    await grant(t, f.meta.id, roleViewer.id, 'user') // org-role viewer holding a user grant
    const grantViewer = await plantAgent(t, f.org.id, 'Grant viewer bot', 'user')
    await grant(t, f.meta.id, grantViewer.id, 'viewer') // grant-level viewer
    for (const bot of [roleViewer, grantViewer]) {
      const rows = await t.query(internal.machine.rest.listProjects, { callerId: bot.id })
      expect(rows.map((p) => p.key)).toEqual(['FW', 'PCB', 'TBED'])
      for (const p of rows) expect(p.access).toEqual({ read: true, write: false })
    }
  })
})

describe('GET /v1/projects/{ref}', () => {
  it('resolves by key (any case), per-org number and uuid (any case), archived included', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const byKey = await t.query(internal.machine.rest.getProject, {
      callerId: f.agent.id,
      ref: 'tbed',
    })
    expect(byKey.id).toBe(f.meta.id)
    const byNum = await t.query(internal.machine.rest.getProject, {
      callerId: f.agent.id,
      ref: '2',
    })
    expect(byNum.id).toBe(f.sub.id)
    const byUuid = await t.query(internal.machine.rest.getProject, {
      callerId: f.agent.id,
      ref: f.sub2.id.toUpperCase(),
    })
    expect(byUuid.id).toBe(f.sub2.id)
    await archiveProject(t, f.sub2)
    const archived = await t.query(internal.machine.rest.getProject, {
      callerId: f.agent.id,
      ref: 'PCB',
    })
    expect(archived.archived).toBe(true)
  })

  it('unknown and unreadable both answer the one 404 — NO oracle on GET', async () => {
    const t = newT()
    const f = await machineOrg(t)
    await refused(
      t.query(internal.machine.rest.getProject, { callerId: f.agent.id, ref: 'NOPE' }),
      'not_found',
      'project not found',
    )
    await refused(
      t.query(internal.machine.rest.getProject, { callerId: f.agent.id, ref: 'SKNK' }),
      'not_found',
      'project not found',
    )
  })
})

describe('GET /v1/projects/{ref}/users', () => {
  it('returns only project-visible profiles and marks assignment eligibility', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const inaccessible = await plantSeat(t, { org_id: f.org.id, name: 'No project access' })
    const inactive = await plantSeat(t, { org_id: f.org.id, name: 'Inactive visible' })
    await grant(t, f.meta.id, inactive.id, 'user')
    await t.run(async (ctx) => {
      await ctx.db.patch(inactive._id, { active: false })
    })

    const rows = await t.query(internal.machine.rest.listProjectUsers, {
      callerId: f.agent.id,
      ref: 'fw',
    })
    expect(rows.some((u) => u.id === inaccessible.id)).toBe(false)
    expect(rows.map((u) => u.id).sort()).toEqual(
      [f.admin.id, f.user.id, f.viewer.id, f.guest.id, f.agent.id, inactive.id].sort(),
    )
    expect(rows.find((u) => u.id === f.viewer.id)).toEqual({
      id: f.viewer.id,
      name: 'viewer',
      org_role: 'viewer',
      kind: 'person',
      active: true,
      plannable_hours: 40,
      assignable: false,
    })
    expect(rows.find((u) => u.id === inactive.id)?.assignable).toBe(false)
    expect(rows.find((u) => u.id === f.agent.id)?.assignable).toBe(true)
  })

  it('keeps unknown and unreadable projects behind the same 404', async () => {
    const t = newT()
    const f = await machineOrg(t)
    for (const ref of ['NOPE', 'SKNK']) {
      await refused(
        t.query(internal.machine.rest.listProjectUsers, { callerId: f.agent.id, ref }),
        'not_found',
        'project not found',
      )
    }
  })
})

/* ------------------------------------------------------------------ users */

describe('/v1/users', () => {
  it('the roster is org-fenced, name-ordered, shape-exact — null hours for agents, no email', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const rows = await t.query(internal.machine.rest.listUsers, { callerId: f.agent.id })
    expect(rows.map((u) => u.name)).toEqual(['admin', 'guest', 'Relay', 'user', 'viewer'])
    const relay = rows.find((u) => u.id === f.agent.id)
    expect(relay).toEqual({
      id: f.agent.id,
      name: 'Relay',
      org_role: 'user',
      kind: 'agent',
      active: true,
      plannable_hours: null, // null, never 0 (0103)
    })
    expect(relay !== undefined && 'email' in relay).toBe(false)
    const person = rows.find((u) => u.id === f.user.id)
    expect(person?.plannable_hours).toBe(40)
  })

  it('not gated on a project grant — a grantless agent still reads the roster', async () => {
    const t = newT()
    const f = await withOrg(t)
    const rows = await t.query(internal.machine.rest.listUsers, { callerId: f.agent.id })
    expect(rows.length).toBe(5)
  })

  it('GET /v1/users/{id}: case-insensitive exact id; unknown → 404', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const one = await t.query(internal.machine.rest.getUser, {
      callerId: f.agent.id,
      ref: f.user.id.toUpperCase(),
    })
    expect(one.id).toBe(f.user.id)
    await refused(
      t.query(internal.machine.rest.getUser, { callerId: f.agent.id, ref: uuid() }),
      'not_found',
      'user not found',
    )
  })
})

/* ------------------------------------------------------------ list issues */

describe('GET /v1/tasks', () => {
  it('default lists live issues of readable live projects; archived= flips the task axis', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const i1 = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'API issue alpha',
      reporter_id: f.user.id,
      created_by: f.agent.id,
    })
    const i2 = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      title: 'Other, thing here',
    })
    const gone = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'put away',
      archived_at: NOW,
    })
    await plantIssue(t, { org_id: f.org.id, project_id: f.hidden.id, title: 'invisible' })
    const rows = await t.query(internal.machine.rest.listIssues, { callerId: f.agent.id })
    expect(rows.map((i) => i.id)).toEqual([i1.id, i2.id]) // created order, num tiebreak
    expect(rows[0]).toMatchObject({
      reporter_id: f.user.id,
      reporter_name: 'user',
    })
    const archived = await t.query(internal.machine.rest.listIssues, {
      callerId: f.agent.id,
      archived: 'true',
    })
    expect(archived.map((i) => i.id)).toEqual([gone.id])
    expect(archived[0].archived).toBe(true)
    await refused(
      t.query(internal.machine.rest.listIssues, { callerId: f.agent.id, archived: 'maybe' }),
      'bad_request',
      'archived must be true or false',
    )
  })

  it('the two archive axes: an archived project leaves the default list; naming it asks for it', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const inSub = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'live one' })
    const inSub2 = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      title: 'in archived project',
    })
    await archiveProject(t, f.sub2)
    const dflt = await t.query(internal.machine.rest.listIssues, { callerId: f.agent.id })
    expect(dflt.map((i) => i.id)).toEqual([inSub.id])
    // a live meta offers itself as it stands — the archived sub stays out
    const viaMeta = await t.query(internal.machine.rest.listIssues, {
      callerId: f.agent.id,
      project: 'TBED',
    })
    expect(viaMeta.map((i) => i.id)).toEqual([inSub.id])
    // naming the archived sub directly puts its tasks back
    const direct = await t.query(internal.machine.rest.listIssues, {
      callerId: f.agent.id,
      project: 'PCB',
    })
    expect(direct.map((i) => i.id)).toEqual([inSub2.id])
    // an archived meta is asked for as it was put away — every kid comes
    await archiveProject(t, f.meta)
    const viaArchivedMeta = await t.query(internal.machine.rest.listIssues, {
      callerId: f.agent.id,
      project: 'TBED',
    })
    expect(viaArchivedMeta.map((i) => i.id)).toEqual([inSub.id, inSub2.id])
  })

  it('project refs: unknown and invisible answer the one 404 — no oracle on GET scope', async () => {
    const t = newT()
    const f = await machineOrg(t)
    await refused(
      t.query(internal.machine.rest.listIssues, { callerId: f.agent.id, project: 'NOPE' }),
      'not_found',
      'project not found',
    )
    await refused(
      t.query(internal.machine.rest.listIssues, { callerId: f.agent.id, project: 'SKNK' }),
      'not_found',
      'project not found',
    )
  })

  it('filters validate with the deployed sentences and narrow the list', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const hot = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'hot',
      status: 'review',
      priority: 'urgent',
      assignee_id: f.user.id,
    })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'cold' })
    const byStatus = await t.query(internal.machine.rest.listIssues, {
      callerId: f.agent.id,
      status: 'review',
    })
    expect(byStatus.map((i) => i.id)).toEqual([hot.id])
    const byPriority = await t.query(internal.machine.rest.listIssues, {
      callerId: f.agent.id,
      priority: 'urgent',
    })
    expect(byPriority.map((i) => i.id)).toEqual([hot.id])
    const byAssignee = await t.query(internal.machine.rest.listIssues, {
      callerId: f.agent.id,
      assignee: f.user.id.toUpperCase(),
    })
    expect(byAssignee.map((i) => i.id)).toEqual([hot.id])
    await refused(
      t.query(internal.machine.rest.listIssues, { callerId: f.agent.id, status: 'closed' }),
      'bad_request',
      'status must be one of backlog, todo, progress, review, done',
    )
    await refused(
      t.query(internal.machine.rest.listIssues, { callerId: f.agent.id, priority: 'top' }),
      'bad_request',
      'priority must be one of urgent, high, medium, low',
    )
    await refused(
      t.query(internal.machine.rest.listIssues, { callerId: f.agent.id, assignee: 'not-a-uuid' }),
      'bad_request',
      'assignee must be a profile uuid',
    )
  })

  it('search matches every fragment across title and description; * widens, commas stay literal', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const alpha = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'API issue alpha',
    })
    const comma = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Other, thing here',
      description: 'body text',
    })
    const inDesc = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'plain',
      description: 'the ALPHA lives here',
    })
    const starred = await t.query(internal.machine.rest.listIssues, {
      callerId: f.agent.id,
      search: 'API*alpha',
    })
    expect(starred.map((i) => i.id)).toEqual([alpha.id])
    const commas = await t.query(internal.machine.rest.listIssues, {
      callerId: f.agent.id,
      search: 'other, th',
    })
    expect(commas.map((i) => i.id)).toEqual([comma.id])
    const ci = await t.query(internal.machine.rest.listIssues, {
      callerId: f.agent.id,
      search: 'alpha',
    })
    expect(ci.map((i) => i.id)).toEqual([alpha.id, inDesc.id]) // title OR description
    const none = await t.query(internal.machine.rest.listIssues, {
      callerId: f.agent.id,
      search: 'zzz',
    })
    expect(none).toEqual([])
  })

  it('search accepts reordered partial words, task IDs and words spread across fields', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Add signed firmware updates and rollback',
      description: 'Release recovery checklist',
    })
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Add mobile updates',
    })
    for (const search of [
      'signed firm',
      'upd firm',
      'add back',
      'add rollback',
      'and add sign',
      '  BACK\tSIGN ',
      `qn-${task.num} firm`,
      'recovery firm',
      'roll*back sign',
    ]) {
      const rows = await t.query(internal.machine.rest.listIssues, {
        callerId: f.agent.id,
        search,
      })
      expect(
        rows.map((row) => row.id),
        search,
      ).toEqual([task.id])
    }
    const missing = await t.query(internal.machine.rest.listIssues, {
      callerId: f.agent.id,
      search: 'signed mobile',
    })
    expect(missing).toEqual([])
  })

  it('limit/offset keep the deployed parsing quirks: 0/NaN → 100, negatives clamp', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const a = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'first' })
    const b = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'second' })
    const c = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'third' })
    const call = (params: { limit?: string; offset?: string }) =>
      t.query(internal.machine.rest.listIssues, { callerId: f.agent.id, ...params })
    expect((await call({ limit: '1' })).map((i) => i.id)).toEqual([a.id])
    expect((await call({ limit: '1', offset: '1' })).map((i) => i.id)).toEqual([b.id])
    expect((await call({ limit: 'abc' })).map((i) => i.id)).toEqual([a.id, b.id, c.id]) // NaN → 100
    expect((await call({ limit: '0' })).map((i) => i.id)).toEqual([a.id, b.id, c.id]) // 0 → 100
    expect((await call({ limit: '-5' })).map((i) => i.id)).toEqual([a.id]) // → 1
    expect((await call({ offset: 'abc' })).map((i) => i.id)).toEqual([a.id, b.id, c.id]) // → 0
  })
})

/* -------------------------------------------------------------- get issue */

describe('GET /v1/tasks/{ref}', () => {
  it('QN-num (any case), bare num and uuid (any case) resolve; archived resolves too', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const row = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'findable',
      archived_at: NOW,
      reporter_id: f.user.id,
      created_by: f.agent.id,
    })
    for (const ref of [`qn-${row.num}`, String(row.num), row.id.toUpperCase()]) {
      const out = await t.query(internal.machine.rest.getIssue, { callerId: f.agent.id, ref })
      expect(out.id).toBe(row.id)
      expect(out.key).toBe(`QN-${row.num}`)
      expect(out.archived).toBe(true)
      expect(out.reporter_id).toBe(f.user.id)
      expect(out.reporter_name).toBe('user')
      expect(out).not.toHaveProperty('creator_id')
      expect(out).not.toHaveProperty('creator_name')
    }
  })

  it('misses are clean 404s: unknown, out-of-int4, invisible, foreign-org', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const hiddenIssue = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.hidden.id,
      title: 'no see',
    })
    const foreign = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
      title: 'other org',
    })
    for (const ref of [
      'QN-999999',
      'QN-3000000000',
      'not-a-ref',
      hiddenIssue.id,
      foreign.id,
      String(foreign.num),
    ]) {
      await refused(
        t.query(internal.machine.rest.getIssue, { callerId: f.agent.id, ref }),
        'not_found',
        'task not found',
      )
    }
  })
})

/* ----------------------------------------------------------- create issue */

describe('POST /v1/tasks', () => {
  it('creates in a sub of the named project, answers the full explicit-null shape, narrates with provenance', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const out = await t.mutation(internal.machine.rest.createIssue, {
      callerId: f.agent.id,
      keyName: KEY,
      body: JSON.stringify({ project: 'TBED', sub_project: 'fw', title: 'Machine made' }),
    })
    expect(out).toEqual({
      id: out.id,
      key: `QN-${out.num}`,
      num: out.num,
      project_id: f.sub.id,
      project_key: 'FW',
      project_num: 2,
      title: 'Machine made',
      description: '',
      status: 'backlog',
      is_group: false,
      priority: 'low',
      assignee_id: null,
      assignee_name: null,
      reviewer_id: null,
      reviewer_name: null,
      reporter_id: f.agent.id,
      reporter_name: 'Relay',
      parent_id: null,
      start_week: null,
      end_week: null,
      due_date: null,
      remaining_hours: null,
      remaining_set_at: null,
      paused: false,
      archived: false,
      archived_at: null,
      created_at: out.created_at,
      updated_at: out.updated_at,
    })
    expect('project_name' in out).toBe(false)
    expect('created_by' in out).toBe(false)
    const acts = await activityFor(t, f.org.id)
    expect(acts).toHaveLength(1)
    expect(acts[0].verb).toBe('created')
    expect(acts[0].label).toBe('Machine made')
    expect(acts[0].detail).toBe(VIA)
    expect(acts[0].actor_id).toBe(f.agent.id)
    expect(acts[0].project_id).toBe(f.sub.id)
  })

  it('accepts a selected reporter and attributes notifications and activity to the actor', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const out = await t.mutation(internal.machine.rest.createIssue, {
      callerId: f.agent.id,
      keyName: KEY,
      body: JSON.stringify({
        project: 'FW',
        title: 'Handed over',
        assignee_id: f.user.id.toUpperCase(),
        reporter_id: f.user.id.toUpperCase(),
      }),
    })
    expect(out.project_id).toBe(f.sub.id)
    expect(out.assignee_id).toBe(f.user.id) // stored lowercase
    expect(out.assignee_name).toBe('user')
    expect(out.reporter_id).toBe(f.user.id)
    expect(out.reporter_name).toBe('user')
    expect(out).not.toHaveProperty('creator_id')
    expect(out).not.toHaveProperty('creator_name')
    const msgs = await messagesFor(t, f.user.id, out.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].detail).toBe('Assigned to you')
    expect(msgs[0].actor_id).toBe(f.agent.id)
  })

  it('rejects an explicit null reporter without creating a task or activity', async () => {
    const t = newT()
    const f = await machineOrg(t)
    await refused(
      t.mutation(internal.machine.rest.createIssue, {
        callerId: f.agent.id,
        keyName: KEY,
        body: JSON.stringify({
          project: 'FW',
          title: 'Unknown source reporter',
          reporter_id: null,
        }),
      }),
      'bad_request',
      'reporter_id must be a profile uuid',
    )
    expect(await t.query(internal.machine.rest.listIssues, { callerId: f.agent.id })).toEqual([])
    expect(await activityFor(t, f.org.id)).toEqual([])
  })

  it('title and body-shape sentences, verbatim', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const post = (body: unknown) =>
      t.mutation(internal.machine.rest.createIssue, {
        callerId: f.agent.id,
        keyName: KEY,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
    await refused(post('not json at all'), 'bad_request', 'request body must be JSON')
    await refused(post({ project: 'FW' }), 'bad_request', 'title is required')
    await refused(
      post({ project: 'FW', title: 5 }),
      'bad_request',
      'title must be a non-empty string',
    )
    await refused(post({ project: 'FW', title: '   ' }), 'bad_request', 'title must not be blank')
    await refused(
      post({ project: 'FW', title: 'x'.repeat(81) }),
      'bad_request',
      'title must be at most 80 characters',
    )
    await refused(
      post({ project: 'FW', title: 'ok', description: 7 }),
      'bad_request',
      'description must be a string',
    )
    await refused(
      post({ project: 'FW', title: 'ok', status: 'closed' }),
      'bad_request',
      'status must be one of backlog, todo, progress, review, done',
    )
    await refused(
      post({ project: 'FW', title: 'ok', priority: 'top' }),
      'bad_request',
      'priority must be one of urgent, high, medium, low',
    )
    await refused(
      post({ project: 'FW', title: 'ok', start_week: 'Jan 5' }),
      'bad_request',
      'start_week must be YYYY-MM-DD or null',
    )
    await refused(
      post({ project: 'FW', title: 'ok', due_date: '2026/01/05' }),
      'bad_request',
      'due_date must be YYYY-MM-DD or null',
    )
    await refused(
      post({ project: 'FW', title: 'ok', remaining_hours: -1 }),
      'bad_request',
      'remaining_hours must be a non-negative number or null',
    )
    await refused(
      post({ project: 'FW', title: 'ok', paused: 'yes' }),
      'bad_request',
      'paused must be a boolean',
    )
    await refused(
      post({ project: 'FW', title: 'ok', start_week: '2026-01-05' }),
      'bad_request',
      'start_week and end_week must be set (or cleared) together',
    )
    await refused(
      post({ project: 'FW', title: 'ok', start_week: '2026-01-12', end_week: '2026-01-05' }),
      'bad_request',
      'start_week must not be after end_week',
    )
  })

  it('THE oracle: a named-but-unreachable top-level project answers 403 and admits it exists', async () => {
    const t = newT()
    const f = await machineOrg(t)
    await refused(
      t.mutation(internal.machine.rest.createIssue, {
        callerId: f.agent.id,
        keyName: KEY,
        body: JSON.stringify({ project: 'SKNK', title: 'probe' }),
      }),
      'forbidden',
      NO_WRITE,
    )
    // …but an unknown ref stays a 400
    await refused(
      t.mutation(internal.machine.rest.createIssue, {
        callerId: f.agent.id,
        keyName: KEY,
        body: JSON.stringify({ project: 'NOPE', title: 'probe' }),
      }),
      'bad_request',
      'project must name a project by uuid, number or key',
    )
  })

  it('sub_project refs are NEVER an oracle: unknown and unreachable read identically', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const sentence = 'sub_project must name a sub-project by key, number or uuid'
    for (const sub of ['NOPE', 'SKNK']) {
      await refused(
        t.mutation(internal.machine.rest.createIssue, {
          callerId: f.agent.id,
          keyName: KEY,
          body: JSON.stringify({ project: 'TBED', sub_project: sub, title: 'probe' }),
        }),
        'bad_request',
        sentence,
      )
    }
  })

  it('archived rules: archived-on-create refused; archived project and archived sub refuse by name', async () => {
    const t = newT()
    const f = await machineOrg(t)
    await refused(
      t.mutation(internal.machine.rest.createIssue, {
        callerId: f.agent.id,
        keyName: KEY,
        body: JSON.stringify({ project: 'FW', title: 'x', archived: false }),
      }),
      'bad_request',
      'tasks are created active — archive with PATCH after creating',
    )
    await archiveProject(t, f.sub2)
    await refused(
      t.mutation(internal.machine.rest.createIssue, {
        callerId: f.agent.id,
        keyName: KEY,
        body: JSON.stringify({ project: 'PCB', title: 'x' }),
      }),
      'bad_request',
      'PCB is archived — restore it in the app before adding tasks to it',
    )
    // a sub archived alone, named via its live meta
    await refused(
      t.mutation(internal.machine.rest.createIssue, {
        callerId: f.agent.id,
        keyName: KEY,
        body: JSON.stringify({ project: 'TBED', sub_project: 'PCB', title: 'x' }),
      }),
      'bad_request',
      'PCB is archived — restore it in the app before adding tasks to it',
    )
  })

  it('the meta sentences: pass sub_project / no write access / no sub-projects yet; null = not provided', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const bare =
      'TBED is a project — tasks live in its sub-projects; pass sub_project (one of: FW, PCB)'
    await refused(
      t.mutation(internal.machine.rest.createIssue, {
        callerId: f.agent.id,
        keyName: KEY,
        body: JSON.stringify({ project: 'TBED', title: 'x' }),
      }),
      'bad_request',
      bare,
    )
    await refused(
      t.mutation(internal.machine.rest.createIssue, {
        callerId: f.agent.id,
        keyName: KEY,
        body: JSON.stringify({ project: 'TBED', sub_project: null, title: 'x' }),
      }),
      'bad_request',
      bare,
    )
    const grantViewer = await plantAgent(t, f.org.id, 'Grant viewer bot', 'user')
    await grant(t, f.meta.id, grantViewer.id, 'viewer')
    await refused(
      t.mutation(internal.machine.rest.createIssue, {
        callerId: grantViewer.id,
        keyName: KEY,
        body: JSON.stringify({ project: 'TBED', title: 'x' }),
      }),
      'bad_request',
      'TBED is a project — tasks live in its sub-projects; you have no write access to any of them',
    )
    const empty = await plantProject(t, { org_id: f.org.id })
    await grant(t, empty.id, f.agent.id, 'user')
    await refused(
      t.mutation(internal.machine.rest.createIssue, {
        callerId: f.agent.id,
        keyName: KEY,
        body: JSON.stringify({ project: empty.key, title: 'x' }),
      }),
      'bad_request',
      `${empty.key} is a project — tasks live in its sub-projects; it has no sub-projects yet — create one in the app first`,
    )
  })

  it("the pair rule: another project's sub-project is refused by name", async () => {
    const t = newT()
    const f = await machineOrg(t)
    const meta2 = await plantProject(t, { org_id: f.org.id })
    const sub3 = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: meta2.id })
    await grant(t, meta2.id, f.agent.id, 'user')
    await refused(
      t.mutation(internal.machine.rest.createIssue, {
        callerId: f.agent.id,
        keyName: KEY,
        body: JSON.stringify({ project: 'TBED', sub_project: sub3.key, title: 'x' }),
      }),
      'bad_request',
      `sub-project ${sub3.key} does not belong to project TBED — tasks are never created under another project's sub-project`,
    )
  })

  it('viewer agents write nothing (0102): read-only standing on a valid pair answers 403', async () => {
    const t = newT()
    const f = await withOrg(t)
    const roleViewer = await plantAgent(t, f.org.id, 'Role viewer bot', 'viewer')
    await grant(t, f.meta.id, roleViewer.id, 'user')
    const grantViewer = await plantAgent(t, f.org.id, 'Grant viewer bot', 'user')
    await grant(t, f.meta.id, grantViewer.id, 'viewer')
    for (const bot of [roleViewer, grantViewer]) {
      await refused(
        t.mutation(internal.machine.rest.createIssue, {
          callerId: bot.id,
          keyName: KEY,
          body: JSON.stringify({ project: 'TBED', sub_project: 'FW', title: 'denied' }),
        }),
        'forbidden',
        NO_WRITE,
      )
    }
  })

  it('assignee rules include project visibility as well as the existing eligibility checks', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const off = await plantSeat(t, { org_id: f.org.id, name: 'Off duty' })
    const inaccessible = await plantSeat(t, { org_id: f.org.id, name: 'No project access' })
    await t.run(async (ctx) => {
      await ctx.db.patch(off._id, { active: false })
    })
    const post = (assignee_id: unknown) =>
      t.mutation(internal.machine.rest.createIssue, {
        callerId: f.agent.id,
        keyName: KEY,
        body: JSON.stringify({ project: 'FW', title: 'x', assignee_id }),
      })
    await refused(post('nope'), 'bad_request', 'assignee_id must be a profile uuid or null')
    await refused(
      post(f.otherAdmin.id),
      'bad_request',
      `user "${f.otherAdmin.id}" not found in your organization`,
    )
    await refused(
      post(off.id),
      'bad_request',
      `user "${off.id}" is switched off and can hold no new work`,
    )
    await refused(
      post(f.viewer.id),
      'bad_request',
      `user "${f.viewer.id}" is a viewer — a viewer reads the projects they are added to and is never assigned work`,
    )
    await refused(
      post(inaccessible.id),
      'bad_request',
      `user "${inaccessible.id}" has no access to this project`,
    )
  })

  it('reporter rules: malformed, unknown, foreign and project-inaccessible users are refused', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const inaccessible = await plantSeat(t, { org_id: f.org.id, name: 'No project access' })
    const post = (reporter_id: unknown) =>
      t.mutation(internal.machine.rest.createIssue, {
        callerId: f.agent.id,
        keyName: KEY,
        body: JSON.stringify({ project: 'FW', title: 'x', reporter_id }),
      })
    await refused(post('nope'), 'bad_request', 'reporter_id must be a profile uuid')
    const missing = uuid()
    await refused(post(missing), 'bad_request', `user "${missing}" not found in your organization`)
    await refused(
      post(f.otherAdmin.id),
      'bad_request',
      `user "${f.otherAdmin.id}" not found in your organization`,
    )
    await refused(
      post(inaccessible.id),
      'bad_request',
      `user "${inaccessible.id}" has no access to this project`,
    )
  })

  it('reviewer_id is stored lowercase and named; malformed, viewer and View-only reviewers are refused', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const viewOnly = await plantSeat(t, { org_id: f.org.id, name: 'View only' })
    await grant(t, f.meta.id, viewOnly.id, 'viewer')
    const post = (reviewer_id: unknown) =>
      t.mutation(internal.machine.rest.createIssue, {
        callerId: f.agent.id,
        keyName: KEY,
        body: JSON.stringify({ project: 'FW', title: 'Reviewed', reviewer_id }),
      })
    const out = await post(f.guest.id.toUpperCase())
    expect(out.reviewer_id).toBe(f.guest.id)
    expect(out.reviewer_name).toBe('guest')
    expect(out.assignee_id).toBeNull()
    for (const malformed of ['nope', 42]) {
      await refused(post(malformed), 'bad_request', 'reviewer_id must be a profile uuid or null')
    }
    await expectRefusal(post(f.viewer.id), 'bad_request', /is a viewer/)
    await expectRefusal(
      post(viewOnly.id),
      'bad_request',
      /needs Edit permission or higher on this project to review work$/,
    )
    expect(await t.query(internal.machine.rest.listIssues, { callerId: f.agent.id })).toHaveLength(
      1,
    )
  })

  it('unknown fields are ignored; remaining_hours rounds to one decimal and stamps', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const out = await t.mutation(internal.machine.rest.createIssue, {
      callerId: f.agent.id,
      keyName: KEY,
      body: JSON.stringify({
        project: 'FW',
        title: 'ok',
        estimate_hours: 5,
        whatever: true,
        remaining_hours: 2.34,
      }),
    })
    expect(out.remaining_hours).toBe(2.3)
    expect(typeof out.remaining_set_at).toBe('string')
  })

  it('paused sticks on create (the deployed edge once dropped the old blocked flag)', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const out = await t.mutation(internal.machine.rest.createIssue, {
      callerId: f.agent.id,
      keyName: KEY,
      body: JSON.stringify({ project: 'FW', title: 'stuck', status: 'todo', paused: true }),
    })
    expect(out.paused).toBe(true)
  })
})

/* ----------------------------------------------------------- update issue */

describe('PATCH /v1/tasks/{ref}', () => {
  it('refuses every reporter PATCH atomically, including setting the same user and clearing', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const row = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Imported attribution',
      reporter_id: f.agent.id,
      created_by: f.agent.id,
    })
    await plantSubscription(t, { issue_id: row.id, profile_id: f.user.id })
    const before = await issueRow(t, row.id)
    for (const reporter_id of [f.user.id, f.agent.id, null, 'nope']) {
      await refused(
        t.mutation(internal.machine.rest.updateIssue, {
          callerId: f.agent.id,
          keyName: KEY,
          ref: row.id,
          body: JSON.stringify({ reporter_id, title: 'Must not change', archived: true }),
        }),
        'bad_request',
        'reporter_id is set when a task is created and cannot be changed',
      )
      expect(await issueRow(t, row.id)).toEqual(before)
    }
    expect(await activityFor(t, f.org.id)).toEqual([])
    expect(await messagesFor(t, f.user.id, row.id)).toEqual([])
  })

  it("a field patch narrates 'changed' with the multi-field diff and the provenance suffix", async () => {
    const t = newT()
    const f = await machineOrg(t)
    const row = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Narrated' })
    await plantSubscription(t, { issue_id: row.id, profile_id: f.user.id })
    const out = await t.mutation(internal.machine.rest.updateIssue, {
      callerId: f.agent.id,
      keyName: KEY,
      ref: `QN-${row.num}`,
      body: JSON.stringify({ status: 'review', remaining_hours: 3 }),
    })
    expect(out.status).toBe('review')
    expect(out.remaining_hours).toBe(3)
    const acts = await activityFor(t, f.org.id)
    expect(acts).toHaveLength(1)
    expect(acts[0].verb).toBe('changed')
    expect(acts[0].detail).toBe(
      '(status To Do → In Review, remaining unset → 3 h) — via the REST API (drive)',
    )
    const msgs = await messagesFor(t, f.user.id, row.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].detail).toBe('Status: To Do → In Review. Remaining set to 3 h')
    expect(msgs[0].actor_id).toBe(f.agent.id)
  })

  it('moving into review sets the project review time with a fresh stamp and narrates it', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const row = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Ready for eyes',
      status: 'progress',
      remaining_hours: 6,
      remaining_set_at: NOW,
    })
    const out = await t.mutation(internal.machine.rest.updateIssue, {
      callerId: f.agent.id,
      keyName: KEY,
      ref: row.id,
      body: JSON.stringify({ status: 'review' }),
    })
    expect(out.remaining_hours).toBe(2)
    expect(typeof out.remaining_set_at).toBe('string')
    expect(out.remaining_set_at).not.toBe(NOW)
    const acts = await activityFor(t, f.org.id)
    expect(acts).toHaveLength(1)
    expect(acts[0].detail).toBe(
      '(status In Progress → In Review, remaining 6 h → 2 h) — via the REST API (drive)',
    )
  })

  it('a reviewer-only PATCH lands, null clears the column, and a task with subtasks refuses a reviewer', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const patch = (ref: string, body: unknown) =>
      t.mutation(internal.machine.rest.updateIssue, {
        callerId: f.agent.id,
        keyName: KEY,
        ref,
        body: JSON.stringify(body),
      })
    const row = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Reviewed' })
    const set = await patch(row.id, { reviewer_id: f.guest.id })
    expect(set.reviewer_id).toBe(f.guest.id)
    expect(set.reviewer_name).toBe('guest')
    const cleared = await patch(row.id, { reviewer_id: null })
    expect(cleared.reviewer_id).toBeNull()
    expect(cleared.reviewer_name).toBeNull()
    expect(await issueRow(t, row.id)).not.toHaveProperty('reviewer_id')
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Group' })
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Kid',
      parent_id: parent.id,
    })
    await expectRefusal(
      patch(parent.id, { reviewer_id: f.guest.id }),
      'rule',
      /no reviewer of its own/,
    )
    expect(await issueRow(t, parent.id)).toEqual(parent)
  })

  it('FOLDED fields+archived PATCH: one row write, one fan-out, one activity row, cascade unnotified', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Parent' })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Child',
      parent_id: parent.id,
    })
    await plantSubscription(t, { issue_id: parent.id, profile_id: f.user.id })
    await plantSubscription(t, { issue_id: child.id, profile_id: f.user.id })
    const out = await t.mutation(internal.machine.rest.updateIssue, {
      callerId: f.agent.id,
      keyName: KEY,
      ref: `QN-${parent.num}`,
      body: JSON.stringify({ priority: 'high', archived: true }),
    })
    expect(out.priority).toBe('high')
    expect(out.archived).toBe(true)
    expect(typeof out.archived_at).toBe('string')
    // ONE activity row — the toggle verb wins, the field diff rides the detail
    const acts = await activityFor(t, f.org.id)
    expect(acts).toHaveLength(1)
    expect(acts[0].verb).toBe('archived')
    expect(acts[0].detail).toBe('(priority Medium → High) — via the REST API (drive)')
    // ONE message — the Archived line rides with the field lines
    const parentMsgs = await messagesFor(t, f.user.id, parent.id)
    expect(parentMsgs).toHaveLength(1)
    expect(parentMsgs[0].detail).toBe('Priority: Medium → High. Archived')
    // the descendant is stamped with the same instant, but never notified
    const childRow = await issueRow(t, child.id)
    expect(childRow?.archived_at).toBe(out.archived_at)
    expect(await messagesFor(t, f.user.id, child.id)).toHaveLength(0)
  })

  it('restore via archived:false surfaces the ancestor chain; a pure toggle narrates provenance alone', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const parent = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Parent',
      archived_at: NOW,
    })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Child',
      parent_id: parent.id,
      archived_at: NOW,
    })
    await plantSubscription(t, { issue_id: parent.id, profile_id: f.user.id })
    await plantSubscription(t, { issue_id: child.id, profile_id: f.user.id })
    const out = await t.mutation(internal.machine.rest.updateIssue, {
      callerId: f.agent.id,
      keyName: KEY,
      ref: child.id,
      body: JSON.stringify({ archived: false }),
    })
    expect(out.archived).toBe(false)
    expect(out.archived_at).toBeNull()
    const parentRow = await t.run(
      async (ctx) =>
        await ctx.db
          .query('issues')
          .withIndex('by_uuid', (q) => q.eq('id', parent.id))
          .unique(),
    )
    expect(parentRow?.archived_at).toBeUndefined() // the chain surfaced
    const acts = await activityFor(t, f.org.id)
    expect(acts).toHaveLength(1)
    expect(acts[0].verb).toBe('restored')
    expect(acts[0].detail).toBe(VIA) // pure toggle — no diff clause
    // the row's own subscribers hear Restored; the ancestor echo is suppressed
    const childMsgs = await messagesFor(t, f.user.id, child.id)
    expect(childMsgs).toHaveLength(1)
    expect(childMsgs[0].detail).toBe('Restored')
    expect(await messagesFor(t, f.user.id, parent.id)).toHaveLength(0)
  })

  it('archived matching the current state is a clean no-op 200 — no write, no narration', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const row = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Steady' })
    await plantSubscription(t, { issue_id: row.id, profile_id: f.user.id })
    const out = await t.mutation(internal.machine.rest.updateIssue, {
      callerId: f.agent.id,
      keyName: KEY,
      ref: row.id,
      body: JSON.stringify({ archived: false }),
    })
    expect(out.id).toBe(row.id)
    expect(out.archived).toBe(false)
    expect(out.title).toBe('Steady')
    expect(await activityFor(t, f.org.id)).toHaveLength(0)
    expect(await messagesFor(t, f.user.id, row.id)).toHaveLength(0)
  })

  it('the PATCH refusal sentences, verbatim', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const row = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Guarded' })
    const patch = (body: unknown, ref = row.id) =>
      t.mutation(internal.machine.rest.updateIssue, {
        callerId: f.agent.id,
        keyName: KEY,
        ref,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
    await refused(patch({}, 'QN-999999'), 'not_found', 'task not found')
    await refused(patch('broken'), 'bad_request', 'request body must be JSON')
    await refused(patch({}), 'bad_request', 'no recognized fields to update')
    await refused(patch({ estimate_hours: 5 }), 'bad_request', 'no recognized fields to update')
    await refused(patch({ archived: 'yes' }), 'bad_request', 'archived must be a boolean')
    for (const move of [
      { project: 'FW' },
      { project_id: f.sub.id },
      { sub_project: 'FW', title: 'x' },
    ]) {
      await refused(
        patch(move),
        'bad_request',
        'moving a task between projects is not supported over the API',
      )
    }
    await refused(
      patch({ start_week: '2026-01-05' }),
      'bad_request',
      'start_week and end_week must be set (or cleared) together',
    )
  })

  it('the effective week pair: a lone half over a scheduled row passes', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const row = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Scheduled',
      start_week: '2026-01-05',
      end_week: '2026-01-12',
    })
    const out = await t.mutation(internal.machine.rest.updateIssue, {
      callerId: f.agent.id,
      keyName: KEY,
      ref: row.id,
      body: JSON.stringify({ end_week: '2026-01-19' }),
    })
    expect(out.start_week).toBe('2026-01-05')
    expect(out.end_week).toBe('2026-01-19')
  })

  it('remaining_hours on a task with subtasks answers the machine sentence; null clears through', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const parent = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Has kids',
    })
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Kid',
      parent_id: parent.id,
    })
    await refused(
      t.mutation(internal.machine.rest.updateIssue, {
        callerId: f.agent.id,
        keyName: KEY,
        ref: parent.id,
        body: JSON.stringify({ remaining_hours: 3 }),
      }),
      'bad_request',
      'remaining_hours cannot be set on a task with subtasks — it is the sum of their remaining time',
    )
    const cleared = await t.mutation(internal.machine.rest.updateIssue, {
      callerId: f.agent.id,
      keyName: KEY,
      ref: parent.id,
      body: JSON.stringify({ remaining_hours: null }),
    })
    expect(cleared.remaining_hours).toBeNull()
  })

  it('invisible issues 404 before the write gate; viewer agents 403 on a visible one', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const hiddenIssue = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.hidden.id,
      title: 'No see',
    })
    await refused(
      t.mutation(internal.machine.rest.updateIssue, {
        callerId: f.agent.id,
        keyName: KEY,
        ref: hiddenIssue.id,
        body: JSON.stringify({ title: 'poke' }),
      }),
      'not_found',
      'task not found',
    )
    const row = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Visible' })
    const grantViewer = await plantAgent(t, f.org.id, 'Grant viewer bot', 'user')
    await grant(t, f.meta.id, grantViewer.id, 'viewer')
    await refused(
      t.mutation(internal.machine.rest.updateIssue, {
        callerId: grantViewer.id,
        keyName: KEY,
        ref: row.id,
        body: JSON.stringify({ title: 'poke' }),
      }),
      'forbidden',
      NO_WRITE,
    )
  })
})

/* ----------------------------------------------------------- delete issue */

describe('DELETE /v1/tasks/{ref}', () => {
  it('deletes deep, detaches children with notify, narrates deleted with provenance', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Doomed' })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Orphan to be',
      parent_id: parent.id,
    })
    await plantSubscription(t, { issue_id: child.id, profile_id: f.user.id })
    await t.run(async (ctx) => {
      await ctx.db.insert('comments', {
        id: uuid(),
        issue_id: parent.id,
        author: f.user.id,
        body: 'so long',
        created_at: NOW,
      })
    })
    const out = await t.mutation(internal.machine.rest.deleteIssue, {
      callerId: f.agent.id,
      keyName: KEY,
      ref: `QN-${parent.num}`,
    })
    expect(out).toEqual({ deleted: true, id: parent.id, key: `QN-${parent.num}` })
    expect(await issueRow(t, parent.id)).toBeNull()
    const comments = await t.run(
      async (ctx) =>
        await ctx.db
          .query('comments')
          .withIndex('by_issue', (q) => q.eq('issue_id', parent.id))
          .collect(),
    )
    expect(comments).toEqual([])
    const childRow = await issueRow(t, child.id)
    expect(childRow?.parent_id).toBeUndefined()
    const childMsgs = await messagesFor(t, f.user.id, child.id)
    expect(childMsgs.map((m) => m.detail)).toEqual(['Detached from its parent'])
    const acts = await activityFor(t, f.org.id)
    expect(acts).toHaveLength(1)
    expect(acts[0].verb).toBe('deleted')
    expect(acts[0].label).toBe('Doomed')
    expect(acts[0].detail).toBe(VIA)
  })

  it('404 for unknown/invisible refs, 403 for read-only standing', async () => {
    const t = newT()
    const f = await machineOrg(t)
    await refused(
      t.mutation(internal.machine.rest.deleteIssue, {
        callerId: f.agent.id,
        keyName: KEY,
        ref: 'QN-424242',
      }),
      'not_found',
      'task not found',
    )
    const hiddenIssue = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.hidden.id,
      title: 'No see',
    })
    await refused(
      t.mutation(internal.machine.rest.deleteIssue, {
        callerId: f.agent.id,
        keyName: KEY,
        ref: hiddenIssue.id,
      }),
      'not_found',
      'task not found',
    )
    const row = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Kept' })
    const grantViewer = await plantAgent(t, f.org.id, 'Grant viewer bot', 'user')
    await grant(t, f.meta.id, grantViewer.id, 'viewer')
    await refused(
      t.mutation(internal.machine.rest.deleteIssue, {
        callerId: grantViewer.id,
        keyName: KEY,
        ref: row.id,
      }),
      'forbidden',
      NO_WRITE,
    )
  })
})

/* --------------------------------------------------------------- comments */

describe('/v1/tasks/{ref}/comments', () => {
  it('POST authors as the agent with a server-generated id, subscribes it, fans out — and writes NO activity', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const row = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Discussed' })
    await plantSubscription(t, { issue_id: row.id, profile_id: f.user.id })
    const out = await t.mutation(internal.machine.rest.addComment, {
      callerId: f.agent.id,
      ref: `QN-${row.num}`,
      body: JSON.stringify({ body: '  Hello from the drive  ' }),
    })
    expect(out).toEqual({
      id: out.id,
      task_id: row.id,
      author_id: f.agent.id,
      author_name: 'Relay',
      body: 'Hello from the drive',
      created_at: out.created_at,
      edited_at: null,
      edited_by_id: null,
      edited_by_name: null,
    })
    expect(out.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const subs = await t.run(
      async (ctx) =>
        await ctx.db
          .query('issue_subscriptions')
          .withIndex('by_issue', (q) => q.eq('issue_id', row.id))
          .collect(),
    )
    expect(subs.some((s) => s.profile_id === f.agent.id)).toBe(true) // saying something subscribes you
    const msgs = await messagesFor(t, f.user.id, row.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].kind).toBe('comment')
    expect(msgs[0].detail).toBe('New comment')
    expect(msgs[0].actor_id).toBe(f.agent.id)
    expect(await activityFor(t, f.org.id)).toHaveLength(0) // the comment IS its own feed entry
  })

  it('GET lists oldest first in the REST shape', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const row = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Thread' })
    await t.mutation(internal.machine.rest.addComment, {
      callerId: f.agent.id,
      ref: row.id,
      body: JSON.stringify({ body: 'first' }),
    })
    await tick()
    await t.mutation(internal.machine.rest.addComment, {
      callerId: f.agent.id,
      ref: row.id,
      body: JSON.stringify({ body: 'second' }),
    })
    const rows = await t.query(internal.machine.rest.listComments, {
      callerId: f.agent.id,
      ref: row.id,
    })
    expect(rows.map((c) => c.body)).toEqual(['first', 'second'])
    expect(rows[0].task_id).toBe(row.id)
    expect(rows[0].author_name).toBe('Relay')
  })

  it('the comment refusal sentences: not-found BEFORE the write gate, attribution, shape, blank', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const row = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Fenced' })
    const hiddenIssue = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.hidden.id,
      title: 'No see',
    })
    const post = (body: unknown, ref = row.id, callerId = f.agent.id) =>
      t.mutation(internal.machine.rest.addComment, {
        callerId,
        ref,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
    // an invisible issue is not found before the write gate is consulted —
    // never a 403 that would confirm it exists
    await refused(post({ body: 'hi' }, hiddenIssue.id), 'not_found', 'task not found')
    await refused(post({ body: 'hi' }, 'QN-999999'), 'not_found', 'task not found')
    const attribution =
      'comments cannot be attributed over the API — a comment is always authored by the agent posting it'
    await refused(post({ body: 'hi', author: 'someone' }), 'bad_request', attribution)
    await refused(post({ body: 'hi', author_id: f.user.id }), 'bad_request', attribution)
    await refused(post({ body: 7 }), 'bad_request', 'body must be a non-empty string')
    await refused(post({}), 'bad_request', 'body must be a non-empty string')
    await refused(post({ body: '   ' }), 'bad_request', 'comment body must not be blank')
    await refused(post('nonsense'), 'bad_request', 'request body must be JSON')
    // read standing is not write standing
    const grantViewer = await plantAgent(t, f.org.id, 'Grant viewer bot', 'user')
    await grant(t, f.meta.id, grantViewer.id, 'viewer')
    await refused(post({ body: 'hi' }, row.id, grantViewer.id), 'forbidden', NO_WRITE)
    const listed = await t.query(internal.machine.rest.listComments, {
      callerId: grantViewer.id,
      ref: row.id,
    })
    expect(listed).toEqual([]) // …but reading the thread is fine
  })
})
