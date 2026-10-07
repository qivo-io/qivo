/* LIVE contract pass — the /v1/* REST surface over the real wire.
 *
 * STATE HYGIENE (read before running):
 *   - The target is the SHARED cloud dev deployment from .env.local
 *     (override with CONTRACT_BASE_URL). globalSetup RESETS the Northstar
 *     Labs development copy, so a run loses manual work in that organization
 *     by design — never overlap with `npm run dev` work or a smoke run.
 *   - This suite creates only rows it deletes (write round-trip + OCC probe,
 *     both cleaned up, with an afterAll backstop).
 *   - It runs serially (fileParallelism: false in vitest.contract.config.mts)
 *     and only via `npm run test:contract` — plain `npm test` excludes it.
 *   - Every assert on seeded data names the dataset constant (QN-2, Luma
 *     Sensor, Atlas…) so a drifted dataset fails loudly, not weirdly.
 *
 * What this pass proves that convex/tests/rest.test.ts (the unit suite over
 * the internal fns) cannot: the real routing/mount, the real HTTP envelope
 * (statuses, CORS, 401 bodies, 405/Allow), the serializer over the real wire,
 * and real OCC on issue numbering. Refusal sentences are byte-pinned from
 * convex/machine/{auth,rest}.ts. */

import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, test } from 'vitest'

type Stash = {
  siteUrl: string
  orgId: string
  qva: string
  qvt: string
  qvaId: string
  qvtId: string
}
const stash: Stash = JSON.parse(
  readFileSync(new URL('./.credentials.json', import.meta.url), 'utf8'),
)
const BASE = process.env.CONTRACT_BASE_URL ?? stash.siteUrl

const AUTH = { Authorization: `Bearer ${stash.qva}` }
const call = (
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = { headers: AUTH },
): Promise<Response> =>
  fetch(`${BASE}${path}`, {
    method,
    headers: opts.headers ?? AUTH,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })

/* App-owned 401 bodies (convex/machine/auth.ts REST_AUTH_401), byte-exact. */
const E401_MISSING = '{"error":"missing agent key (Authorization: Bearer qva_…)"}'
const E401_UNKNOWN = '{"error":"unknown agent key"}'

/* The full REST issue projection (lib/core.ts issueOut, surface 'rest') as a
 * SET: the value crosses the Convex function boundary before the httpAction
 * stringifies it, and Convex canonically sorts object keys there — the live
 * wire is alphabetical, so key ORDER is not contract, key PRESENCE is
 * (explicit null, never omitted). */
const ISSUE_KEYS = [
  'archived',
  'archived_at',
  'assignee_id',
  'assignee_name',
  'created_at',
  'description',
  'due_date',
  'end_week',
  'id',
  'is_group',
  'key',
  'num',
  'parent_id',
  'paused',
  'priority',
  'project_id',
  'project_key',
  'project_num',
  'remaining_hours',
  'remaining_set_at',
  'reporter_id',
  'reporter_name',
  'reviewer_id',
  'reviewer_name',
  'start_week',
  'status',
  'title',
  'updated_at',
].sort()

const YMD = /^\d{4}-\d{2}-\d{2}$/

/* Backstop: any issue a failing test left behind dies here. */
const leftovers = new Set<string>()
afterAll(async () => {
  for (const ref of leftovers) {
    await call('DELETE', `/v1/tasks/${ref}`).catch(() => undefined)
  }
})

/* ------------------------------------------------------- 1. routing/mount */

describe('routing and mount', () => {
  test('GET /v1/projects with the qva key answers the agent-readable catalogue', async () => {
    const res = await call('GET', '/v1/projects')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const rows = (await res.json()) as {
      key: string
      name: string
      access: { read: boolean; write: boolean }
    }[]
    // Atlas sits in both Northstar teams, each a 'user' on the metas it
    // manages — its key reads and writes all fifteen projects, key-sorted
    // (the hidden-project 404 lives in the hermetic convex/tests/rest.test.ts)
    expect(rows.map((p) => p.key)).toEqual([
      'API',
      'BRAND',
      'CLOUD',
      'CS',
      'CUST',
      'ELEC',
      'FW',
      'MECH',
      'MFG',
      'PILOT',
      'REL',
      'SENS',
      'TEST',
      'UX',
      'WEB',
    ])
    const sensor = rows.find((p) => p.key === 'SENS')
    expect(sensor?.name).toBe('Luma Sensor')
    expect(sensor?.access).toEqual({ read: true, write: true })
  })

  test('GET /v1/projects/{ref}/users returns the project-scoped reporter roster', async () => {
    const res = await call('GET', '/v1/projects/ELEC/users')
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Record<string, unknown>[]
    expect(Object.fromEntries(rows.map((user) => [user.name, user.assignable]))).toEqual({
      'Nora Berg': true,
      'Leo Martins': true,
      'Aisha Rahman': true,
      'Emil Strand': true,
      'Daniel Park': false,
      'Sofia Andersson': true,
      'Ben Carter': false,
      Atlas: true,
    })
    const atlas = rows.find((u) => u.name === 'Atlas')
    expect(atlas).toEqual({
      id: atlas?.id,
      name: 'Atlas',
      org_role: 'user',
      kind: 'agent',
      active: true,
      plannable_hours: null,
      assignable: true,
    })
    expect(rows.find((u) => u.name === 'Leo Martins')?.assignable).toBe(true)

    const unknown = await call('GET', '/v1/projects/NOPE/users')
    expect(unknown.status).toBe(404)
    expect(await unknown.text()).toBe('{"error":"project not found"}')
  })

  test('bare /v1 is mounted and answers the in-handler 404 sentence', async () => {
    const res = await call('GET', '/v1')
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('{"error":"unknown route"}')
  })

  test('/v99 is outside the mount — the platform default 404, not an app body', async () => {
    // http.ts registers only path /v1 + prefix /v1/* (no root catch-all —
    // accepted delta), so /v99 never reaches the handler; the body below is
    // Convex's own 404 and may change with the platform
    const res = await call('GET', '/v99', { headers: {} })
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('No matching routes found')
  })

  test('trailing-slash equivalence: /v1/tasks/ === /v1/tasks', async () => {
    const bare = await call('GET', '/v1/tasks')
    const slash = await call('GET', '/v1/tasks/')
    expect(bare.status).toBe(200)
    expect(slash.status).toBe(200)
    expect(await slash.text()).toBe(await bare.text())
  })

  test('the former /v1/issues resource is not an alias', async () => {
    const res = await call('GET', '/v1/issues')
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('{"error":"unknown route"}')
  })
})

/* -------------------------------------------------------- 2. the 401 surface */

describe('the 401 surface', () => {
  test('no auth → the missing sentence, with CORS and JSON content-type', async () => {
    const res = await call('GET', '/v1/tasks', { headers: {} })
    expect(res.status).toBe(401)
    expect(await res.text()).toBe(E401_MISSING)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  test('a qvt_ person token on REST is the missing failure, not wrong-kind', async () => {
    // classifySecret runs {person:false} here — the VALID minted qvt still
    // reads as a bad prefix, without a DB hit
    const res = await call('GET', '/v1/tasks', {
      headers: { Authorization: `Bearer ${stash.qvt}` },
    })
    expect(res.status).toBe(401)
    expect(await res.text()).toBe(E401_MISSING)
  })

  test('an unknown qva_ key answers the unknown sentence', async () => {
    const res = await call('GET', '/v1/tasks', {
      headers: { Authorization: 'Bearer qva_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    })
    expect(res.status).toBe(401)
    expect(await res.text()).toBe(E401_UNKNOWN)
  })

  test("lowercase 'bearer' is not Bearer — falls through to missing", async () => {
    const res = await call('GET', '/v1/tasks', {
      headers: { Authorization: `bearer ${stash.qva}` },
    })
    expect(res.status).toBe(401)
    expect(await res.text()).toBe(E401_MISSING)
  })

  test('the X-Api-Key fallback authenticates', async () => {
    const res = await call('GET', '/v1/projects', { headers: { 'X-Api-Key': stash.qva } })
    expect(res.status).toBe(200)
  })
})

/* ------------------------------------------- 3. 405 / Allow / OPTIONS CORS */

describe('method handling and CORS preflight', () => {
  test('an unregistered method gets the router 405 with the Allow list', async () => {
    // FOO is registered nowhere; Convex's router answers (HEAD rides along
    // with GET, which is why it appears although rest.ts cannot register it)
    const res = await call('FOO', '/v1/tasks', { headers: {} })
    expect(res.status).toBe(405)
    expect(await res.text()).toBe('')
    expect(res.headers.get('allow')).toBe('GET,HEAD,POST,DELETE,PATCH,PUT,OPTIONS')
  })

  test('PUT is registered to answer the deployed auth-then-404 behavior', async () => {
    const bare = await call('PUT', '/v1/tasks/QN-1', { headers: {} })
    expect(bare.status).toBe(401)
    expect(await bare.text()).toBe(E401_MISSING)
    const authed = await call('PUT', '/v1/tasks/QN-1')
    expect(authed.status).toBe(404)
    expect(await authed.text()).toBe('{"error":"unknown route"}')
  })

  test('OPTIONS answers ok with the exact CORS triple', async () => {
    const res = await call('OPTIONS', '/v1/tasks', { headers: {} })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-headers')).toBe(
      'authorization, x-api-key, content-type',
    )
    expect(res.headers.get('access-control-allow-methods')).toBe(
      'GET, POST, PATCH, DELETE, OPTIONS',
    )
  })
})

/* ------------------------------------------------ 4. wire types on real JSON */

describe('serializer over the real wire (seeded QN-2)', () => {
  test('GET /v1/tasks/QN-2: num is a JSON number, dates are YYYY-MM-DD-or-null, every field present', async () => {
    const res = await call('GET', '/v1/tasks/QN-2')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    const raw = await res.text()
    // the number is a bare JSON number on the wire, never a string
    expect(raw).toContain('"num":2')
    const body = JSON.parse(raw) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(ISSUE_KEYS)
    // dataset constants: QN-2 = 'Release PCB revision B' in ELEC, an
    // in-progress high-priority group assigned to Leo, scheduled with a due
    // date — not QN-1, a Done task the 30-day archive sweep eventually moves
    expect(body.key).toBe('QN-2')
    expect(body.num).toBe(2)
    expect(typeof body.num).toBe('number')
    expect(body.title).toBe('Release PCB revision B')
    expect(body.project_key).toBe('ELEC')
    expect(typeof body.project_num).toBe('number')
    expect(body.status).toBe('progress')
    expect(body.is_group).toBe(true) // its two subtasks are live
    expect(body.priority).toBe('high')
    expect(body.assignee_name).toBe('Leo Martins')
    expect(body.reporter_name).toBe('Leo Martins')
    // the week/date trio: YYYY-MM-DD strings or explicit null, nothing else
    expect(body.start_week).toMatch(YMD)
    expect(body.end_week).toMatch(YMD)
    expect(body.due_date).toMatch(YMD)
    // explicit-null shape: absent columns arrive as null, never dropped
    expect(body.parent_id).toBeNull()
    expect(body.remaining_hours).toBeNull() // a parent carries no hours of its own
    expect(body.remaining_set_at).toBeNull()
    expect(body.archived).toBe(false)
    expect(body.archived_at).toBeNull()
    expect(body.paused).toBe(false)
    expect(body.description).toContain('**Acceptance criteria**')
  })
})

/* ------------------------------------------------------- 5. write round trip */

describe('write round trip (creates only what it deletes)', () => {
  test('POST → GET → folded PATCH → DELETE → 404', async () => {
    const projectUsers = await call('GET', '/v1/projects/ELEC/users')
    expect(projectUsers.status).toBe(200)
    const projectUsersRows = (await projectUsers.json()) as {
      id: string
      name: string
      assignable: boolean
    }[]
    const reporter = projectUsersRows.find((u) => u.name === 'Leo Martins')
    const viewOnly = projectUsersRows.find((u) => u.name === 'Daniel Park')
    expect(reporter).toBeDefined()
    expect(viewOnly).toBeDefined()
    if (reporter === undefined || viewOnly === undefined) {
      throw new Error('seeded Northstar project users are missing')
    }
    // POST into the seeded Luma Sensor meta, sub named
    const created = await call('POST', '/v1/tasks', {
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: {
        project: 'SENS',
        sub_project: 'ELEC',
        title: 'Contract round trip',
        reporter_id: reporter?.id,
      },
    })
    expect(created.status).toBe(201)
    const row = (await created.json()) as Record<string, unknown>
    leftovers.add(row.id as string)
    expect(Object.keys(row).sort()).toEqual(ISSUE_KEYS)
    expect(typeof row.num).toBe('number')
    expect(row.key).toBe(`QN-${row.num}`)
    expect(row.project_key).toBe('ELEC')
    expect(row.title).toBe('Contract round trip')
    expect(row.status).toBe('backlog')
    expect(row.is_group).toBe(false)
    expect(row.priority).toBe('low')
    expect(row.description).toBe('')
    expect(row.assignee_id).toBeNull()
    expect(row.reporter_id).toBe(reporter?.id)
    expect(row.reporter_name).toBe('Leo Martins')
    expect(row).not.toHaveProperty('creator_id')
    expect(row).not.toHaveProperty('creator_name')
    expect(row.due_date).toBeNull()
    expect(row.archived).toBe(false)
    expect(row.archived_at).toBeNull()

    const refusedCreate = await call('POST', '/v1/tasks', {
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: {
        project: 'SENS',
        sub_project: 'ELEC',
        title: 'View-only assignee must be refused',
        assignee_id: viewOnly.id,
      },
    })
    expect(refusedCreate.status).toBe(400)
    expect(await refusedCreate.json()).toEqual({
      error: `user "${viewOnly.id}" needs Edit permission or higher on this project to be assigned work`,
    })

    const refusedUpdate = await call('PATCH', `/v1/tasks/${row.key}`, {
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: { assignee_id: viewOnly.id },
    })
    expect(refusedUpdate.status).toBe(400)
    expect(await refusedUpdate.json()).toEqual({
      error: `user "${viewOnly.id}" needs Edit permission or higher on this project to be assigned work`,
    })

    const refusedReviewer = await call('PATCH', `/v1/tasks/${row.key}`, {
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: { reviewer_id: viewOnly.id },
    })
    expect(refusedReviewer.status).toBe(400)
    expect(await refusedReviewer.json()).toEqual({
      error: `user "${viewOnly.id}" needs Edit permission or higher on this project to review work`,
    })

    for (const reporter_id of [reporter?.id, null, 'not-a-user']) {
      const immutable = await call('PATCH', `/v1/tasks/${row.key}`, {
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: { reporter_id, title: 'Must not change', archived: true },
      })
      expect(immutable.status).toBe(400)
      expect(await immutable.json()).toEqual({
        error: 'reporter_id is set when a task is created and cannot be changed',
      })
    }
    const nullReporter = await call('POST', '/v1/tasks', {
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: { project: 'ELEC', title: 'Must not be created', reporter_id: null },
    })
    expect(nullReporter.status).toBe(400)
    expect(await nullReporter.json()).toEqual({ error: 'reporter_id must be a profile uuid' })

    // GET it back — the same projection, byte-for-byte field equality
    const fetched = await call('GET', `/v1/tasks/${row.key}`)
    expect(fetched.status).toBe(200)
    expect(await fetched.json()).toEqual(row)

    const commented = await call('POST', `/v1/tasks/${row.key}/comments`, {
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: { body: 'REST contract task comment' },
    })
    expect(commented.status).toBe(201)
    const comment = await commented.json()
    expect(comment).toMatchObject({ task_id: row.id, body: 'REST contract task comment' })
    expect(comment).not.toHaveProperty('issue_id')
    const comments = await call('GET', `/v1/tasks/${row.key}/comments`)
    expect(comments.status).toBe(200)
    expect(await comments.json()).toEqual([comment])

    // The HTTP search parameter carries reordered fragments and captured IDs.
    for (const search of ['TRIP cont', `${String(row.key).toLowerCase()} tract`]) {
      const found = await call('GET', `/v1/tasks?search=${encodeURIComponent(search)}`)
      expect(found.status).toBe(200)
      const matches = (await found.json()) as { id: string }[]
      expect(matches.map((issue) => issue.id)).toEqual([row.id])
    }

    // the FOLDED PATCH: fields + the archived toggle in one request
    const patched = await call('PATCH', `/v1/tasks/${row.key}`, {
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: { status: 'review', title: 'Contract round trip (renamed)', archived: true },
    })
    expect(patched.status).toBe(200)
    const after = (await patched.json()) as Record<string, unknown>
    expect(after.id).toBe(row.id)
    expect(after.status).toBe('review')
    // entering review lands the project review time (ELEC keeps the 2 h default)
    expect(after.remaining_hours).toBe(2)
    expect(typeof after.remaining_set_at).toBe('string')
    expect(after.title).toBe('Contract round trip (renamed)')
    expect(after.archived).toBe(true)
    expect(typeof after.archived_at).toBe('string')

    // DELETE answers the deployed inventory object
    const deleted = await call('DELETE', `/v1/tasks/${row.key}`)
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ deleted: true, id: row.id, key: row.key })
    leftovers.delete(row.id as string)

    // …and the ref is gone: the one 404 body
    const gone = await call('GET', `/v1/tasks/${row.key}`)
    expect(gone.status).toBe(404)
    expect(await gone.text()).toBe('{"error":"task not found"}')
  })
})

/* --------------------------------------------------------- 6. the OCC probe */

describe('numbering under real concurrency', () => {
  test('5 parallel POSTs take 5 distinct, dense, consecutive nums', async () => {
    // the serializable-numbering proof convex-test cannot run (its runtime is
    // single-threaded): real OCC on the org counter, no gaps, no duplicates
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        call('POST', '/v1/tasks', {
          headers: { ...AUTH, 'Content-Type': 'application/json' },
          body: { project: 'SENS', sub_project: 'ELEC', title: `OCC probe ${n}` },
        }),
      ),
    )
    const rows: { id: string; key: string; num: number }[] = []
    for (const res of results) {
      expect(res.status).toBe(201)
      const row = (await res.json()) as { id: string; key: string; num: number }
      rows.push(row)
      leftovers.add(row.id)
    }
    const nums = rows.map((r) => r.num).sort((a, b) => a - b)
    expect(new Set(nums).size).toBe(5) // distinct
    expect(nums[4] - nums[0]).toBe(4) // dense and consecutive
    for (const row of rows) {
      const deleted = await call('DELETE', `/v1/tasks/${row.id}`)
      expect(deleted.status).toBe(200)
      leftovers.delete(row.id)
    }
  })
})

describe('generic task webhooks', () => {
  test('lists own subscriptions, refuses private destinations and deletes an absent ID', async () => {
    const listing = await call('GET', '/v1/webhooks')
    expect(listing.status).toBe(200)
    expect(await listing.json()).toEqual([])
    const refused = await call('POST', '/v1/webhooks', {
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: {
        name: 'task.updated',
        arguments: {},
        delivery: {
          mode: 'webhook',
          url: 'https://127.0.0.1/events',
          secret: 'unused',
        },
      },
    })
    expect(refused.status).toBe(400)
    const absent = await call('DELETE', '/v1/webhooks/absent-contract-subscription')
    expect(absent.status).toBe(204)
  })
})
