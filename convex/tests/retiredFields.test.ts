/* The one-time migration that clears the retired fields
 * (internal/retiredFields.ts): its check and dry run write nothing, and the
 * clear removes the fields and nothing else, on teams, on attachment rows
 * and on the attachment copies Deleted items keeps. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import { NOW, newT, plantIssue, uuid, withOrg } from './helpers.setup'

/* edge-runtime provides Blob; convex/tsconfig's ESNext-only lib does not
 * declare it. */
declare class Blob {
  constructor(parts: string[])
}

describe('internal/retiredFields', () => {
  it('counts the rows holding a retired field, clears them, and reports zero after', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const attachment = (project_id?: string) => ({
      org_id: f.org.id,
      ...(project_id === undefined ? {} : { project_id }),
      id: uuid(),
      issue_id: task.id,
      name: 'scan.png',
      size_bytes: 3,
      inline: false,
      created_at: NOW,
    })
    await t.run(async (ctx) => {
      await ctx.db.patch(f.team._id, { stale_days: 14, archive_days: 30 })
      await ctx.db.insert('teams', {
        id: uuid(),
        org_id: f.org.id,
        name: 'Uploads',
        max_attachment_mb: 10,
        track_delay_default: false,
        created_at: NOW,
      })
      await ctx.db.insert('teams', {
        id: uuid(),
        org_id: f.org.id,
        name: 'Clean',
        track_delay_default: true,
        created_at: NOW,
      })
      const stored = await ctx.storage.store(new Blob(['png']) as never)
      await ctx.db.insert('issue_attachments', { ...attachment(f.sub.id), storage_id: stored })
      await ctx.db.insert('issue_attachments', { ...attachment(), storage_id: stored })
      for (const project_id of [f.sub.id, undefined]) {
        const doc = { ...attachment(project_id), storage_id: stored }
        await ctx.db.insert('deleted_rows', {
          item_id: uuid(),
          org_id: f.org.id,
          table: 'issue_attachments',
          row_id: doc.id,
          owner_id: task.id,
          created_ts: Date.parse(NOW),
          storage_id: stored,
          row: { table: 'issue_attachments', doc },
        })
      }
    })
    const rows = () =>
      t.run(async (ctx) => ({
        teams: await ctx.db.query('teams').collect(),
        attachments: await ctx.db.query('issue_attachments').collect(),
        stored: await ctx.db.query('deleted_rows').collect(),
      }))
    const check = async () => {
      const out: Record<string, number> = {}
      for (const phase of ['teams', 'attachments', 'stored_attachments'] as const)
        out[phase] = (await t.query(internal.internal.retiredFields.check, { phase })).rows
      return out
    }
    const before = await rows()
    expect(await check()).toEqual({ teams: 2, attachments: 1, stored_attachments: 1 })
    expect(await t.action(internal.internal.retiredFields.clear, { dry_run: true })).toEqual({
      dry_run: true,
      teams: 2,
      attachments: 1,
      stored_attachments: 1,
    })
    expect(await rows()).toEqual(before)

    expect(await t.action(internal.internal.retiredFields.clear, { dry_run: false })).toEqual({
      dry_run: false,
      teams: 2,
      attachments: 1,
      stored_attachments: 1,
    })
    const after = await rows()
    for (const team of after.teams) {
      expect([team.stale_days, team.archive_days, team.max_attachment_mb]).toEqual([
        undefined,
        undefined,
        undefined,
      ])
    }
    for (const row of after.attachments) expect(row).not.toHaveProperty('project_id')
    for (const { row } of after.stored) expect(row.doc).not.toHaveProperty('project_id')
    // everything else stays as it was
    expect(
      after.teams.map(({ name, track_delay_default }) => ({ name, track_delay_default })),
    ).toEqual(before.teams.map(({ name, track_delay_default }) => ({ name, track_delay_default })))
    expect(after.attachments.map(({ id, size_bytes }) => [id, size_bytes])).toEqual(
      before.attachments.map(({ id, size_bytes }) => [id, size_bytes]),
    )
    expect(after.stored.map(({ row_id }) => row_id)).toEqual(
      before.stored.map(({ row_id }) => row_id),
    )
    expect(await check()).toEqual({ teams: 0, attachments: 0, stored_attachments: 0 })
  })
})
