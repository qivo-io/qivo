/* The row bounds lib/limits.ts states for projects and teams
 * (PROJECT_ROW_MAX_BYTES, TEAM_ROW_MAX_BYTES), at which read budgets count
 * a project, a team and the rows a project read brings along. Each case
 * builds the largest row the writers accept through their own helpers,
 * with every field the schema has set, stores it so the schema checks it,
 * and measures it as Convex counts a document. A field added to one of
 * these tables fails its case until the case sets it and the bound is
 * checked again. */

import type { WithoutSystemFields } from 'convex/server'
import { getDocumentSize } from 'convex/values'
import { describe, expect, it } from 'vitest'
import type { Doc, TableNames } from '../_generated/dataModel'
import { newWindowKey } from '../lib/db'
import { LIMITS, NAME_MAX, PROJECT_ROW_MAX_BYTES, TEAM_ROW_MAX_BYTES } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { assertNameShape } from '../model/people'
import { cleanProjectName, projectDescription } from '../model/projects'
import { cleanTeamName } from '../model/teams'
import schema from '../schema'
import { NOW, newT, uuid } from './helpers.setup'

/* The character whose name and name key together take the most UTF-8
 * bytes for each UTF-16 unit it counts against NAME_MAX: three for itself
 * and 33 for its key, which NFKD expands to 18 characters. */
const WIDEST = 'ﷺ'
/* A character of a three-byte script, the most a description's characters
 * take. */
const THREE_BYTES = '一'

/* What `text` stores as a name: itself and its name key, in UTF-8 bytes. */
const stored = (text: string) =>
  new TextEncoder().encode(text).length + new TextEncoder().encode(nameKey(text)).length

/** `row` as `table` stores it, after the schema checked it, with its
 * size as Convex counts it. */
async function measured<T extends TableNames>(table: T, row: WithoutSystemFields<Doc<T>>) {
  const t = newT()
  const doc = await t.run(async (ctx) => ctx.db.get(await ctx.db.insert(table, row)))
  if (doc === null) throw new Error(`the ${table} row was not stored`)
  return getDocumentSize(doc)
}

/* The fields `table`'s validator declares, optional ones included. */
const fieldsOf = (table: TableNames) => Object.keys(schema.tables[table].validator.fields).sort()

const NAME = WIDEST.repeat(NAME_MAX)

describe('the widest name', () => {
  it('stores no fewer bytes than any other character, for each unit it counts', () => {
    const per = (ch: string) => stored(ch) / ch.length
    let widest = 0
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue
      widest = Math.max(widest, per(String.fromCodePoint(code)))
    }
    expect(per(WIDEST)).toBe(36)
    expect(widest).toBe(per(WIDEST))
  })
})

describe('a project row', () => {
  const name = cleanProjectName(NAME)
  const row: WithoutSystemFields<Doc<'projects'>> = {
    id: uuid(),
    org_id: uuid(),
    team_id: uuid(),
    type: 'project',
    parent_id: uuid(),
    key: 'ABCDE',
    name,
    lead_id: uuid(),
    description: projectDescription(THREE_BYTES.repeat(LIMITS.projectDescription.max)),
    sort_order: Number.MAX_SAFE_INTEGER,
    num: Number.MAX_SAFE_INTEGER,
    track_delay: true,
    review_hours: LIMITS.reviewHours.max,
    archived_at: NOW,
    created_at: NOW,
    window_key: newWindowKey(),
    name_key: nameKey(name),
    archive_state: 'under',
  }

  it('sets every field the schema has', () => {
    expect(Object.keys(row).sort()).toEqual(fieldsOf('projects'))
  })

  it('stays within PROJECT_ROW_MAX_BYTES at the name and description caps', async () => {
    const size = await measured('projects', row)
    console.log(`a project row at the caps: ${size} bytes`)
    expect(size).toBeLessThanOrEqual(PROJECT_ROW_MAX_BYTES)
  })

  it('refuses one more character of name or description', () => {
    expect(() => cleanProjectName(`${NAME}a`)).toThrow(LIMITS.projectName.refusal)
    expect(() => projectDescription(THREE_BYTES.repeat(LIMITS.projectDescription.max + 1))).toThrow(
      LIMITS.projectDescription.refusal,
    )
  })
})

describe('a team row', () => {
  const name = cleanTeamName(NAME)
  const row: WithoutSystemFields<Doc<'teams'>> = {
    id: uuid(),
    org_id: uuid(),
    name,
    track_delay_default: true,
    created_at: NOW,
    name_key: nameKey(name),
  }

  it('sets every field the schema has', () => {
    expect(Object.keys(row).sort()).toEqual(fieldsOf('teams'))
  })

  it('stays within TEAM_ROW_MAX_BYTES at the name cap', async () => {
    const size = await measured('teams', row)
    console.log(`a team row at the cap: ${size} bytes`)
    expect(size).toBeLessThanOrEqual(TEAM_ROW_MAX_BYTES)
  })

  it('refuses one more character of name', () => {
    expect(() => cleanTeamName(`${NAME}a`)).toThrow(LIMITS.teamName.refusal)
  })
})

describe('the rows a project read brings along', () => {
  // a person's name at its cap, which grants and memberships copy the key of
  assertNameShape(NAME)
  const key = nameKey(NAME)
  const rows = {
    project_access: {
      project_id: uuid(),
      profile_id: uuid(),
      level: 'viewer',
      name_key: key,
    } satisfies WithoutSystemFields<Doc<'project_access'>>,
    project_team_access: {
      project_id: uuid(),
      team_id: uuid(),
      level: 'viewer',
      name_key: key,
    } satisfies WithoutSystemFields<Doc<'project_team_access'>>,
    team_members: {
      team_id: uuid(),
      profile_id: uuid(),
      is_leader: true,
      name_key: key,
    } satisfies WithoutSystemFields<Doc<'team_members'>>,
    project_reach: {
      org_id: uuid(),
      grantee_kind: 'profile',
      grantee_id: uuid(),
      kind: 'child',
      project_id: uuid(),
      root_id: uuid(),
      name_key: key,
      key: 'ABCDE',
      live: true,
      on_root: true,
    } satisfies WithoutSystemFields<Doc<'project_reach'>>,
  }

  it.each(Object.keys(rows) as (keyof typeof rows)[])(
    '%s sets every field the schema has and stays within TEAM_ROW_MAX_BYTES',
    async (table) => {
      expect(Object.keys(rows[table]).sort()).toEqual(fieldsOf(table))
      const size = await measured(table, rows[table])
      console.log(`a ${table} row at the name cap: ${size} bytes`)
      expect(size).toBeLessThanOrEqual(TEAM_ROW_MAX_BYTES)
    },
  )
})
