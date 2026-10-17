/* Fixtures and readers shared by the Deleted items suites
 * (deletedItems.test.ts, deletedItemsRestore.test.ts,
 * deletedItemsList.test.ts, deletedItemsMachine.test.ts) and by the REST
 * and MCP delete tests.
 *
 * Two dots in the basename keep the Convex CLI from deploying this module,
 * the same rule as helpers.setup.ts. installTrashTimers puts a suite on fake
 * timers, so no scheduled step runs until a test releases it, and puts back
 * the budgets tests lower. */
/// <reference types="vite/client" />

import { afterEach, beforeEach, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc, Id, TableNames } from '../_generated/dataModel'
import { PURGE_ORG } from '../deletedItems'
import { byId } from '../lib/db'
import type { EventOwner } from '../lib/taskEvents'
import { EXPIRY, RETRY, TRASH_BUDGET } from '../model/deletedItems'
import { as, NOW, type OrgFixture, type T, uuid } from './helpers.setup'

declare class Blob {
  constructor(parts: string[])
}

export const START = Date.parse('2026-05-04T10:00:00.000Z')
export const DAY = 86_400_000
export const HOUR = 3_600_000
export const DEFAULT_BUDGET = { ...TRASH_BUDGET }
const DEFAULT_RETRY = { ...RETRY }
const DEFAULT_EXPIRY = { ...EXPIRY }
const DEFAULT_PURGE_ORG = { ...PURGE_ORG }

/** Fake timers from START for each test of the suite, and the default
 * budget, retries, expiry batch and purgeOrg batch back after it. */
export function installTrashTimers(): void {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })
  afterEach(() => {
    Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
    Object.assign(RETRY, DEFAULT_RETRY)
    Object.assign(EXPIRY, DEFAULT_EXPIRY)
    Object.assign(PURGE_ORG, DEFAULT_PURGE_ORG)
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })
}

/** Runs every scheduled function, steps included, until none is left. */
export const runSteps = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers)
/** One step of an item's job, run now. */
export const step = (t: T, item_id: string) => t.mutation(internal.deletedItems.step, { item_id })

/** The item whose root is `targetId`; fails when there is none. */
export const itemFor = async (t: T, targetId: string): Promise<Doc<'deleted_items'>> => {
  const item = await t.run((ctx) =>
    ctx.db
      .query('deleted_items')
      .withIndex('by_target', (q) => q.eq('target_id', targetId))
      .unique(),
  )
  if (item === null) throw new Error(`nothing in Deleted items for ${targetId}`)
  return item
}
export const itemById = (t: T, id: string) => t.run((ctx) => byId(ctx, 'deleted_items', id))
export const jobFor = (t: T, itemId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('deleted_item_jobs')
      .withIndex('by_item', (q) => q.eq('item_id', itemId))
      .unique(),
  )
export const storedRows = (t: T, itemId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('deleted_rows')
      .withIndex('by_item_owner', (q) => q.eq('item_id', itemId))
      .collect(),
  )
export const storedTasks = (t: T, itemId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('deleted_tasks')
      .withIndex('by_item', (q) => q.eq('item_id', itemId))
      .collect(),
  )
/** The stored task `id` as deleted_rows keeps it, or undefined. */
export const storedIssue = async (t: T, id: string) => {
  const row = await t.run((ctx) =>
    ctx.db
      .query('deleted_rows')
      .withIndex('by_row', (q) => q.eq('table', 'issues').eq('row_id', id))
      .unique(),
  )
  return row?.row.table === 'issues' ? row.row.doc : undefined
}
export const liveTask = (t: T, id: string) => t.run((ctx) => byId(ctx, 'issues', id))
export const blobExists = (t: T, id: Id<'_storage'>) =>
  t.run(async (ctx) => (await ctx.storage.get(id)) !== null)
export const deleteTask = (t: T, f: OrgFixture, id: string, extra: object = {}) =>
  as(t, f.user).mutation(api.issues.deleteDeep, { org_id: f.org.id, id, ...extra })
export const deleteProject = (t: T, f: OrgFixture, id: string) =>
  as(t, f.user).mutation(api.projects.deleteDeep, { org_id: f.org.id, id })

/** A credential of `table` for `profile`, named `name` (an OAuth
 * connection's app), named as the HTTP action hands the one a request came
 * with to a REST route or MCP tool. */
export async function plantCredential(
  t: T,
  profile: Doc<'profiles'>,
  table: EventOwner['credential_table'],
  name: string,
): Promise<EventOwner> {
  return await t.run(async (ctx) => {
    const id = uuid()
    const hash = `${id.replaceAll('-', '')}${'0'.repeat(32)}`
    const _id =
      table === 'agent_keys'
        ? await ctx.db.insert('agent_keys', {
            id,
            profile_id: profile.id,
            name,
            key_prefix: 'qva_012...abcde',
            key_hash: hash,
            created_at: NOW,
          })
        : table === 'mcp_tokens'
          ? await ctx.db.insert('mcp_tokens', {
              id,
              profile_id: profile.id,
              name,
              token_prefix: 'qvt_0123456',
              token_hash: hash,
              access: 'write',
              created_at: NOW,
            })
          : await ctx.db.insert('oauth_connections', {
              id,
              authorization_hash: hash,
              auth_user_id: profile.auth_user_id ?? `auth_${profile.id}`,
              profile_id: profile.id,
              org_id: profile.org_id,
              client_id: 'trash-test-client',
              client_name: name,
              resource: 'https://convex.test/mcp',
              requested_scopes: ['qivo:read', 'qivo:write'],
              scopes: ['qivo:read', 'qivo:write'],
              created_at: NOW,
              authorization_expires_at: NOW,
              approved_at: NOW,
            })
    return {
      profile_id: profile.id,
      credential_table: table,
      credential_id: id,
      credential_row_id: _id,
    }
  })
}

/** An attachment of `size` bytes on `task`, with its bytes stored. */
export async function attach(
  t: T,
  task: Doc<'issues'>,
  size = 5,
): Promise<Doc<'issue_attachments'>> {
  return await t.run(async (ctx) => {
    const storage_id = await ctx.storage.store(new Blob(['x'.repeat(size)]) as never)
    const _id = await ctx.db.insert('issue_attachments', {
      org_id: task.org_id,
      id: uuid(),
      issue_id: task.id,
      name: 'notes.txt',
      size_bytes: size,
      storage_id,
      inline: false,
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'issue_attachments'>
  })
}

export async function comment(
  t: T,
  task: Doc<'issues'>,
  body = 'Looks good',
): Promise<Doc<'comments'>> {
  return await t.run(async (ctx) => {
    const _id = await ctx.db.insert('comments', {
      id: uuid(),
      issue_id: task.id,
      body,
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'comments'>
  })
}

/** A live document tagged with its table, as deleted_rows stores it. */
export type Tagged = { table: string; doc: { _id: Id<TableNames>; _creationTime: number } }

/* One row of every stored kind for `task` (a comment, a label assignment, a
 * follow, an attachment with bytes, a link out to `to` and a link in from
 * `from`) plus an inbox message about it. Returns the live documents. */
export async function plantRows(
  t: T,
  f: OrgFixture,
  task: Doc<'issues'>,
  ends: { to: Doc<'issues'>; from: Doc<'issues'> },
) {
  const attachment = await attach(t, task)
  return await t.run(async (ctx) => {
    const org_id = f.org.id
    const labelId = uuid()
    await ctx.db.insert('labels', {
      id: labelId,
      org_id,
      name: 'Field',
      name_lower: 'field',
      color: '#ffcc00',
      created_at: NOW,
    })
    const link = (source: Doc<'issues'>, target: Doc<'issues'>) =>
      ctx.db.insert('issue_links', {
        org_id,
        id: uuid(),
        source_id: source.id,
        target_id: target.id,
        type: 'blocks',
        pair_key: [source.id, target.id].sort().join(':'),
        created_at: NOW,
      })
    const ids: [string, Id<'comments' | 'issue_labels' | 'issue_subscriptions' | 'issue_links'>][] =
      [
        [
          'comments',
          await ctx.db.insert('comments', {
            id: uuid(),
            issue_id: task.id,
            author: f.admin.id,
            body: 'Measured 3.7 V',
            created_at: NOW,
          }),
        ],
        [
          'issue_labels',
          await ctx.db.insert('issue_labels', { org_id, issue_id: task.id, label_id: labelId }),
        ],
        [
          'issue_subscriptions',
          await ctx.db.insert('issue_subscriptions', {
            issue_id: task.id,
            profile_id: f.admin.id,
            created_at: NOW,
          }),
        ],
        ['issue_links', await link(task, ends.to)],
        ['issue_links', await link(ends.from, task)],
      ]
    const rows: Tagged[] = [{ table: 'issue_attachments', doc: attachment }]
    for (const [table, id] of ids) {
      const doc = await ctx.db.get(id)
      if (doc === null) throw new Error(`planted ${table} row vanished`)
      rows.push({ table, doc })
    }
    const message = await ctx.db.insert('messages', {
      id: uuid(),
      org_id,
      recipient_id: f.admin.id,
      issue_id: task.id,
      issue_title: task.title,
      kind: 'change',
      detail: 'Status: To do → In progress',
      created_at: NOW,
    })
    return { rows, message, attachment, labelId }
  })
}

/** What deleted_rows must hold for a live document that travels with `owner`. */
export function expectedRow(live: Tagged, owner: string) {
  const { _id, _creationTime, ...doc } = live.doc as Tagged['doc'] & Record<string, unknown>
  // objectContaining needs absent fields left out, not set to undefined
  return {
    table: live.table,
    owner_id: owner,
    created_ts: _creationTime,
    row: { table: live.table, doc },
    ...(typeof doc.id === 'string' ? { row_id: doc.id } : {}),
    ...(live.table === 'issue_attachments' ? { storage_id: doc.storage_id } : {}),
  }
}
