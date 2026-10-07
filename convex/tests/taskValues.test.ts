import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import { sha256hex } from '../machine/auth'
import {
  activityFor,
  as,
  expectRefusal,
  NOW,
  newT,
  plantIssue,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

const taskRow = (t: T, id: string) =>
  t.run((ctx) =>
    ctx.db
      .query('issues')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique(),
  )

const bodyOf = (response: Response): Promise<string> =>
  (response as unknown as { text(): Promise<string> }).text()

describe('task value guards', () => {
  it('refuses invalid calendar dates on create and update without partial writes', async () => {
    const t = newT()
    const org = await withOrg(t)
    const caller = as(t, org.admin)
    const row = await plantIssue(t, {
      org_id: org.org.id,
      project_id: org.sub.id,
      start_week: '2026-02-02',
      end_week: '2026-03-02',
      due_date: '2026-03-06',
    })
    const beforeActivity = await activityFor(t, org.org.id)
    for (const field of ['start_week', 'end_week', 'due_date'] as const) {
      for (const invalid of [
        'not-a-date',
        '',
        '2026-02-29',
        '2026-04-31',
        '2026-13-01',
        '2026-01-00',
      ]) {
        const dates = { start_week: '2026-02-02', end_week: '2026-03-02', [field]: invalid }
        const id = uuid()
        await expectRefusal(
          caller.mutation(api.issues.create, {
            org_id: org.org.id,
            project_id: org.sub.id,
            id,
            title: 'Refused dates',
            ...dates,
          }),
          'bad_request',
          new RegExp(`^${field} must be `),
        )
        expect(await taskRow(t, id)).toBeNull()
        await expectRefusal(
          caller.mutation(api.issues.update, {
            org_id: org.org.id,
            id: row.id,
            patch: { title: 'Must not land', [field]: invalid },
          }),
          'bad_request',
          new RegExp(`^${field} must be `),
        )
      }
    }
    expect(await taskRow(t, row.id)).toEqual(row)
    expect(await activityFor(t, org.org.id)).toEqual(beforeActivity)
  })

  it('keeps valid leap days, partial plan updates, non-Monday weeks and null clearing', async () => {
    const t = newT()
    const org = await withOrg(t)
    const caller = as(t, org.admin)
    const created = await caller.mutation(api.issues.create, {
      org_id: org.org.id,
      project_id: org.sub.id,
      id: uuid(),
      title: 'Leap-year plan',
      start_week: '2028-02-29',
      end_week: '2028-03-07',
      due_date: '2028-03-10',
    })
    expect(created).toMatchObject({ start_week: '2028-02-29', end_week: '2028-03-07' })
    const updated = await caller.mutation(api.issues.update, {
      org_id: org.org.id,
      id: created.id,
      patch: { end_week: '2028-03-14' },
    })
    expect(updated).toMatchObject({ start_week: '2028-02-29', end_week: '2028-03-14' })
    const cleared = await caller.mutation(api.issues.update, {
      org_id: org.org.id,
      id: created.id,
      patch: { start_week: null, end_week: null, due_date: null },
    })
    for (const field of ['start_week', 'end_week', 'due_date'] as const)
      expect(cleared[field]).toBeUndefined()
  })

  it('refuses non-finite estimates and preserves finite values without rounding overflow', async () => {
    const t = newT()
    const org = await withOrg(t)
    const caller = as(t, org.admin)
    const row = await plantIssue(t, {
      org_id: org.org.id,
      project_id: org.sub.id,
      remaining_hours: 5,
      remaining_set_at: NOW,
    })
    for (const invalid of [Number.NaN, Infinity, -Infinity, -0.1]) {
      const id = uuid()
      await expectRefusal(
        caller.mutation(api.issues.create, {
          org_id: org.org.id,
          project_id: org.sub.id,
          id,
          title: 'Refused hours',
          remaining_hours: invalid,
        }),
        'bad_request',
        /^remaining_hours must be a non-negative number or null$/,
      )
      expect(await taskRow(t, id)).toBeNull()
      await expectRefusal(
        caller.mutation(api.issues.update, {
          org_id: org.org.id,
          id: row.id,
          patch: { remaining_hours: invalid },
        }),
        'bad_request',
        /^remaining_hours must be a non-negative number or null$/,
      )
    }
    expect(await taskRow(t, row.id)).toEqual(row)
    for (const [input, stored] of [
      [5.25, 5.3],
      [0, 0],
      [Number.MAX_VALUE, Number.MAX_VALUE],
    ]) {
      const updated = await caller.mutation(api.issues.update, {
        org_id: org.org.id,
        id: row.id,
        patch: { remaining_hours: input },
      })
      expect(updated.remaining_hours).toBe(stored)
      expect(Number.isFinite(updated.remaining_hours)).toBe(true)
    }
    const cleared = await caller.mutation(api.issues.update, {
      org_id: org.org.id,
      id: row.id,
      patch: { remaining_hours: null },
    })
    expect(cleared.remaining_hours).toBeUndefined()
    expect(cleared.remaining_set_at).toBeUndefined()
  })
})

describe('task value guards over HTTP', () => {
  it('returns REST 400 and MCP tool refusals for impossible dates and overflowing JSON numbers', async () => {
    const t = newT()
    const org = await withOrg(t)
    const secret = `qva_${'task-values'.repeat(6)}`
    const keyHash = await sha256hex(secret)
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: org.meta.id,
        profile_id: org.agent.id,
        level: 'user',
      })
      await ctx.db.insert('agent_keys', {
        id: uuid(),
        profile_id: org.agent.id,
        name: 'Task value checks',
        key_prefix: secret.slice(0, 11),
        key_hash: keyHash,
        created_at: NOW,
      })
    })
    const http = t as unknown as {
      fetch(
        path: string,
        init: { method: string; headers: Record<string, string>; body: string },
      ): Promise<Response>
    }
    const row = await plantIssue(t, { org_id: org.org.id, project_id: org.sub.id })
    const errors = [
      ['"due_date":"2026-02-31"', 'due_date must be a valid calendar date or null'],
      ['"remaining_hours":1e309', 'remaining_hours must be a non-negative number or null'],
    ] as const
    for (const [field, message] of errors) {
      for (const create of [true, false]) {
        const rest = await http.fetch(create ? '/v1/tasks' : `/v1/tasks/${row.id}`, {
          method: create ? 'POST' : 'PATCH',
          headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
          body: `{${create ? '"project":"FW","title":"Refused import",' : ''}${field}}`,
        })
        expect(rest.status).toBe(400)
        expect(JSON.parse(await bodyOf(rest))).toEqual({ error: message })

        for (const modern of [false, true]) {
          const name = create ? 'create_task' : 'update_task'
          const meta = modern
            ? `,"_meta":${JSON.stringify({
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'task-value-checks',
                  version: '1.0.0',
                },
                'io.modelcontextprotocol/clientCapabilities': {},
              })}`
            : ''
          const args = create ? '"project":"FW","title":"Refused import"' : `"ref":"${row.id}"`
          const mcp = await http.fetch('/mcp', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${secret}`,
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              ...(modern
                ? {
                    'MCP-Protocol-Version': '2026-07-28',
                    'Mcp-Method': 'tools/call',
                    'Mcp-Name': name,
                  }
                : {}),
            },
            body: `{"jsonrpc":"2.0","method":"tools/call","params":{"name":"${name}","arguments":{${args},${field}}${meta}},"id":1}`,
          })
          const body = await bodyOf(mcp)
          expect(mcp.status, `${name} (${modern ? 'modern' : 'legacy'}): ${body}`).toBe(200)
          const result = JSON.parse(
            modern ? body : body.slice('event: message\ndata: '.length, -2),
          ).result
          expect(result.isError).toBe(true)
          expect(result.content[0].text).toBe(
            field.includes('1e309')
              ? `Input validation error: Invalid arguments for tool ${name}: remaining_hours: Too big: expected number to be <=99999.9`
              : message,
          )
        }
      }
    }
    expect(await taskRow(t, row.id)).toEqual(row)
    expect(await activityFor(t, org.org.id)).toEqual([])
  })
})
