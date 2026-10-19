/* Every app create that takes the id of the new row from the client accepts
 * only the lowercase UUID the app generates (lib/db.ts assertNewRowId). REST
 * and MCP lowercase an id before they look it up, so a row stored under any
 * other string could not be found by id. */

import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import { ROW_ID_SHAPE } from '../lib/db'
import { as, expectRefusal, newT, plantIssue, uuid, withOrg } from './helpers.setup'

declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}

const HEX64 = 'cd'.repeat(32)

/* The admin's and user's creates, each given the id to send. */
async function fixture() {
  const t = newT()
  const f = await withOrg(t)
  const admin = as(t, f.admin)
  const user = as(t, f.user)
  const a = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
  const b = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
  const org_id = f.org.id
  let n = 0
  const creates: Record<string, (id: string) => Promise<unknown>> = {
    label: (id) =>
      admin.mutation(api.labels.create, { org_id, id, name: `L${n++}`, color: '#336699' }),
    task: (id) =>
      admin.mutation(api.issues.create, { org_id, id, project_id: f.sub.id, title: 'New task' }),
    comment: (id) =>
      admin.mutation(api.comments.create, { org_id, id, issue_id: a.id, body: 'Hi' }),
    project: (id) =>
      admin.mutation(api.projects.create, {
        org_id,
        id,
        type: 'project',
        parent_id: f.meta.id,
        key: `NP${n++}`,
        name: 'New project',
        sort_order: 9,
      }),
    milestone: (id) =>
      admin.mutation(api.projects.addMilestone, {
        org_id,
        id,
        project_id: f.meta.id,
        name: 'Beta',
        week: '2026-05-11',
      }),
    'roadmap milestone': (id) =>
      user.mutation(api.roadmap.change, {
        session_id: uuid(),
        operations: [
          {
            kind: 'milestone_create',
            id,
            project_id: f.meta.id,
            name: 'Gamma',
            week: '2026-01-05',
          },
        ],
      }),
    team: (id) => admin.mutation(api.teams.create, { org_id, id, name: `Team ${n++}` }),
    person: (id) =>
      admin.mutation(api.profiles.create, {
        org_id,
        id,
        name: `Person ${n}`,
        email: `person${n++}@testbed.test`,
        org_role: 'user',
        kind: 'person',
        color: '#445566',
      }),
    link: (id) =>
      admin.mutation(api.issues.addLink, {
        org_id,
        id,
        source_id: a.id,
        target_id: b.id,
        type: 'relates',
      }),
    attachment: async (id) => {
      const storage_id = await t.run((ctx) => ctx.storage.store(new Blob(['x']) as never))
      return admin.mutation(api.files.attach, {
        org_id,
        id,
        issue_id: a.id,
        storage_id,
        name: 'spec.pdf',
        inline: false,
      })
    },
    'agent key': (id) =>
      admin.mutation(api.tokens.createAgentKey, {
        org_id,
        id,
        agent_id: f.agent.id,
        name: 'New key',
        key_prefix: 'qva_012...00000',
        key_hash: `${n++}`.padStart(64, 'c'),
      }),
    'personal token': (id) =>
      user.mutation(api.tokens.createMcpToken, {
        id,
        profile_id: f.user.id,
        name: 'Claude',
        token_prefix: 'qvt_0123456',
        token_hash: HEX64,
        access: 'read',
      }),
  }
  return creates
}

describe('client-made ids of new rows', () => {
  it('refuses any id but a lowercase UUID on every app create, and takes one', async () => {
    const creates = await fixture()
    for (const [what, create] of Object.entries(creates)) {
      for (const bad of [uuid().toUpperCase(), 'label-1', '', ` ${uuid()}`, `${uuid()}0`]) {
        const refusal = await expectRefusal(create(bad), 'bad_request').catch((e: Error) => {
          throw new Error(`${what} with ${JSON.stringify(bad)}: ${e.message}`)
        })
        expect(refusal.data.message).toBe(ROW_ID_SHAPE)
      }
      await create(uuid())
    }
  })
})
