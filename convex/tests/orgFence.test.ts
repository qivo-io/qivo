/* orgFence.test.ts — the 0056 org-fence matrix, driven through the PUBLIC
 * doors. 0056 fixed two classes and this suite ports both:
 *
 *   A. admin-disjunct fences: an org-A admin holds NOTHING in org B. The
 *      per-door sentences are byte-asserted across the other suites; the one
 *      thing nobody asserted as an EQUALITY is 0049/0053's uniform-not-found
 *      discipline itself — "a foreign-org ref answers byte-identically to a
 *      nonexistent one" (same code AND same message). The sweep below proves
 *      it door by door with a capture comparator.
 *   B. the FK-planting variants: the writes 0056's WITH CHECKs fenced
 *      (workspace/team, assignee, links, subscriptions, labels, milestones),
 *      translated table→door.
 *   C. planted-row tolerance — 0056's "the design assumes this row cannot
 *      exist": the door fences are the ONLY wall (no RLS behind them), so the
 *      forbidden rows are planted raw and proven inert on the read path.
 *   D. guest write-probes into the hidden pair of the guest's OWN org.
 *
 * 0056 D — counters. organizations.next_issue_num / next_project_num have no
 * public surface to fence: nextIssueNum/nextProjectNum live in model/orgs and
 * no public function carries them or their arguments. That absence is
 * manifest.test.ts's row — the committed public-surface baseline is where a
 * counter-shaped door would show up, so it is deliberately NOT re-tested here.
 *
 * Speed budget: ONE fixture build per describe; the doors are independent and
 * every probe refuses (mutations roll back whole), so the shared backend
 * never drifts between rows. */

import type { WithoutSystemFields } from 'convex/server'
import { ConvexError } from 'convex/values'
import { beforeAll, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { canSeeProject, hasProjectLevel, isTeamLeader } from '../lib/access'
import type { Refusal, RefusalCode } from '../lib/functions'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

/* edge-runtime provides Blob; convex/tsconfig's ESNext-only lib does not. */
declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}

/* A team row beside withOrg's — the fixture deliberately has no otherTeam,
 * and 0056's meta-into-foreign-workspace fence needs one. Local on purpose:
 * helpers.setup.ts is shared ground. Same trust position as plantProject. */
async function plantTeam(
  t: T,
  team: { org_id: string } & Partial<WithoutSystemFields<Doc<'teams'>>>,
): Promise<Doc<'teams'>> {
  return await t.run(async (ctx) => {
    const _id = await ctx.db.insert('teams', {
      id: uuid(),
      name: 'Planted crew',
      stale_days: 14,
      archive_days: 30,
      track_delay_default: false,
      created_at: NOW,
      ...team,
    })
    return (await ctx.db.get(_id)) as Doc<'teams'>
  })
}

const plantLabel = (t: T, org_id: string, name: string): Promise<Doc<'labels'>> =>
  t.run(async (ctx) => {
    const _id = await ctx.db.insert('labels', {
      id: uuid(),
      org_id,
      name,
      name_lower: name.toLowerCase(),
      color: '#8890a0',
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'labels'>
  })

/* The no-oracle comparator: what a call ANSWERED, as data. Sentences that
 * echo the probed ref (projects.create's parent sentence) are normalized so
 * two different uuids can still answer "identically". A non-ConvexError throw
 * escapes — a dead backend must fail the test, never equal itself. */
type Captured =
  | { resolved: true; value: unknown }
  | { resolved: false; code: RefusalCode; message: string }

async function capture(promise: Promise<unknown>, ref: string): Promise<Captured> {
  try {
    return { resolved: true, value: await promise }
  } catch (e) {
    if (!(e instanceof ConvexError)) throw e
    const data = e.data as Refusal
    return { resolved: false, code: data.code, message: data.message.split(ref).join('<ref>') }
  }
}

/* issue_assignee_same_org's one sentence (0102:283-300) — the browser doors'
 * backstop. NOTE: the per-cause machine grammar (assertAssignable's
 * `user "…" is a viewer — …`, model/issues.ts) belongs to REST/MCP alone
 * (rest.test.ts:792, mcp.test.ts:1049); the browser path deliberately answers
 * ONE sentence for foreign, unknown, viewer and switched-off alike — the
 * stronger form of the no-oracle rule. */
const ASSIGNEE_SENTENCE =
  'a task can only be assigned to an active user with Edit permission or higher on its project'
/* The reviewer's twin sentence: the same predicate, the same no-oracle rule. */
const REVIEWER_SENTENCE =
  'a task can only be reviewed by an active user with Edit permission or higher on its project'

describe('0056 §A+B — every ref-taking door: a foreign ref answers byte-identically to a nonexistent one', () => {
  let t: T
  let f: OrgFixture
  let ownIssue: Doc<'issues'>
  let ownLabel: Doc<'labels'>
  let otherIssue: Doc<'issues'>
  let otherTeam: Doc<'teams'>
  let otherLabel: Doc<'labels'>
  let otherMilestoneId: string
  let otherAttachmentId: string
  let otherKeyId: string

  beforeAll(async () => {
    t = newT()
    f = await withOrg(t)
    ownIssue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    ownLabel = await plantLabel(t, f.org.id, 'Bug')
    otherIssue = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    otherTeam = await plantTeam(t, { org_id: f.otherOrg.id })
    otherLabel = await plantLabel(t, f.otherOrg.id, 'Elsewhere')
    // a milestone, an attachment (real _storage bytes) and an agent key in
    // the other org — refs the sweep can probe from outside
    otherMilestoneId = uuid()
    otherAttachmentId = uuid()
    otherKeyId = uuid()
    const otherAgent = await plantSeat(t, {
      org_id: f.otherOrg.id,
      kind: 'agent',
      name: 'Foreign relay',
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('milestones', {
        id: otherMilestoneId,
        project_id: f.otherProject.id,
        name: 'Elsewhere beta',
        week: '2026-05-11',
        created_at: NOW,
      })
      const sid = await ctx.storage.store(new Blob([new Uint8Array(8)]) as never)
      await ctx.db.insert('issue_attachments', {
        org_id: otherIssue.org_id,
        id: otherAttachmentId,
        issue_id: otherIssue.id,
        name: 'foreign.bin',
        size_bytes: 8,
        storage_id: sid,
        inline: false,
        created_at: NOW,
      })
      await ctx.db.insert('agent_keys', {
        id: otherKeyId,
        profile_id: otherAgent.id,
        name: 'foreign key',
        key_prefix: 'qva_zzzz',
        key_hash: 'f'.repeat(64),
        created_at: NOW,
      })
    })
  })

  /* One row per door: `ref()` yields the foreign-org ref, `call` drives the
   * door as f.admin (its natural caller), `answer` pins the byte sentence the
   * pair must share ('<ref>' where the sentence echoes the probe). A row
   * without `answer` resolves null on BOTH sides — the silent-no-op doors,
   * where "foreign behaves like the missing row" means resolving alike. */
  type Door = {
    name: string
    ref: () => string
    call: (ref: string) => Promise<unknown>
    answer?: { code: RefusalCode; message: string }
  }

  const DOORS: Door[] = [
    {
      name: 'issues.update',
      ref: () => otherIssue.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.issues.update, {
          org_id: f.org.id,
          id: ref,
          patch: { title: 'probe' },
        }),
      answer: { code: 'not_found', message: 'task not found' },
    },
    {
      name: 'issues.move',
      ref: () => otherIssue.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.issues.move, {
          org_id: f.org.id,
          id: ref,
          project_id: f.sub.id,
        }),
      answer: { code: 'not_found', message: 'task not found' },
    },
    {
      name: 'issues.archive',
      ref: () => otherIssue.id,
      call: (ref) => as(t, f.admin).mutation(api.issues.archive, { org_id: f.org.id, id: ref }),
      answer: { code: 'not_found', message: 'task not found' },
    },
    {
      name: 'issues.deleteDeep',
      ref: () => otherIssue.id,
      call: (ref) => as(t, f.admin).mutation(api.issues.deleteDeep, { org_id: f.org.id, id: ref }),
      answer: { code: 'not_found', message: 'task not found' },
    },
    // 0056 residual §2 (assignee_id), browser door — previously REST-only
    {
      name: 'issues.create (foreign assignee)',
      ref: () => f.otherAdmin.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.issues.create, {
          org_id: f.org.id,
          id: uuid(),
          project_id: f.sub.id,
          title: 'probe',
          assignee_id: ref,
        }),
      answer: { code: 'rule', message: ASSIGNEE_SENTENCE },
    },
    {
      name: 'issues.update (foreign assignee)',
      ref: () => f.otherAdmin.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.issues.update, {
          org_id: f.org.id,
          id: ownIssue.id,
          patch: { assignee_id: ref },
        }),
      answer: { code: 'rule', message: ASSIGNEE_SENTENCE },
    },
    {
      name: 'issues.create (foreign reviewer)',
      ref: () => f.otherAdmin.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.issues.create, {
          org_id: f.org.id,
          id: uuid(),
          project_id: f.sub.id,
          title: 'probe',
          reviewer_id: ref,
        }),
      answer: { code: 'rule', message: REVIEWER_SENTENCE },
    },
    {
      name: 'issues.update (foreign reviewer)',
      ref: () => f.otherAdmin.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.issues.update, {
          org_id: f.org.id,
          id: ownIssue.id,
          patch: { reviewer_id: ref },
        }),
      answer: { code: 'rule', message: REVIEWER_SENTENCE },
    },
    // issue_links cross-org (0078:407-421 vintage of the same class)
    {
      name: 'issues.addLink (foreign target)',
      ref: () => otherIssue.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.issues.addLink, {
          org_id: f.org.id,
          id: uuid(),
          source_id: ownIssue.id,
          target_id: ref,
          type: 'relates',
        }),
      answer: { code: 'rule', message: 'linked tasks must belong to the same organization' },
    },
    {
      name: 'issues.addLink (foreign source)',
      ref: () => otherIssue.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.issues.addLink, {
          org_id: f.org.id,
          id: uuid(),
          source_id: ref,
          target_id: ownIssue.id,
          type: 'relates',
        }),
      answer: { code: 'rule', message: 'linked tasks must belong to the same organization' },
    },
    // issue_subscriptions — the public door's fence (foreign side; the
    // hidden-same-org side lives in the residuals describe below)
    {
      name: 'issues.subscribe',
      ref: () => otherIssue.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.issues.subscribe, { org_id: f.org.id, issue_id: ref }),
      answer: { code: 'not_found', message: 'task not found' },
    },
    // projects_insert sub branch: the sentence echoes the ref — normalized
    {
      name: 'projects.create (foreign parent)',
      ref: () => f.otherProject.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.projects.create, {
          org_id: f.org.id,
          id: uuid(),
          type: 'project',
          parent_id: ref,
          key: 'PRB',
          name: 'Probe',
          sort_order: 50,
        }),
      answer: { code: 'rule', message: 'parent project <ref> not found' },
    },
    // projects_insert meta branch — 0056's workspace fence, one silent
    // refusal for team-in-another-org and team-does-not-exist alike
    // (projects.ts:147-155)
    {
      name: 'projects.create (meta into a foreign team)',
      ref: () => otherTeam.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.projects.create, {
          org_id: f.org.id,
          id: uuid(),
          type: 'meta',
          team_id: ref,
          key: 'PRB',
          name: 'Probe',
          sort_order: 50,
        }),
      answer: {
        code: 'bad_request',
        message: 'projects cannot belong to a team; use team access instead',
      },
    },
    {
      name: 'projects.update',
      ref: () => f.otherProject.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.projects.update, {
          org_id: f.org.id,
          id: ref,
          patch: { name: 'probe' },
        }),
      answer: { code: 'not_found', message: 'project not found' },
    },
    // pa_insert's WITH CHECK (0081:275-283): grantee in a foreign org ==
    // grantee that does not exist
    {
      name: 'projects.update (foreign grantee in the access map)',
      ref: () => f.otherAdmin.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.projects.update, {
          org_id: f.org.id,
          id: f.meta.id,
          patch: { access: { [ref]: 'user' } },
        }),
      answer: {
        code: 'forbidden',
        message: 'the grantee must hold a profile in this organization',
      },
    },
    {
      name: 'projects.archive',
      ref: () => f.otherProject.id,
      call: (ref) => as(t, f.admin).mutation(api.projects.archive, { org_id: f.org.id, id: ref }),
      answer: { code: 'not_found', message: 'project not found' },
    },
    {
      name: 'projects.deleteDeep',
      ref: () => f.otherProject.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: ref }),
      answer: { code: 'not_found', message: 'project not found' },
    },
    {
      name: 'projects.inviteGuest',
      ref: () => f.otherProject.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.projects.inviteGuest, {
          org_id: f.org.id,
          project_id: ref,
          email: 'probe@example.com',
          level: 'user',
        }),
      answer: { code: 'not_found', message: 'project not found' },
    },
    // milestones_select/can_write_in_workspace — the foreign-arrival row
    // projects.test.ts:545 does not cover
    {
      name: 'projects.addMilestone',
      ref: () => f.otherProject.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.projects.addMilestone, {
          org_id: f.org.id,
          id: uuid(),
          project_id: ref,
          name: 'Probe',
          week: '2026-05-11',
        }),
      answer: { code: 'not_found', message: 'project not found' },
    },
    {
      name: 'projects.removeMilestone',
      ref: () => otherMilestoneId,
      call: (ref) =>
        as(t, f.admin).mutation(api.projects.removeMilestone, { org_id: f.org.id, id: ref }),
      answer: { code: 'not_found', message: 'milestone not found' },
    },
    {
      name: 'comments.create',
      ref: () => otherIssue.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.comments.create, {
          org_id: f.org.id,
          id: uuid(),
          issue_id: ref,
          body: 'probe',
        }),
      answer: { code: 'not_found', message: 'task not found' },
    },
    // issue_labels bridging, foreign-ISSUE side (the foreign-label sentence
    // is catalog.test.ts:509's — not duplicated here beyond the equivalence)
    {
      name: 'labels.toggle (foreign issue, own label)',
      ref: () => otherIssue.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.labels.toggle, {
          org_id: f.org.id,
          issue_id: ref,
          label_id: ownLabel.id,
        }),
      answer: { code: 'not_found', message: 'task not found' },
    },
    {
      name: 'labels.toggle (own issue, foreign label)',
      ref: () => otherLabel.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.labels.toggle, {
          org_id: f.org.id,
          issue_id: ownIssue.id,
          label_id: ref,
        }),
      answer: { code: 'rule', message: 'label and task must belong to the same organization' },
    },
    {
      name: 'teams.update',
      ref: () => otherTeam.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.teams.update, {
          org_id: f.org.id,
          id: ref,
          patch: { name: 'probe' },
        }),
      answer: { code: 'not_found', message: 'team not found' },
    },
    {
      name: 'teams.deleteDeep',
      ref: () => otherTeam.id,
      call: (ref) => as(t, f.admin).mutation(api.teams.deleteDeep, { org_id: f.org.id, id: ref }),
      answer: { code: 'not_found', message: 'team not found' },
    },
    // wm_insert (0056): a foreign profile enrolled in a team
    {
      name: 'teams.addMember (foreign profile)',
      ref: () => f.otherAdmin.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.teams.addMember, {
          org_id: f.org.id,
          team_id: f.team.id,
          profile_id: ref,
        }),
      answer: { code: 'not_found', message: 'user not found' },
    },
    // wm_update: setLeader on a foreign profile is a SILENT no-op, exactly
    // like a member row that does not exist (teams.ts:225)
    {
      name: 'teams.setLeader (foreign profile)',
      ref: () => f.otherAdmin.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.teams.setLeader, {
          org_id: f.org.id,
          team_id: f.team.id,
          profile_id: ref,
          is_leader: true,
        }),
    },
    // remove_member's folded sentence (0100): no-row, foreign and non-admin
    // all read alike
    {
      name: 'profiles.remove',
      ref: () => f.otherAdmin.id,
      call: (ref) => as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: ref }),
      answer: { code: 'rule', message: 'user not found' },
    },
    {
      name: 'profiles.setPlannableHours',
      ref: () => f.otherAdmin.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.profiles.setPlannableHours, {
          org_id: f.org.id,
          profile_id: ref,
          hours: 20,
        }),
      answer: {
        code: 'rule',
        message:
          "only an organization admin or a leader of one of this person's teams can set their plannable hours",
      },
    },
    {
      name: 'files.uploadUrl',
      ref: () => otherIssue.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.files.uploadUrl, { org_id: f.org.id, issue_id: ref }),
      answer: { code: 'not_found', message: 'task not found' },
    },
    {
      name: 'files.removeAttachment',
      ref: () => otherAttachmentId,
      call: (ref) =>
        as(t, f.admin).mutation(api.files.removeAttachment, { org_id: f.org.id, id: ref }),
      answer: { code: 'not_found', message: 'attachment not found' },
    },
    {
      name: 'snapshot.commentsForIssue',
      ref: () => otherIssue.id,
      call: (ref) =>
        as(t, f.admin).query(api.snapshot.commentsForIssue, { org_id: f.org.id, issue_id: ref }),
      answer: { code: 'not_found', message: 'task not found' },
    },
    {
      name: 'tokens.revokeAgentKey',
      ref: () => otherKeyId,
      call: (ref) =>
        as(t, f.admin).mutation(api.tokens.revokeAgentKey, { org_id: f.org.id, id: ref }),
      answer: { code: 'not_found', message: 'key not found' },
    },
  ]

  for (const door of DOORS) {
    it(`${door.name}: foreign == unknown${door.answer === undefined ? ' (silent no-op)' : ''}`, async () => {
      const foreignRef = door.ref()
      const strangerRef = uuid()
      const foreign = await capture(door.call(foreignRef), foreignRef)
      const unknown = await capture(door.call(strangerRef), strangerRef)
      expect(foreign).toEqual(unknown) // the no-oracle proof
      if (door.answer === undefined) {
        expect(foreign).toEqual({ resolved: true, value: null })
      } else {
        expect(foreign).toEqual({ resolved: false, ...door.answer })
      }
    })
  }
})

describe('0056 residuals — viewer assignee, hidden endpoints, archived arrival (browser doors)', () => {
  let t: T
  let f: OrgFixture
  let subIssue: Doc<'issues'>
  let hiddenIssue: Doc<'issues'>
  let otherIssue: Doc<'issues'>
  let archivedSub: Doc<'projects'>

  beforeAll(async () => {
    t = newT()
    f = await withOrg(t)
    subIssue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    hiddenIssue = await plantIssue(t, { org_id: f.org.id, project_id: f.hidden.id })
    otherIssue = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    archivedSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: '2026-01-02T00:00:00.000Z',
    })
  })

  it('a viewer as assignee refuses through api.issues.create — the trigger sentence, verbatim', async () => {
    await expectRefusal(
      as(t, f.admin).mutation(api.issues.create, {
        org_id: f.org.id,
        id: uuid(),
        project_id: f.sub.id,
        title: 'for the viewer',
        assignee_id: f.viewer.id,
      }),
      'rule',
      /^a task can only be assigned to an active user with Edit permission or higher on its project$/,
    )
  })

  it('a viewer as assignee refuses through api.issues.update with the same sentence', async () => {
    await expectRefusal(
      as(t, f.admin).mutation(api.issues.update, {
        org_id: f.org.id,
        id: subIssue.id,
        patch: { assignee_id: f.viewer.id },
      }),
      'rule',
      /^a task can only be assigned to an active user with Edit permission or higher on its project$/,
    )
  })

  it('a viewer as reviewer refuses through api.issues.create and api.issues.update', async () => {
    const sentence =
      /^a task can only be reviewed by an active user with Edit permission or higher on its project$/
    await expectRefusal(
      as(t, f.admin).mutation(api.issues.create, {
        org_id: f.org.id,
        id: uuid(),
        project_id: f.sub.id,
        title: 'reviewed by the viewer',
        reviewer_id: f.viewer.id,
      }),
      'rule',
      sentence,
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.issues.update, {
        org_id: f.org.id,
        id: subIssue.id,
        patch: { reviewer_id: f.viewer.id },
      }),
      'rule',
      sentence,
    )
  })

  it('addLink as guest: foreign == unknown (org rule); a hidden same-org endpoint reads the write fence', async () => {
    const link = (target: string) =>
      as(t, f.guest).mutation(api.issues.addLink, {
        org_id: f.org.id,
        id: uuid(),
        source_id: subIssue.id,
        target_id: target,
        type: 'relates',
      })
    const foreign = await capture(link(otherIssue.id), otherIssue.id)
    const unknownRef = uuid()
    const unknown = await capture(link(unknownRef), unknownRef)
    expect(foreign).toEqual(unknown)
    expect(foreign).toEqual({
      resolved: false,
      code: 'rule',
      message: 'linked tasks must belong to the same organization',
    })
    // the endpoint the caller cannot SEE in their own org fails the
    // member-plus-sight check (0008:12-21) — a resolvable target reads the
    // fixed write fence, not the org sentence (issues.ts refusal posture)
    await expectRefusal(link(hiddenIssue.id), 'forbidden', /^no write access to these tasks$/)
    await expectRefusal(
      as(t, f.guest).mutation(api.issues.addLink, {
        org_id: f.org.id,
        id: uuid(),
        source_id: hiddenIssue.id,
        target_id: subIssue.id,
        type: 'relates',
      }),
      'forbidden',
      /^no write access to these tasks$/,
    )
  })

  it('subscribe as guest: foreign == unknown (not_found); the hidden issue reads the visibility fence', async () => {
    const sub = (issue_id: string) =>
      as(t, f.guest).mutation(api.issues.subscribe, { org_id: f.org.id, issue_id })
    const foreign = await capture(sub(otherIssue.id), otherIssue.id)
    const unknownRef = uuid()
    const unknown = await capture(sub(unknownRef), unknownRef)
    expect(foreign).toEqual(unknown)
    expect(foreign).toEqual({ resolved: false, code: 'not_found', message: 'task not found' })
    await expectRefusal(sub(hiddenIssue.id), 'forbidden', /^no access to this task$/)
  })

  /* Archived arrival, browser door. The machine surfaces read assertLive's
   * grammar ('… is archived — restore it in the app before adding tasks to
   * it', rest.test.ts:676/mcp.test.ts:1043); the browser door reads the DB
   * backstop's own sentence (issue_project_archived_guard, 0106:123-139). */
  it('api.issues.create into an archived project refuses with the arrival sentence', async () => {
    await expectRefusal(
      as(t, f.admin).mutation(api.issues.create, {
        org_id: f.org.id,
        id: uuid(),
        project_id: archivedSub.id,
        title: 'too late',
      }),
      'rule',
      /^that project is archived — restore it first$/,
    )
  })
})

describe("0056 §C — planted forbidden rows grant nothing ('the design assumes this row cannot exist')", () => {
  let t: T
  let f: OrgFixture

  beforeAll(async () => {
    t = newT()
    f = await withOrg(t)
  })

  it('a project_access grant onto a foreign project is inert on every read path', async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.otherProject.id,
        profile_id: f.viewer.id,
        level: 'user',
      })
    })
    await t.run(async (ctx) => {
      expect(await canSeeProject(ctx, f.viewer, f.otherProject)).toBe(false)
      expect(await hasProjectLevel(ctx, f.viewer, f.otherProject.id, 'user')).toBe(false)
    })
    const snap = await as(t, f.viewer).query(api.snapshot.forMe, {})
    expect(snap).not.toBeNull()
    expect(snap!.orgs.map((o) => o.id)).toEqual([f.org.id])
    expect(snap!.projects.map((p) => p.id)).not.toContain(f.otherProject.id)
    expect(snap!.access.map((a) => a.project_id)).not.toContain(f.otherProject.id)
    expect(snap!.profiles.map((p) => p.id)).not.toContain(f.otherAdmin.id)
  })

  it('a team_members row on a foreign team is inert — leadership, level and snapshot all say no', async () => {
    const foreignTeam = await plantTeam(t, { org_id: f.otherOrg.id })
    const foreignTeamProject = await plantProject(t, {
      org_id: f.otherOrg.id,
      team_id: foreignTeam.id,
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: foreignTeam.id,
        profile_id: f.user.id,
        is_leader: true,
      })
    })
    await t.run(async (ctx) => {
      expect(await isTeamLeader(ctx, f.user, foreignTeam.id)).toBe(false)
      expect(await canSeeProject(ctx, f.user, foreignTeamProject)).toBe(false)
      expect(await hasProjectLevel(ctx, f.user, foreignTeamProject.id, 'user')).toBe(false)
    })
    const snap = await as(t, f.user).query(api.snapshot.forMe, {})
    expect(snap).not.toBeNull()
    expect(snap!.orgs.map((o) => o.id)).toEqual([f.org.id])
    expect(snap!.teams.map((tm) => tm.id)).not.toContain(foreignTeam.id)
    expect(snap!.projects.map((p) => p.id)).not.toContain(foreignTeamProject.id)
    expect(snap!.teamMembers.map((m) => m.team_id)).not.toContain(foreignTeam.id)
  })
})

describe('0056 §D — guest write-probes into the hidden pair of their own org', () => {
  let t: T
  let f: OrgFixture
  let hiddenIssue: Doc<'issues'>

  beforeAll(async () => {
    t = newT()
    f = await withOrg(t)
    hiddenIssue = await plantIssue(t, { org_id: f.org.id, project_id: f.hidden.id })
  })

  it('visibility-fenced doors: the hidden issue answers byte-identically to a nonexistent one', async () => {
    const comment = (issue_id: string) =>
      as(t, f.guest).mutation(api.comments.create, {
        org_id: f.org.id,
        id: uuid(),
        issue_id,
        body: 'probe',
      })
    let unknownRef = uuid()
    let hidden = await capture(comment(hiddenIssue.id), hiddenIssue.id)
    let unknown = await capture(comment(unknownRef), unknownRef)
    expect(hidden).toEqual(unknown)
    expect(hidden).toEqual({ resolved: false, code: 'not_found', message: 'task not found' })

    const thread = (issue_id: string) =>
      as(t, f.guest).query(api.snapshot.commentsForIssue, { org_id: f.org.id, issue_id })
    unknownRef = uuid()
    hidden = await capture(thread(hiddenIssue.id), hiddenIssue.id)
    unknown = await capture(thread(unknownRef), unknownRef)
    expect(hidden).toEqual(unknown)
    expect(hidden).toEqual({ resolved: false, code: 'not_found', message: 'task not found' })
  })

  /* The level-fenced doors resolve the row first (org fence only), then
   * refuse on standing — the deliberate posture (issues.ts header): a
   * resolvable same-org target reads the client's fixed permission toast,
   * never a per-target sentence. */
  it('level-fenced doors: the hidden pair refuses with the fixed forbidden sentences', async () => {
    await expectRefusal(
      as(t, f.guest).mutation(api.issues.update, {
        org_id: f.org.id,
        id: hiddenIssue.id,
        patch: { title: 'probe' },
      }),
      'forbidden',
      /^no write access to this project$/,
    )
    await expectRefusal(
      as(t, f.guest).mutation(api.issues.archive, { org_id: f.org.id, id: hiddenIssue.id }),
      'forbidden',
      /^no write access to this project$/,
    )
    await expectRefusal(
      as(t, f.guest).mutation(api.files.uploadUrl, { org_id: f.org.id, issue_id: hiddenIssue.id }),
      'forbidden',
      /^no write access to this project$/,
    )
    await expectRefusal(
      as(t, f.guest).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.hidden.id,
        patch: { name: 'probe' },
      }),
      'forbidden',
      /^requires lead access to this project$/,
    )
    await expectRefusal(
      as(t, f.guest).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.hidden.id }),
      'rule',
      /^requires the project lead$/,
    )
  })
})
