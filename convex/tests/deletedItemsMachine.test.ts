/* REST and MCP deletes move tasks to Deleted items like the app's, and record
 * the credential each request came with (design 4.2). The record keeps its
 * table, uuid and name as they were, the list shows a personal token's or
 * connected app's name only to organization admins and the deleter, and the
 * activity row keeps the provenance it always had, which never names a
 * personal token. Fake timers keep steps from running until a test releases
 * them. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import { CALLER_GONE } from '../lib/core'
import type { EventOwner } from '../lib/taskEvents'
import { NAME_MAX } from '../lib/textLimits'
import {
  activityFor,
  as,
  expectRefusal,
  newT,
  type OrgFixture,
  plantIssue,
  type T,
  withOrg,
} from './helpers.setup'
import { installTrashTimers, itemFor, plantCredential } from './trash.setup'

installTrashTimers()

/* withOrg, with the fixture agent able to edit the Testbed platform, as
 * rest.test.ts and mcp.test.ts grant it. */
async function org(t: T): Promise<OrgFixture> {
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

/** DELETE /v1/tasks/{ref}: `keyName` is an agent key's name, or null for a
 * personal token, as the HTTP action passes them. */
const restDelete = (
  t: T,
  who: Doc<'profiles'>,
  credential: EventOwner,
  task: Doc<'issues'>,
  keyName: string | null,
) =>
  t.mutation(internal.machine.rest.deleteIssue, {
    callerId: who.id,
    access: 'write',
    keyName,
    credential,
    ref: task.id,
  })

const mcpDelete = (t: T, who: Doc<'profiles'>, credential: EventOwner, task: Doc<'issues'>) =>
  t.mutation(internal.machine.mcp.deleteIssue, {
    callerId: who.id,
    access: 'write',
    credential,
    ref: task.id,
  })

/** The Deleted items rows `who` sees, by item id. */
async function rowsOf(t: T, who: Doc<'profiles'>) {
  const { items } = await as(t, who).query(api.deletedItems.list, {})
  return new Map(items.map((row) => [row.id, row]))
}

describe('REST and MCP deletes in Deleted items', () => {
  it('record each kind of credential, and keep the provenance the activity row always had', async () => {
    const t = newT()
    const f = await org(t)
    const key = await plantCredential(t, f.agent, 'agent_keys', 'Sync bot key')
    const token = await plantCredential(t, f.guest, 'mcp_tokens', 'Laptop script')
    const app = await plantCredential(t, f.guest, 'oauth_connections', 'Claude')
    const task = () => plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const [overKey, overToken, overMcpToken, overApp] = [
      await task(),
      await task(),
      await task(),
      await task(),
    ]

    await restDelete(t, f.agent, key, overKey, 'Sync bot key')
    await restDelete(t, f.guest, token, overToken, null)
    await mcpDelete(t, f.guest, token, overMcpToken)
    await mcpDelete(t, f.guest, app, overApp)

    const via = (credential: EventOwner, name: string) => ({
      table: credential.credential_table,
      id: credential.credential_id,
      name,
    })
    for (const [deleted, by, credential, name] of [
      [overKey, f.agent, key, 'Sync bot key'],
      [overToken, f.guest, token, 'Laptop script'],
      [overMcpToken, f.guest, token, 'Laptop script'],
      [overApp, f.guest, app, 'Claude'],
    ] as const) {
      const item = await itemFor(t, deleted.id)
      expect(item).toMatchObject({ state: 'ready', deleted_by: by.id, via: via(credential, name) })
      expect(item.reason).toBeUndefined()
    }
    const detail = new Map((await activityFor(t, f.org.id)).map((e) => [e.target_id, e.detail]))
    expect([overKey, overToken, overMcpToken, overApp].map((d) => detail.get(d.id))).toEqual([
      'via the REST API (Sync bot key)',
      'via the REST API',
      'via MCP',
      'via MCP',
    ])
  })

  it('names a personal token or connected app to admins and the deleter, an agent key to the lead', async () => {
    const t = newT()
    const f = await org(t)
    const key = await plantCredential(t, f.agent, 'agent_keys', 'Sync bot key')
    const token = await plantCredential(t, f.guest, 'mcp_tokens', 'Laptop script')
    const app = await plantCredential(t, f.guest, 'oauth_connections', 'Claude')
    const overKey = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const overToken = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const overApp = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await restDelete(t, f.agent, key, overKey, 'Sync bot key')
    await restDelete(t, f.guest, token, overToken, null)
    await mcpDelete(t, f.guest, app, overApp)
    const ids = [
      (await itemFor(t, overKey.id)).id,
      (await itemFor(t, overToken.id)).id,
      (await itemFor(t, overApp.id)).id,
    ]
    const deleters = async (who: Doc<'profiles'>) => {
      const rows = await rowsOf(t, who)
      return ids.map((id) => {
        const deleter = rows.get(id)?.deleter
        return [deleter?.kind, deleter?.credential_name]
      })
    }

    // the user leads the Testbed platform, so every delete in it shows
    expect(await deleters(f.user)).toEqual([
      ['agent_keys', 'Sync bot key'],
      ['mcp_tokens', undefined],
      ['oauth_connections', undefined],
    ])
    expect(JSON.stringify([...(await rowsOf(t, f.user)).values()])).not.toMatch(
      /Laptop script|Claude/,
    )
    const named = [
      ['agent_keys', 'Sync bot key'],
      ['mcp_tokens', 'Laptop script'],
      ['oauth_connections', 'Claude'],
    ]
    expect(await deleters(f.admin)).toEqual(named)
    // the guest sees their own two deletes with their names
    expect((await deleters(f.guest)).slice(1)).toEqual(named.slice(1))
  })

  it('names a credential revoked after the request was accepted, and refuses one deleted since', async () => {
    const t = newT()
    const f = await org(t)
    const token = await plantCredential(t, f.guest, 'mcp_tokens', 'Laptop script')
    const revokedFirst = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const deletedFirst = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const row = token.credential_row_id as Id<'mcp_tokens'>
    await t.run((ctx) => ctx.db.patch(row, { revoked_at: new Date().toISOString() }))
    await mcpDelete(t, f.guest, token, revokedFirst)
    expect((await itemFor(t, revokedFirst.id)).via).toEqual({
      table: 'mcp_tokens',
      id: token.credential_id,
      name: 'Laptop script',
    })

    // gone between auth and dispatch, or another profile's: the race reason,
    // which the HTTP actions answer with the caller's 401 sentence
    const other = await plantCredential(t, f.user, 'mcp_tokens', 'Not theirs')
    for (const credential of [other, token]) {
      if (credential === token) await t.run((ctx) => ctx.db.delete(row))
      const refusal = await expectRefusal(
        restDelete(t, f.guest, credential, deletedFirst, null),
        'forbidden',
      )
      expect(refusal.data).toMatchObject({ reason: CALLER_GONE })
    }
    expect(
      await t.run((ctx) =>
        ctx.db
          .query('deleted_items')
          .withIndex('by_target', (q) => q.eq('target_id', deletedFirst.id))
          .collect(),
      ),
    ).toEqual([])
  })

  it('cuts a name stored before the 80 character cap, as the activity row does, and keeps one at the cap', async () => {
    const t = newT()
    const f = await org(t)
    const atCap = '🔑'.repeat(NAME_MAX)
    const long = `${'Legacy sync key '.repeat(6)}end`
    // its first 80 code points end on a space, which the cut drops
    const cut = `${'Legacy sync key '.repeat(5).trimEnd()}…`
    const longKey = await plantCredential(t, f.agent, 'agent_keys', long)
    const capKey = await plantCredential(t, f.agent, 'agent_keys', atCap)
    const longApp = await plantCredential(t, f.guest, 'oauth_connections', long)
    const task = () => plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const [overLongKey, overCapKey, overLongApp] = [await task(), await task(), await task()]

    await restDelete(t, f.agent, longKey, overLongKey, long)
    await restDelete(t, f.agent, capKey, overCapKey, atCap)
    await mcpDelete(t, f.guest, longApp, overLongApp)

    expect((await itemFor(t, overLongKey.id)).via?.name).toBe(cut)
    expect((await itemFor(t, overCapKey.id)).via?.name).toBe(atCap)
    expect((await itemFor(t, overLongApp.id)).via?.name).toBe(cut)
    const detail = new Map((await activityFor(t, f.org.id)).map((e) => [e.target_id, e.detail]))
    expect(detail.get(overLongKey.id)).toBe(`via the REST API (${cut})`)
  })
})
