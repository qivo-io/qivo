/* The organization REST API with personal access tokens (`qvt_`), driven over
 * HTTP through the real route.
 *
 *   1. Every route with a person's write token, a read-only token and a
 *      Viewer person's token, beside a Standard user agent and a Viewer
 *      agent whose sentences stay the pinned agent bytes. A route without a
 *      request here fails the coverage check.
 *   2. The person 401 sentences, and the auth-to-dispatch race answered in
 *      the caller's own words.
 *   3. Person provenance (`via the REST API`, no token name), comment
 *      authorship, project access flags that follow the credential, and the
 *      per-request stamp.
 *   4. PATCH /v1/users/{id}, the plannable hours rule shared with the app and
 *      MCP's update_user. */
/// <reference types="vite/client" />

import { describe, expect, it, vi } from 'vitest'
import type { Doc } from '../_generated/dataModel'
import { sha256hex } from '../machine/auth'
import { ROUTES } from '../machine/rest'
import {
  activityFor,
  NOW,
  newT,
  plantIssue,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string }
type Res = { status: number; body: Record<string, unknown> }

/* edge-runtime provides Blob; convex/tsconfig's ESNext-only lib does not
 * declare it. */
declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}

/* An attachment read mints a download link, which needs the file token
 * secret (lib/fileTokens.ts reads it lazily). */
const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } }
g.process ??= { env: {} }
g.process.env.BETTER_AUTH_SECRET ??= 'test-files-secret'

async function call(
  t: T,
  secret: string | null,
  method: string,
  path: string,
  body?: unknown,
  header: 'Authorization' | 'X-Api-Key' = 'Authorization',
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (secret !== null) {
    headers[header] = header === 'Authorization' ? `Bearer ${secret}` : secret
  }
  const res = await (
    t as unknown as {
      fetch(path: string, init?: FetchInit): Promise<{ status: number; text(): Promise<string> }>
    }
  ).fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> }
}

const secret = (prefix: string) => `${prefix}${uuid().replace(/-/g, '')}${'0'.repeat(16)}`

async function plantToken(
  t: T,
  profile: Doc<'profiles'>,
  row: { access?: 'read' | 'write'; expires_at?: string; revoked_at?: string } = {},
): Promise<string> {
  const token = secret('qvt_')
  const token_hash = await sha256hex(token)
  await t.run((ctx) =>
    ctx.db.insert('mcp_tokens', {
      id: uuid(),
      profile_id: profile.id,
      name: `${profile.name} token`,
      token_prefix: token.slice(0, 11),
      token_hash,
      created_at: NOW,
      ...row,
    }),
  )
  return token
}

async function plantKey(t: T, agent: Doc<'profiles'>): Promise<string> {
  const key = secret('qva_')
  const key_hash = await sha256hex(key)
  await t.run(async (ctx) => {
    await ctx.db.insert('agent_keys', {
      id: uuid(),
      profile_id: agent.id,
      name: 'CI key',
      key_prefix: key.slice(0, 11),
      key_hash,
      created_at: NOW,
    })
  })
  return key
}

/* withOrg plus one credential of every shape. Both agents hold User on the
 * meta, so only the Viewer's role keeps it from writing; the Viewer person
 * holds User on the meta too (withOrg), capped to reading by their role. */
async function fixture() {
  const t = newT()
  const f = await withOrg(t)
  const viewerAgent = await plantSeat(t, {
    org_id: f.org.id,
    name: 'Ledger',
    org_role: 'viewer',
    kind: 'agent',
    plannable_hours: undefined,
  })
  for (const agent of [f.agent, viewerAgent]) {
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: agent.id,
        level: 'user',
      }),
    )
  }
  // a task every link request points at, and a label to edit
  const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
  const label = uuid()
  await t.run((ctx) =>
    ctx.db.insert('labels', {
      id: label,
      org_id: f.org.id,
      name: 'Edited',
      name_lower: 'edited',
      color: '#000000',
      created_at: NOW,
    }),
  )
  // comments by someone else on that task: one to edit, and one for each
  // credential's delete request
  const comment = async () => {
    const id = uuid()
    await t.run((ctx) =>
      ctx.db.insert('comments', {
        id,
        issue_id: other.id,
        author: f.user.id,
        body: 'Written by someone else',
        created_at: NOW,
      }),
    )
    return id
  }
  const editable = await comment()
  const deletable: string[] = []
  for (let n = 0; n < 5; n++) deletable.push(await comment())
  return {
    t,
    f,
    viewerAgent,
    other: `QN-${other.num}`,
    editable,
    deletable,
    label,
    writer: await plantToken(t, f.admin, { access: 'write' }),
    reader: await plantToken(t, f.admin, { access: 'read' }),
    viewer: await plantToken(t, f.viewer, { access: 'write' }),
    agentKey: await plantKey(t, f.agent),
    viewerKey: await plantKey(t, viewerAgent),
  }
}

const READS_ONLY = 'this credential can only read'
const VIEWER_AGENT_READS_ONLY = 'this agent is a Viewer and can only read'
const PERSON_NO_WRITE = 'your account has no write access to that project'
const RIGHTS =
  "only an organization admin or a leader of one of this person's teams can set their plannable hours"
const LABEL_ADMINS = 'only organization admins can rename, recolor or delete labels'

/* ------------------------------------------------------- 1. every route */

type Fx = Awaited<ReturnType<typeof fixture>>

/* A fresh milestone on the fixture's top-level project, so each credential
 * edits or deletes one that exists. */
const plantMilestone = (fx: Fx): Promise<string> =>
  fx.t.run(async (ctx) => {
    const id = uuid()
    await ctx.db.insert('milestones', {
      id,
      project_id: fx.f.meta.id,
      name: 'Gate',
      week: '2026-03-02',
      created_at: NOW,
    })
    return id
  })

/* A stored file of `bytes` bytes, as an upload to Convex storage leaves it. */
const storeFile = (t: T, bytes: number) =>
  t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(bytes)]) as never))

/* One concrete request per route; `task` is a fresh task in FW, by key and
 * as its row, and `as` is the profile the credential acts as. A request may
 * plant what its route needs first. */
const REQUESTS: Record<
  string,
  (
    fx: Fx,
    task: string,
    row: Doc<'issues'>,
    as: Doc<'profiles'>,
  ) => { path: string; body?: unknown } | Promise<{ path: string; body?: unknown }>
> = {
  'GET me': () => ({ path: '/v1/me' }),
  'GET projects': () => ({ path: '/v1/projects' }),
  'GET projects/:ref': () => ({ path: '/v1/projects/FW' }),
  'GET projects/:ref/users': () => ({ path: '/v1/projects/FW/users' }),
  'GET users': () => ({ path: '/v1/users' }),
  'GET users/:ref': (fx) => ({ path: `/v1/users/${fx.f.user.id}` }),
  'PATCH users/:ref': (fx) => ({
    path: `/v1/users/${fx.f.user.id}`,
    body: { plannable_hours: 30 },
  }),
  'GET tasks': () => ({ path: '/v1/tasks' }),
  'POST tasks': () => ({ path: '/v1/tasks', body: { project: 'FW', title: 'Token write' } }),
  'GET tasks/:ref': (_, task) => ({ path: `/v1/tasks/${task}` }),
  'PATCH tasks/:ref': (_, task) => ({ path: `/v1/tasks/${task}`, body: { title: 'Renamed' } }),
  'DELETE tasks/:ref': (_, task) => ({ path: `/v1/tasks/${task}` }),
  'GET tasks/:ref/comments': (_, task) => ({ path: `/v1/tasks/${task}/comments` }),
  'POST tasks/:ref/comments': (_, task) => ({
    path: `/v1/tasks/${task}/comments`,
    body: { body: 'From a token' },
  }),
  'POST tasks/:ref/links': (fx, task) => ({
    path: `/v1/tasks/${task}/links`,
    body: { task: fx.other, kind: 'relates' },
  }),
  'DELETE tasks/:ref/links/:kind/:other': (fx, task) => ({
    path: `/v1/tasks/${task}/links/relates/${fx.other}`,
  }),
  'GET labels': () => ({ path: '/v1/labels' }),
  'POST labels': () => ({
    path: '/v1/labels',
    body: { name: `Token ${uuid().slice(0, 8)}`, color: '#123456' },
  }),
  'PATCH labels/:ref': (fx) => ({ path: `/v1/labels/${fx.label}`, body: { color: '#654321' } }),
  'GET tasks/:ref/attachments': (_, task) => ({ path: `/v1/tasks/${task}/attachments` }),
  'POST tasks/:ref/attachments': (_, task) => ({
    path: `/v1/tasks/${task}/attachments`,
    body: { name: 'notes.txt', content_type: 'text/plain', size: 5 },
  }),
  'POST tasks/:ref/attachments/:ticket': async (fx, task, row, as) => {
    const ticket = uuid()
    await fx.t.run((ctx) =>
      ctx.db.insert('attachment_uploads', {
        id: ticket,
        org_id: row.org_id,
        profile_id: as.id,
        issue_id: row.id,
        name: 'notes.txt',
        size_bytes: 5,
        expires_at: Date.now() + 60_000,
      }),
    )
    // stored after the ticket, as the upload to its URL would be
    const storage_id = await storeFile(fx.t, 5)
    return { path: `/v1/tasks/${task}/attachments/${ticket}`, body: { storage_id } }
  },
  'DELETE tasks/:ref/attachments/:id': async (fx, task, row) => {
    const storage_id = await storeFile(fx.t, 5)
    const id = uuid()
    await fx.t.run((ctx) =>
      ctx.db.insert('issue_attachments', {
        id,
        org_id: row.org_id,
        issue_id: row.id,
        name: 'old.txt',
        size_bytes: 5,
        storage_id,
        inline: false,
        created_at: NOW,
      }),
    )
    return { path: `/v1/tasks/${task}/attachments/${id}` }
  },
  'GET tasks/:ref/activity': (_, task) => ({ path: `/v1/tasks/${task}/activity` }),
  'GET workload': () => ({ path: '/v1/workload' }),
  'PATCH comments/:ref': (fx) => ({
    path: `/v1/comments/${fx.editable}`,
    body: { body: `Edited ${uuid().slice(0, 8)}` },
  }),
  // each credential's request takes its own comment
  'DELETE comments/:ref': (fx) => ({ path: `/v1/comments/${fx.deletable.pop()}` }),
  'GET inbox': () => ({ path: '/v1/inbox' }),
  'POST inbox/read': (_, task) => ({ path: '/v1/inbox/read', body: { tasks: [task] } }),
  'POST inbox/unread': (_, task) => ({ path: '/v1/inbox/unread', body: { tasks: [task] } }),
  'POST inbox/remove': (_, task) => ({ path: '/v1/inbox/remove', body: { tasks: [task] } }),
  'POST inbox/snooze': (_, task) => ({
    path: '/v1/inbox/snooze',
    body: { tasks: [task], until: new Date(Date.now() + 3_600_000).toISOString() },
  }),
  'PUT tasks/:ref/following': (_, task) => ({ path: `/v1/tasks/${task}/following` }),
  'DELETE tasks/:ref/following': (_, task) => ({ path: `/v1/tasks/${task}/following` }),
  'POST projects': () => ({ path: '/v1/projects', body: { name: 'Token project' } }),
  'PATCH projects/:ref': () => ({ path: '/v1/projects/FW', body: { track_delay: true } }),
  'PUT projects/:ref/access/users/:subject': (fx) => ({
    path: `/v1/projects/FW/access/users/${fx.f.guest.id}`,
    body: { level: 'viewer' },
  }),
  'DELETE projects/:ref/access/users/:subject': (fx) => ({
    path: `/v1/projects/FW/access/users/${fx.f.guest.id}`,
  }),
  'PUT projects/:ref/access/teams/:subject': (fx) => ({
    path: `/v1/projects/FW/access/teams/${fx.f.team.id}`,
    body: { level: 'viewer' },
  }),
  'DELETE projects/:ref/access/teams/:subject': (fx) => ({
    path: `/v1/projects/FW/access/teams/${fx.f.team.id}`,
  }),
  'POST projects/:ref/milestones': () => ({
    path: '/v1/projects/FW/milestones',
    body: { name: 'Token gate', date: '2026-04-06' },
  }),
  'PATCH projects/:ref/milestones/:milestone': async (fx) => ({
    path: `/v1/projects/FW/milestones/${await plantMilestone(fx)}`,
    body: { name: 'Moved gate' },
  }),
  'DELETE projects/:ref/milestones/:milestone': async (fx) => ({
    path: `/v1/projects/FW/milestones/${await plantMilestone(fx)}`,
  }),
  'GET teams': () => ({ path: '/v1/teams' }),
  'GET teams/:ref': (fx) => ({ path: `/v1/teams/${fx.f.team.id}` }),
  'POST teams': () => ({ path: '/v1/teams', body: { name: 'Token team' } }),
  'PATCH teams/:ref': (fx) => ({ path: `/v1/teams/${fx.f.team.id}`, body: { name: 'Hardware' } }),
  'PUT teams/:ref/members/:user': (fx) => ({
    path: `/v1/teams/${fx.f.team.id}/members/${fx.f.viewer.id}`,
  }),
  'DELETE teams/:ref/members/:user': (fx) => ({
    path: `/v1/teams/${fx.f.team.id}/members/${fx.f.viewer.id}`,
  }),
}

const label = (route: { method: string; path: string }) => `${route.method} ${route.path}`

/* What a write route answers a credential. */
type Outcome = 'ok' | { status: number; error: string }

/* A Viewer person may not write any project; a Standard user agent may, but
 * neither may set someone's plannable hours or edit a label (organization
 * admins only), and a Viewer person may not add a label either. Neither
 * wrote the comment the comment routes name, nor leads its project. Both
 * manage their own inbox and follows, as a Viewer person does in the app.
 * Neither leads FW, and only a person who leads a project changes its
 * access. The agent creates a top-level project like any standard user under
 * the default setting, which a Viewer never may; a milestone needs User on
 * the top-level project, which the agent holds. Only organization admins
 * create teams, neither leads Hardware, and only a person changes its
 * members. */
const refusedWrite = (
  route: { method: string; path: string },
  kind: 'viewer' | 'agent',
): Outcome => {
  if (route.path === 'comments/:ref') {
    const verb = route.method === 'PATCH' ? 'edit' : 'delete'
    return { status: 403, error: `only the author or a project lead can ${verb} this comment` }
  }
  if (route.path.startsWith('inbox/') || route.path === 'tasks/:ref/following') return 'ok'
  if (route.path === 'users/:ref') return { status: 403, error: RIGHTS }
  if (route.path === 'labels/:ref') return { status: 403, error: LABEL_ADMINS }
  if (route.path === 'labels' && kind === 'viewer') {
    return { status: 403, error: 'no label access in this organization' }
  }
  if (route.path === 'projects' && kind === 'viewer') {
    return { status: 403, error: 'only org admins and standard users can create projects' }
  }
  if (route.path === 'projects/:ref') {
    return { status: 403, error: 'requires lead access to this project' }
  }
  if (route.path.startsWith('projects/:ref/access/')) {
    return kind === 'viewer'
      ? { status: 403, error: 'no permission to manage users on this project' }
      : { status: 403, error: 'only people can change who has access, not agents' }
  }
  if (route.path.startsWith('projects/:ref/milestones') && kind === 'viewer') {
    return { status: 403, error: 'no write access to this project' }
  }
  if (route.path === 'teams') {
    return { status: 403, error: 'only organization admins can create teams' }
  }
  if (route.path === 'teams/:ref') {
    return { status: 403, error: 'requires an organization admin or a leader of this team' }
  }
  if (route.path === 'teams/:ref/members/:user') {
    return kind === 'viewer'
      ? { status: 403, error: 'requires an organization admin or a leader of this team' }
      : { status: 403, error: 'only people can change who has access, not agents' }
  }
  return kind === 'viewer' ? { status: 403, error: PERSON_NO_WRITE } : 'ok'
}

describe('every organization route with a personal token', () => {
  it('has a request here for every route', () => {
    expect(Object.keys(REQUESTS).sort()).toEqual(ROUTES.map(label).sort())
  })

  it('reads with every token; writes follow the credential and the role', async () => {
    const fx = await fixture()
    const credentials: [
      string,
      string,
      Doc<'profiles'>,
      (route: (typeof ROUTES)[number]) => Outcome,
    ][] = [
      ['write token', fx.writer, fx.f.admin, () => 'ok'],
      ['read-only token', fx.reader, fx.f.admin, () => ({ status: 403, error: READS_ONLY })],
      ['Viewer person', fx.viewer, fx.f.viewer, (route) => refusedWrite(route, 'viewer')],
      ['Standard user agent', fx.agentKey, fx.f.agent, (route) => refusedWrite(route, 'agent')],
      [
        'Viewer agent',
        fx.viewerKey,
        fx.viewerAgent,
        () => ({ status: 403, error: VIEWER_AGENT_READS_ONLY }),
      ],
    ]
    for (const [who, credential, as, onWrite] of credentials) {
      for (const route of ROUTES) {
        const task = await plantIssue(fx.t, { org_id: fx.f.org.id, project_id: fx.f.sub.id })
        const { path, body } = await REQUESTS[label(route)](fx, `QN-${task.num}`, task, as)
        const res = await call(fx.t, credential, route.method, path, body)
        const expected: Outcome = route.access === 'read' ? 'ok' : onWrite(route)
        if (expected === 'ok') {
          expect(res.status, `${who} ${label(route)} ${JSON.stringify(res.body)}`).toBe(
            route.status,
          )
        } else {
          expect(res, `${who} ${label(route)}`).toEqual({
            status: expected.status,
            body: { error: expected.error },
          })
        }
      }
    }
  })
})

/* ------------------------------------------------------------ 2. 401s */

describe('personal token authentication on REST', () => {
  it('answers each failed person lookup in its own sentence', async () => {
    const fx = await fixture()
    const { t, f } = fx
    const expired = await plantToken(t, f.admin, {
      access: 'write',
      expires_at: '2020-01-01T00:00:00.000Z',
    })
    const revoked = await plantToken(t, f.admin, { access: 'write', revoked_at: NOW })
    const unclaimed = await plantSeat(t, { org_id: f.org.id, name: 'Unclaimed' })
    const unclaimedToken = await plantToken(t, unclaimed, { access: 'write' })
    const inactive = await plantSeat(t, {
      org_id: f.org.id,
      name: 'Gone quiet',
      auth_user_id: 'auth_quiet',
      active: false,
    })
    const inactiveToken = await plantToken(t, inactive, { access: 'write' })
    for (const [credential, sentence] of [
      [null, 'missing agent key (Authorization: Bearer qva_…)'],
      [secret('qvt_'), 'unknown personal access token'],
      [revoked, 'this personal access token has been revoked or has expired'],
      [expired, 'this personal access token has been revoked or has expired'],
      [unclaimedToken, 'unknown personal access token'],
      [inactiveToken, 'this account has been deactivated'],
      // OAuth stays limited to the webhook routes
      [`qvo_${uuid()}`, 'missing agent key (Authorization: Bearer qva_…)'],
    ] as const) {
      expect(await call(t, credential, 'GET', '/v1/projects'), String(credential)).toEqual({
        status: 401,
        body: { error: sentence },
      })
    }
    // a personal token works in X-Api-Key too, and every request is stamped
    const res = await call(t, fx.writer, 'GET', '/v1/me', undefined, 'X-Api-Key')
    expect(res.status).toBe(200)
    expect(res.body.credential).toMatchObject({ kind: 'personal_token', access: 'write' })
    const stamped = await t.run((ctx) =>
      ctx.db
        .query('mcp_tokens')
        .withIndex('by_profile', (q) => q.eq('profile_id', f.admin.id))
        .collect(),
    )
    expect(stamped.filter((row) => row.last_used_at !== undefined)).toHaveLength(1)
  })

  it('a caller switched off or deleted mid-request gets its own 401', async () => {
    const fx = await fixture()
    const { t, f } = fx
    // the shell reads the body after authenticating and before dispatch, so
    // the profile flips in between
    const flipBefore = (change: () => Promise<unknown>) => {
      const readText = Request.prototype.text
      return vi.spyOn(Request.prototype, 'text').mockImplementationOnce(async function (
        this: Request,
      ) {
        await change()
        return readText.call(this)
      })
    }
    const user = await plantToken(t, f.user, { access: 'write' })
    const patchTitle = () => call(t, user, 'PATCH', '/v1/tasks/QN-1', { title: 'x' })
    let spy = flipBefore(() => t.run((ctx) => ctx.db.patch(f.user._id, { active: false })))
    expect(await patchTitle()).toEqual({
      status: 401,
      body: { error: 'this account has been deactivated' },
    })
    spy.mockRestore()
    await t.run((ctx) => ctx.db.patch(f.user._id, { active: true }))
    spy = flipBefore(() => t.run((ctx) => ctx.db.delete(f.user._id)))
    expect(await patchTitle()).toEqual({
      status: 401,
      body: { error: 'unknown personal access token' },
    })
    spy.mockRestore()
    // the agent leg keeps its pinned sentence
    spy = flipBefore(() => t.run((ctx) => ctx.db.patch(f.agent._id, { active: false })))
    expect(await call(t, fx.agentKey, 'PATCH', '/v1/tasks/QN-1', { title: 'x' })).toEqual({
      status: 401,
      body: { error: 'this agent has been deactivated' },
    })
    spy.mockRestore()
  })
})

/* ------------------------------------------------ 3. writes as a person */

describe('a person writing over REST', () => {
  it('narrates via the REST API with no token name; agent keys keep the key name', async () => {
    const fx = await fixture()
    const { t, f } = fx
    const created = await call(t, fx.writer, 'POST', '/v1/tasks', { project: 'FW', title: 'Mine' })
    expect(created.status).toBe(201)
    expect(created.body.reporter_id).toBe(f.admin.id)
    const key = created.body.key as string
    expect((await call(t, fx.writer, 'PATCH', `/v1/tasks/${key}`, { title: 'Ours' })).status).toBe(
      200,
    )
    expect((await call(t, fx.writer, 'DELETE', `/v1/tasks/${key}`)).status).toBe(200)
    const byAgent = await call(t, fx.agentKey, 'POST', '/v1/tasks', { project: 'FW', title: 'Bot' })
    expect(byAgent.status).toBe(201)
    const rows = (await activityFor(t, f.org.id)).map((row) => [row.verb, row.actor_id, row.detail])
    expect(rows).toEqual([
      ['created', f.admin.id, 'via the REST API'],
      ['changed', f.admin.id, '(title “Mine” → “Ours”) — via the REST API'],
      ['deleted', f.admin.id, 'via the REST API'],
      ['created', f.agent.id, 'via the REST API (CI key)'],
    ])
  })

  it('authors comments as the person and refuses attribution in the person sentence', async () => {
    const fx = await fixture()
    const task = await plantIssue(fx.t, { org_id: fx.f.org.id, project_id: fx.f.sub.id })
    const path = `/v1/tasks/QN-${task.num}/comments`
    const posted = await call(fx.t, fx.writer, 'POST', path, { body: 'Looks right' })
    expect(posted.status).toBe(201)
    expect(posted.body).toMatchObject({ author_id: fx.f.admin.id, author_name: 'admin' })
    expect(await call(fx.t, fx.writer, 'POST', path, { body: 'x', author_id: uuid() })).toEqual({
      status: 400,
      body: {
        error:
          'comments cannot be attributed over the API; a comment is always authored by the person posting it',
      },
    })
    expect((await call(fx.t, fx.agentKey, 'POST', path, { body: 'x', author: 'me' })).body).toEqual(
      {
        error:
          'comments cannot be attributed over the API — a comment is always authored by the agent posting it',
      },
    )
  })

  it('project access flags follow the credential, so a read-only token never shows write', async () => {
    const fx = await fixture()
    const flags = async (credential: string) =>
      (await call(fx.t, credential, 'GET', '/v1/projects/FW')).body.access
    expect(await flags(fx.writer)).toEqual({ read: true, write: true })
    expect(await flags(fx.reader)).toEqual({ read: true, write: false })
    expect(await flags(fx.viewer)).toEqual({ read: true, write: false })
    expect(await flags(fx.agentKey)).toEqual({ read: true, write: true })
    expect(await flags(fx.viewerKey)).toEqual({ read: true, write: false })
    const listed = (await call(fx.t, fx.reader, 'GET', '/v1/projects')).body as unknown as {
      access: { write: boolean }
    }[]
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.every((p) => p.access.write === false)).toBe(true)
  })
})

/* ------------------------------------------------ 4. PATCH /v1/users/{id} */

describe('PATCH /v1/users/{id}', () => {
  it('sets plannable hours by the shared rule and answers the user row', async () => {
    const fx = await fixture()
    const { t, f } = fx
    const patch = (credential: string, id: string, body: unknown) =>
      call(t, credential, 'PATCH', `/v1/users/${id}`, body)
    expect(await patch(fx.writer, f.user.id.toUpperCase(), { plannable_hours: 31 })).toEqual({
      status: 200,
      body: {
        id: f.user.id,
        name: 'user',
        org_role: 'user',
        kind: 'person',
        active: true,
        plannable_hours: 31,
      },
    })
    // a leader of a team the person belongs to (user leads Hardware, which
    // admin is a member of)
    const leader = await plantToken(t, f.user, { access: 'write' })
    expect((await patch(leader, f.admin.id, { plannable_hours: 20 })).body.plannable_hours).toBe(20)
    // nobody else, an agent included, and the same answer for every target
    for (const credential of [fx.viewer, fx.agentKey, leader]) {
      const target = credential === leader ? f.viewer.id : f.user.id
      expect(await patch(credential, target, { plannable_hours: 25 })).toEqual({
        status: 403,
        body: { error: RIGHTS },
      })
    }
    expect(await patch(fx.reader, f.user.id, { plannable_hours: 25 })).toEqual({
      status: 403,
      body: { error: READS_ONLY },
    })
    expect(await patch(fx.writer, f.agent.id, { plannable_hours: 25 })).toEqual({
      status: 400,
      body: { error: 'an agent has no plannable week — its capacity is unbounded' },
    })
    for (const id of [uuid(), f.otherAdmin.id, 'nobody']) {
      expect(await patch(fx.writer, id, { plannable_hours: 25 }), id).toEqual({
        status: 404,
        body: { error: 'user not found' },
      })
    }
    const whole = 'plannable hours must be a whole number of hours from 1 to 168'
    for (const [body, error] of [
      [{ plannable_hours: 31.5 }, whole],
      [{ plannable_hours: '30' }, whole],
      [{ plannable_hours: 0 }, whole],
      [{ plannable_hours: 169 }, whole],
      [{ name: 'Renamed' }, 'no recognized fields to update'],
      ['not json', 'request body must be JSON'],
    ] as const) {
      expect(await patch(fx.writer, f.user.id, body), JSON.stringify(body)).toEqual({
        status: 400,
        body: { error },
      })
    }
    const row = await t.run((ctx) => ctx.db.get(f.user._id))
    expect(row?.plannable_hours).toBe(31)
    // capacity is a setting, not an event: no activity row
    expect(await activityFor(t, f.org.id)).toEqual([])
  })
})
