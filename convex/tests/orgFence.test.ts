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
 * 0056 D — counters. The task and project counters (org_counters) have no
 * public surface to fence:
 * nextIssueNum/nextProjectNum live in model/orgs and no public function
 * carries them or their arguments. That absence is
 * manifest.test.ts's row — the committed public-surface baseline is where a
 * counter-shaped door would show up, so it is deliberately NOT re-tested here.
 *
 * Speed budget: ONE fixture build per describe; the doors are independent and
 * every probe refuses (mutations roll back whole), so the shared backend
 * never drifts between rows. */

import type { WithoutSystemFields } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
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
  settleScheduled,
  type T,
  uuid,
  withOrg,
  workspaceOf,
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

/* The no-oracle comparator: what a call ANSWERED, as data. A sentence that
 * echoes the probed ref would be normalized so two different uuids can still
 * answer "identically" (none does today). A non-ConvexError throw
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
 * `user "…" is a viewer, who …`, model/issues.ts) belongs to REST/MCP alone
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
  let otherTokenId: string
  let otherConnectionId: string
  let otherItemId: string

  beforeAll(async () => {
    t = newT()
    f = await withOrg(t)
    ownIssue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    ownLabel = await plantLabel(t, f.org.id, 'Bug')
    otherIssue = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    otherTeam = await plantTeam(t, { org_id: f.otherOrg.id })
    otherLabel = await plantLabel(t, f.otherOrg.id, 'Elsewhere')
    // a milestone, an attachment (real _storage bytes), an agent key, a
    // personal token and a connected app in the other org — refs the sweep
    // can probe from outside
    otherMilestoneId = uuid()
    otherAttachmentId = uuid()
    otherKeyId = uuid()
    otherTokenId = uuid()
    otherConnectionId = uuid()
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
      await ctx.db.insert('mcp_tokens', {
        id: otherTokenId,
        profile_id: f.otherAdmin.id,
        name: 'foreign token',
        token_prefix: 'qvt_zzzzzzz',
        token_hash: 'e'.repeat(64),
        access: 'write',
        created_at: NOW,
      })
      await ctx.db.insert('oauth_connections', {
        id: otherConnectionId,
        authorization_hash: 'foreign-authorization',
        auth_user_id: f.otherAdmin.auth_user_id ?? '',
        profile_id: f.otherAdmin.id,
        org_id: f.otherOrg.id,
        client_id: 'foreign-client',
        client_name: 'Foreign app',
        resource: 'https://qivo.test/mcp',
        requested_scopes: ['qivo:read'],
        scopes: ['qivo:read'],
        created_at: NOW,
        authorization_expires_at: NOW,
        approved_at: NOW,
      })
    })
    // a ready project item in the other org, with one stored task whose
    // title a search could find
    otherItemId = uuid()
    await t.run(async (ctx) => {
      await ctx.db.insert('deleted_items', {
        id: otherItemId,
        org_id: f.otherOrg.id,
        kind: 'project',
        target_id: f.otherProject.id,
        num: f.otherProject.num,
        name: f.otherProject.name,
        key: f.otherProject.key,
        archived: false,
        project_id: f.otherProject.id,
        path: [],
        projects: [],
        counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
        deleted_at: NOW,
        deleted_by: f.otherAdmin.id,
        state: 'ready',
        purge_after: Date.parse(NOW) + 30 * 86_400_000,
      })
      await ctx.db.insert('deleted_tasks', {
        org_id: f.otherOrg.id,
        item_id: otherItemId,
        task_id: uuid(),
        num: 7,
        title: 'Elsewhere ledger',
        project_id: f.otherProject.id,
        archived: false,
      })
    })
  })
  afterEach(() => settleScheduled(t))

  /* One row per door: `ref()` yields the foreign-org ref, `call` drives the
   * door as f.admin (its natural caller), `answer` pins the byte sentence the
   * pair must share ('<ref>' where the sentence echoes the probe). A row
   * without `answer` resolves on BOTH sides to `value` (null unless given) —
   * the silent-no-op doors and the per-item answers, where "foreign behaves
   * like the missing row" means resolving alike. */
  type Door = {
    name: string
    ref: () => string
    call: (ref: string) => Promise<unknown>
    answer?: { code: RefusalCode; message: string }
    value?: unknown
  }

  /* A resolved value with the probed ref written as '<ref>', for the doors
   * that answer per id. */
  const scrub = async (value: Promise<unknown>, ref: string): Promise<unknown> =>
    JSON.parse(
      JSON.stringify(await value)
        .split(ref)
        .join('<ref>'),
    )

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
    {
      name: 'issues.removeLink (foreign other end)',
      ref: () => otherIssue.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.issues.removeLink, {
          org_id: f.org.id,
          a: ownIssue.id,
          b: ref,
        }),
      answer: { code: 'not_found', message: 'task not found' },
    },
    {
      name: 'issues.removeLink (foreign first end)',
      ref: () => otherIssue.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.issues.removeLink, {
          org_id: f.org.id,
          a: ref,
          b: ownIssue.id,
        }),
      answer: { code: 'not_found', message: 'task not found' },
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
    // projects_insert sub branch: one sentence for foreign and unknown parents
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
      answer: { code: 'rule', message: 'parent project not found' },
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
          on: true,
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
          on: true,
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
    {
      name: 'profiles.deactivate',
      ref: () => f.otherAdmin.id,
      call: (ref) =>
        as(t, f.admin).mutation(api.profiles.deactivate, { org_id: f.org.id, id: ref }),
      answer: { code: 'not_found', message: 'user not found' },
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
      name: 'snapshot.commentThread',
      ref: () => otherIssue.id,
      call: (ref) =>
        as(t, f.admin).query(api.snapshot.commentThread, { org_id: f.org.id, issue_id: ref }),
      answer: { code: 'not_found', message: 'task not found' },
    },
    {
      name: 'snapshot.threadComments',
      ref: () => otherIssue.id,
      call: (ref) =>
        as(t, f.admin).query(api.snapshot.threadComments, { org_id: f.org.id, issue_id: ref }),
      answer: { code: 'not_found', message: 'task not found' },
    },
    {
      name: 'snapshot.threadHistory',
      ref: () => otherIssue.id,
      call: (ref) =>
        as(t, f.admin).query(api.snapshot.threadHistory, { org_id: f.org.id, issue_id: ref }),
      answer: { code: 'not_found', message: 'task not found' },
    },
    {
      name: 'snapshot.commentsBefore',
      ref: () => otherIssue.id,
      call: (ref) =>
        as(t, f.admin).query(api.snapshot.commentsBefore, {
          org_id: f.org.id,
          issue_id: ref,
          before: uuid(),
        }),
      answer: { code: 'not_found', message: 'task not found' },
    },
    {
      name: 'tokens.revokeAgentKey',
      ref: () => otherKeyId,
      call: (ref) =>
        as(t, f.admin).mutation(api.tokens.revokeAgentKey, { org_id: f.org.id, id: ref }),
      answer: { code: 'not_found', message: 'key not found' },
    },
    // API access reaches every credential kind, each fenced to the caller's org
    ...(['agent_keys', 'mcp_tokens', 'oauth_connections'] as const).map(
      (table): Door => ({
        name: `apiAccess.revoke (${table})`,
        ref: () =>
          table === 'agent_keys'
            ? otherKeyId
            : table === 'mcp_tokens'
              ? otherTokenId
              : otherConnectionId,
        call: (ref) =>
          as(t, f.admin).mutation(api.apiAccess.revoke, { org_id: f.org.id, table, id: ref }),
        answer: { code: 'not_found', message: 'credential not found' },
      }),
    ),
    // Deleted items: myItem answers a foreign item like an unknown one, and
    // the list and the search read only the caller's own seats
    {
      name: 'deletedItems.list (foreign deleter)',
      ref: () => f.otherAdmin.id,
      call: (ref) => as(t, f.admin).query(api.deletedItems.list, { deleted_by: ref }),
      value: { items: [], capped: false },
    },
    {
      name: 'deletedItems.matches (a foreign task title)',
      ref: () => 'Elsewhere ledger',
      call: (ref) => as(t, f.admin).query(api.deletedItems.matches, { text: ref }),
      value: { matches: [], capped: false },
    },
    {
      name: 'deletedItems.restore',
      ref: () => otherItemId,
      call: (ref) =>
        scrub(
          as(t, f.admin).mutation(api.deletedItems.restore, { org_id: f.org.id, ids: [ref] }),
          ref,
        ),
      value: {
        restored: [],
        stepping: [],
        refused: [{ id: '<ref>', reason: 'not_found' }],
        deferred: [],
      },
    },
    {
      name: 'deletedItems.purge',
      ref: () => otherItemId,
      call: (ref) =>
        scrub(
          as(t, f.admin).mutation(api.deletedItems.purge, { org_id: f.org.id, ids: [ref] }),
          ref,
        ),
      value: { purged: [], refused: [{ id: '<ref>', reason: 'not_found' }] },
    },
    {
      name: 'projects.removalSummary',
      ref: () => f.otherProject.id,
      call: (ref) =>
        as(t, f.admin).query(api.projects.removalSummary, { org_id: f.org.id, id: ref }),
      answer: { code: 'not_found', message: 'project not found' },
    },
  ]

  for (const door of DOORS) {
    const silent = door.answer === undefined && door.value === undefined
    it(`${door.name}: foreign == unknown${silent ? ' (silent no-op)' : ''}`, async () => {
      const foreignRef = door.ref()
      const strangerRef = uuid()
      const foreign = await capture(door.call(foreignRef), foreignRef)
      const unknown = await capture(door.call(strangerRef), strangerRef)
      expect(foreign).toEqual(unknown) // the no-oracle proof
      if (door.answer === undefined) {
        expect(foreign).toEqual({ resolved: true, value: door.value ?? null })
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
  afterEach(() => settleScheduled(t))

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

  it('addLink as guest or viewer: foreign == unknown == hidden (org rule); two visible read-only ends read the write fence', async () => {
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
    // an endpoint the caller cannot SEE in their own org is only referenced,
    // so it answers exactly like a missing one, in either position
    expect(await capture(link(hiddenIssue.id), hiddenIssue.id)).toEqual(unknown)
    const reversed = await capture(
      as(t, f.guest).mutation(api.issues.addLink, {
        org_id: f.org.id,
        id: uuid(),
        source_id: hiddenIssue.id,
        target_id: subIssue.id,
        type: 'relates',
      }),
      hiddenIssue.id,
    )
    expect(reversed).toEqual(unknown)
    // the viewer can edit neither end, so sight must be checked before the
    // write fence, or a hidden end would read "no write access" instead
    const viewerLink = (source_id: string, target_id: string) =>
      as(t, f.viewer).mutation(api.issues.addLink, {
        org_id: f.org.id,
        id: uuid(),
        source_id,
        target_id,
        type: 'relates',
      })
    expect(await capture(viewerLink(subIssue.id, unknownRef), unknownRef)).toEqual(unknown)
    expect(await capture(viewerLink(subIssue.id, hiddenIssue.id), hiddenIssue.id)).toEqual(unknown)
    expect(await capture(viewerLink(hiddenIssue.id, subIssue.id), hiddenIssue.id)).toEqual(unknown)
    // two visible ends the caller can only read keep the write fence
    const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    await expectRefusal(
      viewerLink(subIssue.id, other.id),
      'forbidden',
      /^no write access to these tasks$/,
    )
  })

  it('removeLink as guest or viewer: a hidden end answers like a missing one and its link survives; a visible pair follows the write fence', async () => {
    const plantLink = (source: Doc<'issues'>, target: Doc<'issues'>) =>
      t.run(async (ctx) => {
        const [lo, hi] = [source.id, target.id].sort()
        await ctx.db.insert('issue_links', {
          id: uuid(),
          org_id: f.org.id,
          source_id: source.id,
          target_id: target.id,
          type: 'blocks',
          pair_key: `${lo}:${hi}`,
          created_at: NOW,
        })
      })
    const linkCount = (a: Doc<'issues'>, b: Doc<'issues'>) =>
      t.run(async (ctx) => {
        const [lo, hi] = [a.id, b.id].sort()
        const rows = await ctx.db
          .query('issue_links')
          .withIndex('by_pair', (q) => q.eq('pair_key', `${lo}:${hi}`))
          .collect()
        return rows.length
      })
    const unlink = (caller: Doc<'profiles'>, a: string, b: string) =>
      as(t, caller).mutation(api.issues.removeLink, { org_id: f.org.id, a, b })

    // the guest edits subIssue's project but cannot see hiddenIssue's; the
    // link between them exists, yet removing it answers like an unknown task
    await plantLink(subIssue, hiddenIssue)
    const unknownRef = uuid()
    const unknown = await capture(unlink(f.guest, subIssue.id, unknownRef), unknownRef)
    expect(unknown).toEqual({ resolved: false, code: 'not_found', message: 'task not found' })
    expect(await capture(unlink(f.guest, subIssue.id, otherIssue.id), otherIssue.id)).toEqual(
      unknown,
    )
    expect(await capture(unlink(f.guest, subIssue.id, hiddenIssue.id), hiddenIssue.id)).toEqual(
      unknown,
    )
    expect(await capture(unlink(f.guest, hiddenIssue.id, subIssue.id), hiddenIssue.id)).toEqual(
      unknown,
    )
    // a hidden task with no link to the visible one answers the same way, so
    // the answer tells neither whether the task exists nor whether it is linked
    const unlinkedHidden = await plantIssue(t, { org_id: f.org.id, project_id: f.hidden.id })
    expect(
      await capture(unlink(f.guest, subIssue.id, unlinkedHidden.id), unlinkedHidden.id),
    ).toEqual(unknown)
    // the viewer can edit neither end, so sight must be checked before the
    // write fence, or a hidden end would read "no write access" instead
    expect(await capture(unlink(f.viewer, subIssue.id, unknownRef), unknownRef)).toEqual(unknown)
    expect(await capture(unlink(f.viewer, subIssue.id, hiddenIssue.id), hiddenIssue.id)).toEqual(
      unknown,
    )
    expect(await capture(unlink(f.viewer, hiddenIssue.id, subIssue.id), hiddenIssue.id)).toEqual(
      unknown,
    )
    expect(await linkCount(subIssue, hiddenIssue)).toBe(1)

    // someone who sees both ends can remove the same link
    await expect(unlink(f.user, hiddenIssue.id, subIssue.id)).resolves.toBeNull()
    expect(await linkCount(subIssue, hiddenIssue)).toBe(0)

    // with two visible ends, the viewer can only read them and the guest can edit
    const visible = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    await plantLink(subIssue, visible)
    await expectRefusal(
      unlink(f.viewer, subIssue.id, visible.id),
      'forbidden',
      /^no write access to these tasks$/,
    )
    expect(await linkCount(subIssue, visible)).toBe(1)
    await expect(unlink(f.guest, visible.id, subIssue.id)).resolves.toBeNull()
    expect(await linkCount(subIssue, visible)).toBe(0)
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
   * grammar ('… is archived, so restore it in the app before adding tasks
   * to it', rest.test.ts:676/mcp.test.ts:1043); the browser door reads the DB
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
      /^that project is archived, so restore it first$/,
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
  afterEach(() => settleScheduled(t))

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
    const snap = await workspaceOf(as(t, f.viewer))
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
    const snap = await workspaceOf(as(t, f.user))
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
  afterEach(() => settleScheduled(t))

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

    const threads = [
      (issue_id: string) =>
        as(t, f.guest).query(api.snapshot.commentThread, { org_id: f.org.id, issue_id }),
      (issue_id: string) =>
        as(t, f.guest).query(api.snapshot.threadComments, { org_id: f.org.id, issue_id }),
      (issue_id: string) =>
        as(t, f.guest).query(api.snapshot.threadHistory, { org_id: f.org.id, issue_id }),
      (issue_id: string) =>
        as(t, f.guest).query(api.snapshot.commentsBefore, {
          org_id: f.org.id,
          issue_id,
          before: uuid(),
        }),
    ]
    for (const thread of threads) {
      unknownRef = uuid()
      hidden = await capture(thread(hiddenIssue.id), hiddenIssue.id)
      unknown = await capture(thread(unknownRef), unknownRef)
      expect(hidden).toEqual(unknown)
      expect(hidden).toEqual({ resolved: false, code: 'not_found', message: 'task not found' })
    }
  })

  it('move: every destination the guest cannot write answers like a nonexistent one', async () => {
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      assignee_id: f.guest.id,
    })
    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const archivedSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
      archived_at: NOW,
    })
    const readOnlySub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: readOnlySub.id,
        profile_id: f.guest.id,
        level: 'viewer',
      }),
    )
    const move = (project_id: string) =>
      as(t, f.guest).mutation(api.issues.move, { org_id: f.org.id, id: task.id, project_id })
    const unknownRef = uuid()
    const unknown = await capture(move(unknownRef), unknownRef)
    expect(unknown).toEqual({
      resolved: false,
      code: 'forbidden',
      message: 'no write access to this project',
    })
    // a hidden meta, a hidden sub where the assignee is ineligible, a hidden
    // archived sub, another organization's project and a read-only sub
    for (const dest of [f.hidden, hiddenSub, archivedSub, f.otherProject, readOnlySub]) {
      expect(await capture(move(dest.id), dest.id)).toEqual(unknown)
    }
    expect((await t.run((ctx) => ctx.db.get(task._id)))?.project_id).toBe(f.sub.id)
    await move(f.sub2.id)
    expect((await t.run((ctx) => ctx.db.get(task._id)))?.project_id).toBe(f.sub2.id)
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
