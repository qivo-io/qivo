/* model/cascade.ts — the four deep deletes over the explicit FK graph.
 *
 * The heart of the suite is the table-driven zero-dangling-refs sweep
 * (tests/refs.setup.ts): after every cascade, NO surviving row anywhere may
 * reference a deleted id, edge by edge off schema.ts. The specifics ride on
 * top: the issues_touch echo (updated_at stamped on unassign/detach), the
 * detach notify, activity rows surviving with refs nulled, cross-project
 * children detached not deleted, inbox messages of a deleted issue gone from
 * every inbox, and storage bytes dying with their row. */

import { describe, expect, it } from 'vitest'
import type { Doc, Id } from '../_generated/dataModel'
import {
  deleteIssueDeep,
  deleteOrgDeep,
  deleteProjectDeep,
  deleteTeamDeep,
  removeProfile,
} from '../model/cascade'
import {
  messagesFor,
  NOW,
  newT,
  plantIssue,
  plantProject,
  plantSubscription,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { assertNoDanglingRefs, uncoveredRefFields } from './refs.setup'

/* edge-runtime provides Blob; convex/tsconfig's ESNext-only lib does not
 * declare it (same situation as helpers.setup's crypto) */
declare class Blob {
  constructor(parts: string[])
}

/* The cascade's own instant — every touch the PG issues_touch echo stamps
 * must carry exactly this string, and NOW rows must keep theirs. */
const NOW2 = '2026-02-02T03:04:05.678Z'

/* Tiny test tables: a collect+find keeps the helper generic over tables
 * (withIndex's eq() does not unify across a union of table names). */
const rowByUuid = <
  Table extends 'issues' | 'projects' | 'profiles' | 'teams' | 'labels' | 'agent_keys',
>(
  t: T,
  table: Table,
  id: string,
): Promise<Doc<Table> | null> =>
  t.run(async (ctx) => {
    const rows = (await ctx.db.query(table).collect()) as Doc<Table>[]
    return rows.find((r) => (r as unknown as { id: string }).id === id) ?? null
  })

const collect = <
  Table extends
    | 'issue_links'
    | 'issue_labels'
    | 'issue_subscriptions'
    | 'comments'
    | 'milestones'
    | 'project_access'
    | 'team_members'
    | 'user_prefs'
    | 'mcp_tokens'
    | 'oauth_connections'
    | 'oauth_credential_uses'
    | 'messages'
    | 'activity_events'
    | 'issue_attachments',
>(
  t: T,
  table: Table,
) => t.run(async (ctx) => await ctx.db.query(table).collect())

/* ---- local fixture planters (raw inserts — helpers.setup's trust position) */

const plantComment = (
  t: T,
  c: { issue_id: string; author?: string; edited_by?: string; body?: string },
): Promise<Doc<'comments'>> =>
  t.run(async (ctx) => {
    const _id = await ctx.db.insert('comments', {
      id: uuid(),
      issue_id: c.issue_id,
      author: c.author,
      edited_by: c.edited_by,
      edited_at: c.edited_by !== undefined ? NOW : undefined,
      body: c.body ?? 'planted comment',
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'comments'>
  })

const plantLink = (t: T, source_id: string, target_id: string): Promise<Doc<'issue_links'>> =>
  t.run(async (ctx) => {
    const pair_key =
      source_id < target_id ? `${source_id}:${target_id}` : `${target_id}:${source_id}`
    const source = (await ctx.db
      .query('issues')
      .withIndex('by_uuid', (q) => q.eq('id', source_id))
      .unique())!
    const _id = await ctx.db.insert('issue_links', {
      org_id: source.org_id,
      id: uuid(),
      source_id,
      target_id,
      type: 'blocks',
      pair_key,
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'issue_links'>
  })

const plantLabel = (t: T, org_id: string, name: string): Promise<Doc<'labels'>> =>
  t.run(async (ctx) => {
    const _id = await ctx.db.insert('labels', {
      id: uuid(),
      org_id,
      name,
      name_lower: name.toLowerCase(),
      color: '#6D7BF2',
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'labels'>
  })

const plantMilestone = (t: T, project_id: string, name: string): Promise<Doc<'milestones'>> =>
  t.run(async (ctx) => {
    const _id = await ctx.db.insert('milestones', {
      id: uuid(),
      project_id,
      name,
      week: '2026-02-02',
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'milestones'>
  })

const plantEvent = (
  t: T,
  e: { org_id: string; actor_id?: string; project_id?: string; team_id?: string; verb?: string },
): Promise<Doc<'activity_events'>> =>
  t.run(async (ctx) => {
    const _id = await ctx.db.insert('activity_events', {
      id: uuid(),
      org_id: e.org_id,
      ts: NOW,
      actor_id: e.actor_id,
      verb: e.verb ?? 'planted',
      target_type: 'issue',
      target_id: uuid(),
      label: 'Planted event',
      project_id: e.project_id,
      team_id: e.team_id,
    })
    return (await ctx.db.get(_id)) as Doc<'activity_events'>
  })

const plantMessageRow = (
  t: T,
  m: { org_id: string; recipient_id: string; issue_id: string; actor_id?: string },
): Promise<Doc<'messages'>> =>
  t.run(async (ctx) => {
    const _id = await ctx.db.insert('messages', {
      id: uuid(),
      org_id: m.org_id,
      recipient_id: m.recipient_id,
      actor_id: m.actor_id,
      issue_id: m.issue_id,
      issue_title: 'Planted task',
      kind: 'change',
      detail: 'planted',
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'messages'>
  })

const plantAttachment = (
  t: T,
  a: { issue_id: string; uploaded_by?: string },
): Promise<{ row: Doc<'issue_attachments'>; storage_id: Id<'_storage'> }> =>
  t.run(async (ctx) => {
    const storage_id = await ctx.storage.store(new Blob(['bytes']) as never)
    const issue = (await ctx.db
      .query('issues')
      .withIndex('by_uuid', (q) => q.eq('id', a.issue_id))
      .unique())!
    const _id = await ctx.db.insert('issue_attachments', {
      org_id: issue.org_id,
      id: uuid(),
      issue_id: a.issue_id,
      name: 'planted.txt',
      size_bytes: 5,
      mime: 'text/plain',
      storage_id,
      inline: false,
      uploaded_by: a.uploaded_by,
      created_at: NOW,
    })
    return { row: (await ctx.db.get(_id)) as Doc<'issue_attachments'>, storage_id }
  })

// existence probe via SYSTEM metadata (null after delete) — the app never
// serves via getUrl; the /files gateway is the only URL surface
const storageMeta = (t: T, id: Id<'_storage'>) => t.run(async (ctx) => await ctx.db.system.get(id))

describe('the ref sweep itself', () => {
  it('covers every ref-shaped field in schema.ts — a new FK edge cannot be forgotten', () => {
    expect(uncoveredRefFields()).toEqual([])
  })

  it('bites: a planted dangling ref fails the sweep; the untouched fixture passes it', async () => {
    const t = newT()
    const f = await withOrg(t)
    await assertNoDanglingRefs(t, 'pristine fixture')
    await plantIssue(t, { org_id: f.org.id, project_id: uuid() }) // orphan
    await expect(assertNoDanglingRefs(t, 'orphan')).rejects.toThrow(
      /issues\.project_id → projects dangles/,
    )
  })

  it('checks image and refill links while preserving external provider/storage and historical actor identities', async () => {
    const t = newT()
    const { imageRow, calendarRow, runRow, libraryRow } = await t.run(async (ctx) => {
      const imageId = uuid()
      const runId = uuid()
      const storageId = await ctx.storage.store(new Blob(['photo']) as never)
      const imageRow = await ctx.db.insert('panorama_images', {
        id: imageId,
        source_id: 'commons:12345',
        source_url: 'https://commons.wikimedia.org/wiki/File:Lake.jpg',
        download_url: 'https://upload.wikimedia.org/example/Lake.jpg',
        title: 'Lake',
        creator: 'Photographer',
        license: 'CC0',
        license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
        attribution: 'Photographer · CC0',
        source_metadata: '{}',
        storage_id: storageId,
        sha256: 'fixture-hash',
        width: 2400,
        height: 1600,
        byte_size: 5,
        status: 'approved',
        imported_at: NOW,
        reviewed_by: 'historical-better-auth-user',
      })
      const calendarRow = await ctx.db.insert('panorama_calendar', {
        day: '12-25',
        image_id: imageId,
        updated_at: NOW,
        updated_by: 'historical-better-auth-user',
      })
      const runRow = await ctx.db.insert('panorama_refills', {
        id: runId,
        trigger: 'manual',
        actor_auth_id: 'historical-better-auth-user',
        actor_email: 'former-operator@example.test',
        status: 'running',
        added: 1,
        skipped: 0,
        pages: 1,
        retries: 0,
        started_at: NOW,
      })
      const libraryRow = await ctx.db.insert('panorama_library', {
        key: 'default',
        pending: 0,
        approved: 1,
        removed: 0,
        cursor: { category: 0 },
        active_run_id: runId,
      })
      return { imageRow, calendarRow, runRow, libraryRow }
    })

    await assertNoDanglingRefs(t, 'valid platform links')
    await t.run((ctx) => ctx.db.delete(imageRow))
    await expect(assertNoDanglingRefs(t, 'missing calendar image')).rejects.toThrow(
      /panorama_calendar\.image_id → panorama_images dangles/,
    )
    await t.run((ctx) => ctx.db.delete(calendarRow))
    await assertNoDanglingRefs(t, 'calendar link cleared')
    await t.run((ctx) => ctx.db.delete(runRow))
    await expect(assertNoDanglingRefs(t, 'missing active refill')).rejects.toThrow(
      /panorama_library\.active_run_id → panorama_refills dangles/,
    )
    await t.run((ctx) => ctx.db.patch(libraryRow, { active_run_id: undefined }))
    await assertNoDanglingRefs(t, 'active run link cleared')
  })
})

describe('deleteIssueDeep', () => {
  it('destroys every edge, detaches children with touch + notify, and reaps the bytes', async () => {
    const t = newT()
    const f = await withOrg(t)
    const parent = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Doomed parent',
    })
    const childSame = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: parent.id,
    })
    // cross-project child (0057): lives in ANOTHER project, must survive detached
    const childCross = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      parent_id: parent.id,
    })
    const peerA = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const peerB = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plantLink(t, parent.id, peerA.id) // by_source edge
    await plantLink(t, peerB.id, parent.id) // by_target edge
    const label = await plantLabel(t, f.org.id, 'Doom')
    await t.run(async (ctx) => {
      await ctx.db.insert('issue_labels', {
        org_id: parent.org_id,
        issue_id: parent.id,
        label_id: label.id,
      })
    })
    await plantSubscription(t, { issue_id: parent.id, profile_id: f.admin.id })
    await plantSubscription(t, { issue_id: parent.id, profile_id: f.guest.id })
    await plantSubscription(t, { issue_id: childCross.id, profile_id: f.user.id }) // hears the detach
    await plantComment(t, { issue_id: parent.id, author: f.user.id })
    await plantComment(t, { issue_id: parent.id, author: f.admin.id, edited_by: f.user.id })
    // inbox rows about the doomed issue, in several people's inboxes
    await plantMessageRow(t, {
      org_id: f.org.id,
      recipient_id: f.viewer.id,
      issue_id: parent.id,
      actor_id: f.user.id,
    })
    await plantMessageRow(t, { org_id: f.org.id, recipient_id: f.admin.id, issue_id: parent.id })
    const att = await plantAttachment(t, { issue_id: parent.id, uploaded_by: f.user.id })
    expect(await storageMeta(t, att.storage_id)).not.toBeNull()

    await t.run(async (ctx) => {
      await deleteIssueDeep(ctx, { issue: parent, actor: f.admin, now: NOW2 })
    })

    // the row and its whole edge fan are gone
    expect(await rowByUuid(t, 'issues', parent.id)).toBeNull()
    expect(await collect(t, 'issue_links')).toEqual([])
    expect(await collect(t, 'issue_labels')).toEqual([])
    expect(await collect(t, 'comments')).toEqual([])
    expect(await collect(t, 'issue_attachments')).toEqual([])
    expect(await storageMeta(t, att.storage_id)).toBeNull() // bytes die with the row
    expect(await rowByUuid(t, 'labels', label.id)).not.toBeNull() // org-level, survives

    // messages about the issue are gone from EVERY inbox (the PG FK cascade)
    expect(await messagesFor(t, f.viewer.id, parent.id)).toEqual([])
    expect(await messagesFor(t, f.admin.id, parent.id)).toEqual([])

    // children DETACHED, never deleted — cross-project included — with the
    // issues_touch echo and the 'Detached from its parent' notify
    for (const child of [childSame, childCross]) {
      const now = await rowByUuid(t, 'issues', child.id)
      expect(now).not.toBeNull()
      expect(now!.parent_id).toBeUndefined()
      expect(now!.updated_at).toBe(NOW2)
    }
    const detachNews = await messagesFor(t, f.user.id, childCross.id)
    expect(detachNews.length).toBe(1)
    expect(detachNews[0].detail).toBe('Detached from its parent')
    expect(detachNews[0].actor_id).toBe(f.admin.id)
    expect(detachNews[0].created_at).toBe(NOW2)

    // untouched peers keep their instant; the parent's subscriptions are gone,
    // the child's survives
    expect((await rowByUuid(t, 'issues', peerA.id))!.updated_at).toBe(NOW)
    const subs = await collect(t, 'issue_subscriptions')
    expect(subs.map((s) => `${s.issue_id}:${s.profile_id}`)).toEqual([
      `${childCross.id}:${f.user.id}`,
    ])

    await assertNoDanglingRefs(t, 'after deleteIssueDeep')
  })
})

describe('deleteProjectDeep', () => {
  it('takes the subtree, detaches cross-project children, keeps history with project_id nulled', async () => {
    const t = newT()
    const f = await withOrg(t)
    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const iSub = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const iSub2 = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    // a child in a FOREIGN tree whose parent dies with the meta
    const survivor = await plantIssue(t, {
      org_id: f.org.id,
      project_id: hiddenSub.id,
      parent_id: iSub.id,
    })
    await plantSubscription(t, { issue_id: survivor.id, profile_id: f.user.id })
    await plantLink(t, iSub.id, iSub2.id)
    await plantLink(t, iSub.id, survivor.id)
    const label = await plantLabel(t, f.org.id, 'Sticky')
    await t.run(async (ctx) => {
      await ctx.db.insert('issue_labels', {
        org_id: iSub2.org_id,
        issue_id: iSub2.id,
        label_id: label.id,
      })
    })
    await plantComment(t, { issue_id: iSub.id, author: f.user.id })
    await plantMessageRow(t, { org_id: f.org.id, recipient_id: f.viewer.id, issue_id: iSub2.id })
    await plantMilestone(t, f.meta.id, 'On the meta')
    await plantMilestone(t, f.sub.id, 'On the sub')
    const eMeta = await plantEvent(t, {
      org_id: f.org.id,
      actor_id: f.admin.id,
      project_id: f.meta.id,
    })
    const eSub = await plantEvent(t, {
      org_id: f.org.id,
      actor_id: f.user.id,
      project_id: f.sub.id,
      team_id: f.team.id,
    })
    const eControl = await plantEvent(t, {
      org_id: f.org.id,
      actor_id: f.user.id,
      project_id: f.hidden.id,
    })

    await t.run(async (ctx) => {
      await deleteProjectDeep(ctx, { project: f.meta, actor: f.admin, now: NOW2 })
    })

    // the meta and BOTH subs are gone; unrelated trees stand
    for (const gone of [f.meta.id, f.sub.id, f.sub2.id]) {
      expect(await rowByUuid(t, 'projects', gone)).toBeNull()
    }
    expect(await rowByUuid(t, 'projects', f.hidden.id)).not.toBeNull()
    expect(await rowByUuid(t, 'projects', hiddenSub.id)).not.toBeNull()
    expect(await rowByUuid(t, 'projects', f.otherProject.id)).not.toBeNull()

    // issues of the subtree died through deleteIssueDeep with all their edges
    expect(await rowByUuid(t, 'issues', iSub.id)).toBeNull()
    expect(await rowByUuid(t, 'issues', iSub2.id)).toBeNull()
    expect(await collect(t, 'issue_links')).toEqual([])
    expect(await collect(t, 'issue_labels')).toEqual([])
    expect(await collect(t, 'comments')).toEqual([])
    expect(await collect(t, 'milestones')).toEqual([])
    expect(await collect(t, 'project_access')).toEqual([]) // the meta's guest+viewer grants
    expect(await messagesFor(t, f.viewer.id, iSub2.id)).toEqual([])
    expect(await rowByUuid(t, 'labels', label.id)).not.toBeNull()

    // the cross-project child was DETACHED (touch + notify), not deleted
    const kept = await rowByUuid(t, 'issues', survivor.id)
    expect(kept).not.toBeNull()
    expect(kept!.parent_id).toBeUndefined()
    expect(kept!.updated_at).toBe(NOW2)
    const news = await messagesFor(t, f.user.id, survivor.id)
    expect(news.map((m) => m.detail)).toEqual(['Detached from its parent'])

    // history survives its subjects: rows KEPT, project_id nulled on doomed
    // refs only; team_id untouched (the team is alive)
    const events = await collect(t, 'activity_events')
    const byId = new Map(events.map((e) => [e.id, e]))
    expect(byId.get(eMeta.id)?.project_id).toBeUndefined()
    expect(byId.get(eSub.id)?.project_id).toBeUndefined()
    expect(byId.get(eSub.id)?.team_id).toBe(f.team.id)
    expect(byId.get(eControl.id)?.project_id).toBe(f.hidden.id)

    await assertNoDanglingRefs(t, 'after deleteProjectDeep')
  })
})

describe('deleteTeamDeep', () => {
  it('deleting a team preserves all project work and removes only team references', async () => {
    const t = newT()
    const f = await withOrg(t)
    const iSub = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plantMilestone(t, f.meta.id, 'Project milestone')
    const label = await plantLabel(t, f.org.id, 'Everlasting')
    await plantMessageRow(t, { org_id: f.org.id, recipient_id: f.viewer.id, issue_id: iSub.id })
    const eTeam = await plantEvent(t, {
      org_id: f.org.id,
      actor_id: f.admin.id,
      team_id: f.team.id,
    })
    const eBoth = await plantEvent(t, {
      org_id: f.org.id,
      actor_id: f.user.id,
      project_id: f.sub.id,
      team_id: f.team.id,
    })
    const eControl = await plantEvent(t, {
      org_id: f.org.id,
      actor_id: f.user.id,
      project_id: f.hidden.id,
    })

    await t.run(async (ctx) => {
      await deleteTeamDeep(ctx, { team: f.team, actor: f.admin, now: NOW2 })
    })

    expect(await rowByUuid(t, 'teams', f.team.id)).toBeNull()
    for (const kept of [f.meta.id, f.sub.id, f.sub2.id]) {
      expect(await rowByUuid(t, 'projects', kept)).not.toBeNull()
    }
    // Teams are permission groups; every project survives.
    expect(await rowByUuid(t, 'projects', f.hidden.id)).not.toBeNull()
    expect(await rowByUuid(t, 'projects', f.otherProject.id)).not.toBeNull()
    expect(await rowByUuid(t, 'issues', iSub.id)).not.toBeNull()
    expect(await collect(t, 'milestones')).toHaveLength(1)
    expect(await collect(t, 'team_members')).toEqual([]) // user + admin memberships
    expect(await messagesFor(t, f.viewer.id, iSub.id)).toHaveLength(1)
    expect(await rowByUuid(t, 'labels', label.id)).not.toBeNull() // org-level, survives

    const events = await collect(t, 'activity_events')
    const byId = new Map(events.map((e) => [e.id, e]))
    expect(byId.get(eTeam.id)).toBeDefined() // rows KEPT
    expect(byId.get(eTeam.id)?.team_id).toBeUndefined()
    expect(byId.get(eBoth.id)?.team_id).toBeUndefined()
    expect(byId.get(eBoth.id)?.project_id).toBe(f.sub.id)
    expect(byId.get(eControl.id)?.project_id).toBe(f.hidden.id)

    await assertNoDanglingRefs(t, 'after deleteTeamDeep')
  })
})

describe('deleteOrgDeep', () => {
  it('empties every org-scoped table and reaps every byte; the other organization stands untouched', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const other = await plantIssue(t, { org_id: f.org.id, project_id: f.hidden.id })
    await plantLink(t, issue.id, other.id)
    const label = await plantLabel(t, f.org.id, 'Doomed')
    await plantMilestone(t, f.meta.id, 'Project milestone')
    await plantComment(t, { issue_id: issue.id, author: f.user.id })
    await plantSubscription(t, { issue_id: issue.id, profile_id: f.viewer.id })
    await plantMessageRow(t, { org_id: f.org.id, recipient_id: f.viewer.id, issue_id: issue.id })
    await plantEvent(t, { org_id: f.org.id, actor_id: f.admin.id, project_id: f.sub.id })
    const { storage_id: attachmentBytes } = await plantAttachment(t, { issue_id: issue.id })
    const avatarBytes = await t.run(async (ctx) => {
      const storage_id = await ctx.storage.store(new Blob(['avatar']) as never)
      await ctx.db.patch(f.user._id, { avatar_storage_id: storage_id })
      await ctx.db.insert('issue_labels', {
        org_id: issue.org_id,
        issue_id: issue.id,
        label_id: label.id,
      })
      await ctx.db.insert('user_prefs', { profile_id: f.user.id, prefs: {}, updated_at: NOW })
      await ctx.db.insert('mcp_tokens', {
        id: uuid(),
        profile_id: f.user.id,
        name: 'planted',
        token_prefix: 'qvt_pla',
        token_hash: 'a'.repeat(64),
        created_at: NOW,
      })
      await ctx.db.insert('agent_keys', {
        id: uuid(),
        profile_id: f.agent.id,
        name: 'planted',
        key_prefix: 'qva_pla',
        key_hash: 'b'.repeat(64),
        created_by: f.admin.id,
        created_at: NOW,
      })
      await ctx.db.insert('marketing_demo', {
        key: 'planted',
        org_id: f.org.id,
        auth_ids: {},
        credential_set_id: uuid(),
        state: 'ready',
        version: 1,
        created_at: NOW,
        updated_at: NOW,
      })
      return storage_id
    })
    // the control: the other organization's own rows
    const foreignIssue = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
    })
    const foreignLabel = await plantLabel(t, f.otherOrg.id, 'Elsewhere')

    await t.run(async (ctx) => {
      const org = (await ctx.db.get(f.org._id)) as Doc<'organizations'>
      await deleteOrgDeep(ctx, org)
    })

    expect(await t.run(async (ctx) => await ctx.db.get(f.org._id))).toBeNull()
    for (const table of [
      'issues',
      'projects',
      'teams',
      'profiles',
      'labels',
      'activity_events',
    ] as const) {
      const rows = await t.run(async (ctx) => await ctx.db.query(table).collect())
      expect(
        rows.some((r) => r.org_id === f.org.id),
        table,
      ).toBe(false)
    }
    for (const table of [
      'issue_links',
      'issue_labels',
      'issue_subscriptions',
      'comments',
      'milestones',
      'project_access',
      'team_members',
      'user_prefs',
      'mcp_tokens',
      'messages',
      'issue_attachments',
    ] as const) {
      expect(await collect(t, table), table).toEqual([])
    }
    expect(await t.run(async (ctx) => await ctx.db.query('agent_keys').collect())).toEqual([])
    expect(await t.run(async (ctx) => await ctx.db.query('marketing_demo').collect())).toEqual([])
    expect(await storageMeta(t, attachmentBytes)).toBeNull()
    expect(await storageMeta(t, avatarBytes)).toBeNull()
    // untouched: the foreign organization, its people, project, task and label
    expect(await t.run(async (ctx) => await ctx.db.get(f.otherOrg._id))).not.toBeNull()
    expect(await rowByUuid(t, 'profiles', f.otherAdmin.id)).not.toBeNull()
    expect(await rowByUuid(t, 'projects', f.otherProject.id)).not.toBeNull()
    expect(await rowByUuid(t, 'issues', foreignIssue.id)).not.toBeNull()
    expect(await rowByUuid(t, 'labels', foreignLabel.id)).not.toBeNull()

    await assertNoDanglingRefs(t, 'after deleteOrgDeep')
  })
})

describe('removeProfile', () => {
  it('SET NULLs touch issues and nothing else; deletes the whole inbox; reaps the avatar', async () => {
    const t = newT()
    const f = await withOrg(t)
    // SET NULL + touch: assignee/reporter on one issue, creator of another
    const assigned = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      assignee_id: f.user.id,
      created_by: f.admin.id,
      reporter_id: f.user.id,
    })
    const created = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      created_by: f.user.id,
      assignee_id: f.admin.id,
      reporter_id: f.admin.id,
    })
    await plantSubscription(t, { issue_id: assigned.id, profile_id: f.admin.id }) // must hear NOTHING
    // the reviewer ref: one task reviewed by the doomed profile, one by admin
    const reviewed = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'review',
      reviewer_id: f.user.id,
    })
    const reviewedByAdmin = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'review',
      reviewer_id: f.admin.id,
    })
    await plantSubscription(t, { issue_id: reviewed.id, profile_id: f.admin.id }) // must hear NOTHING
    // SET NULL, no touch — fixture already has hidden.lead_id = user
    const eActed = await plantEvent(t, {
      org_id: f.org.id,
      actor_id: f.user.id,
      project_id: f.hidden.id,
    })
    const cAuthored = await plantComment(t, { issue_id: assigned.id, author: f.user.id })
    const cEdited = await plantComment(t, {
      issue_id: assigned.id,
      author: f.admin.id,
      edited_by: f.user.id,
    })
    const mSent = await plantMessageRow(t, {
      org_id: f.org.id,
      recipient_id: f.admin.id,
      issue_id: assigned.id,
      actor_id: f.user.id,
    })
    await plantMessageRow(t, {
      org_id: f.org.id,
      recipient_id: f.user.id,
      issue_id: assigned.id,
      actor_id: f.admin.id,
    })
    await plantMessageRow(t, {
      org_id: f.org.id,
      recipient_id: f.user.id,
      issue_id: created.id,
      actor_id: f.user.id,
    })
    const keyRow = await t.run(async (ctx) => {
      const _id = await ctx.db.insert('agent_keys', {
        id: uuid(),
        profile_id: f.agent.id,
        name: 'Made by user',
        key_prefix: 'qva_0000000',
        key_hash: 'ab'.repeat(32),
        created_by: f.user.id,
        created_at: NOW,
      })
      return (await ctx.db.get(_id)) as Doc<'agent_keys'>
    })
    const att = await plantAttachment(t, { issue_id: created.id, uploaded_by: f.user.id })
    // DELETE edges: grant, subscription, prefs, token (+ admin's as survivors)
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.hidden.id,
        profile_id: f.user.id,
        level: 'user',
      })
      await ctx.db.insert('issue_subscriptions', {
        issue_id: created.id,
        profile_id: f.user.id,
        created_at: NOW,
      })
      await ctx.db.insert('user_prefs', {
        profile_id: f.user.id,
        prefs: { hello: 1 },
        updated_at: NOW,
      })
      await ctx.db.insert('user_prefs', {
        profile_id: f.admin.id,
        prefs: { keep: 1 },
        updated_at: NOW,
      })
      await ctx.db.insert('mcp_tokens', {
        id: uuid(),
        profile_id: f.user.id,
        name: 'Mine',
        token_prefix: 'qvt_0000000',
        token_hash: 'cd'.repeat(32),
        created_at: NOW,
      })
      await ctx.db.insert('mcp_tokens', {
        id: uuid(),
        profile_id: f.admin.id,
        name: 'Kept',
        token_prefix: 'qvt_1111111',
        token_hash: 'ef'.repeat(32),
        created_at: NOW,
      })
      for (const profile of [f.user, f.admin]) {
        const connectionId = uuid()
        await ctx.db.insert('oauth_connections', {
          id: connectionId,
          authorization_hash: uuid(),
          auth_user_id: profile.auth_user_id!,
          profile_id: profile.id,
          org_id: profile.org_id,
          client_id: 'cascade-client',
          client_name: 'Cascade test',
          resource: 'https://some.convex.site/mcp',
          requested_scopes: ['qivo:read'],
          scopes: ['qivo:read'],
          created_at: NOW,
          authorization_expires_at: NOW,
          approved_at: NOW,
        })
        await ctx.db.insert('oauth_credential_uses', {
          connection_id: connectionId,
          credential_hash: uuid(),
          kind: 'authorization_code',
          used_at: NOW,
        })
      }
    })
    // avatar bytes are removeProfile's from phase 5 on
    const avatarId = await t.run(async (ctx) => {
      const sid = await ctx.storage.store(new Blob(['face']) as never)
      const row = (await ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', f.user.id))
        .unique())!
      await ctx.db.patch(row._id, { avatar_storage_id: sid })
      return sid
    })

    const doomed = (await rowByUuid(t, 'profiles', f.user.id))! // re-read: carries the avatar id
    await t.run(async (ctx) => {
      await removeProfile(ctx, { profile: doomed, now: NOW2 })
    })

    expect(await rowByUuid(t, 'profiles', f.user.id)).toBeNull()

    // issues: refs nulled WITH the issues_touch echo; the other side kept
    const a = (await rowByUuid(t, 'issues', assigned.id))!
    expect(a.assignee_id).toBeUndefined()
    expect(a.created_by).toBe(f.admin.id)
    expect(a.reporter_id).toBeUndefined()
    expect(a.updated_at).toBe(NOW2)
    const c = (await rowByUuid(t, 'issues', created.id))!
    expect(c.created_by).toBeUndefined()
    expect(c.assignee_id).toBe(f.admin.id)
    expect(c.reporter_id).toBe(f.admin.id)
    expect(c.updated_at).toBe(NOW2)
    const r = (await rowByUuid(t, 'issues', reviewed.id))!
    expect(r.reviewer_id).toBeUndefined()
    expect(r.updated_at).toBe(NOW2)
    expect(await rowByUuid(t, 'issues', reviewedByAdmin.id)).toEqual(reviewedByAdmin)
    expect(await messagesFor(t, f.admin.id, reviewed.id)).toEqual([])
    // …and the unassignment sent NO message: the subscriber's inbox holds
    // exactly the planted row, its actor nulled (the FK UPDATE's notify is
    // deliberately not reproduced — only the touch is retained)
    const adminInbox = await messagesFor(t, f.admin.id, assigned.id)
    expect(adminInbox.length).toBe(1)
    expect(adminInbox[0].id).toBe(mSent.id)
    expect(adminInbox[0].actor_id).toBeUndefined()

    // SET NULL, no touch
    expect((await rowByUuid(t, 'projects', f.hidden.id))!.lead_id).toBeUndefined()
    const events = await collect(t, 'activity_events')
    expect(events.find((e) => e.id === eActed.id)?.actor_id).toBeUndefined()
    const comments = await collect(t, 'comments')
    expect(comments.find((x) => x.id === cAuthored.id)?.author).toBeUndefined()
    expect(comments.find((x) => x.id === cEdited.id)?.edited_by).toBeUndefined()
    expect(comments.find((x) => x.id === cEdited.id)?.author).toBe(f.admin.id)
    expect((await rowByUuid(t, 'agent_keys', keyRow.id))!.created_by).toBeUndefined()
    const atts = await collect(t, 'issue_attachments')
    expect(atts.find((x) => x.id === att.row.id)?.uploaded_by).toBeUndefined()
    expect(await storageMeta(t, att.storage_id)).not.toBeNull() // attachment bytes die with their ISSUE, never a profile

    // DELETE edges: the person's whole footprint, nobody else's
    expect(await messagesFor(t, f.user.id)).toEqual([]) // the entire inbox
    const memberships = await collect(t, 'team_members')
    expect(memberships.some((m) => m.profile_id === f.user.id)).toBe(false)
    expect(memberships.some((m) => m.profile_id === f.admin.id)).toBe(true)
    const grants = await collect(t, 'project_access')
    expect(grants.some((g) => g.profile_id === f.user.id)).toBe(false)
    expect(grants.some((g) => g.profile_id === f.viewer.id)).toBe(true)
    const subs = await collect(t, 'issue_subscriptions')
    expect(subs.some((s) => s.profile_id === f.user.id)).toBe(false)
    expect(subs.some((s) => s.profile_id === f.admin.id)).toBe(true)
    const prefs = await collect(t, 'user_prefs')
    expect(prefs.map((p) => p.profile_id)).toEqual([f.admin.id])
    const tokens = await collect(t, 'mcp_tokens')
    expect(tokens.map((p) => p.profile_id)).toEqual([f.admin.id])
    const connections = await collect(t, 'oauth_connections')
    expect(connections.map((connection) => connection.profile_id)).toEqual([f.admin.id])
    const uses = await collect(t, 'oauth_credential_uses')
    expect(uses.map((use) => use.connection_id)).toEqual([connections[0].id])
    expect(await storageMeta(t, avatarId)).toBeNull() // avatar bytes reaped

    await assertNoDanglingRefs(t, 'after removeProfile')
  })

  it('removing an AGENT deletes its keys outright (by_profile), not just the created_by ref', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('agent_keys', {
        id: uuid(),
        profile_id: f.agent.id,
        name: 'Dies with the agent',
        key_prefix: 'qva_1111111',
        key_hash: '12'.repeat(32),
        created_by: f.admin.id,
        created_at: NOW,
      })
    })
    await t.run(async (ctx) => {
      await removeProfile(ctx, { profile: f.agent, now: NOW2 })
    })
    expect(await rowByUuid(t, 'profiles', f.agent.id)).toBeNull()
    expect(await t.run(async (ctx) => await ctx.db.query('agent_keys').collect())).toEqual([])
    await assertNoDanglingRefs(t, 'after agent removeProfile')
  })
})
