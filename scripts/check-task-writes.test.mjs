import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

let repository = ''
afterEach(() => fs.rmSync(repository, { recursive: true, force: true }))

/**
 * Writes a repository with the real convex/ config, the installed convex and
 * typescript, the repository's scripts and these files in convex/, and runs
 * scripts/check-task-writes.mjs there.
 */
function check(files) {
  repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'Qivo-Task-Writes-')))
  const contents = {
    'convex/tsconfig.json': fs.readFileSync(path.join(root, 'convex/tsconfig.json'), 'utf8'),
    ...Object.fromEntries(
      Object.entries(files).map(([file, source]) => [`convex/${file}`, source]),
    ),
  }
  for (const [file, source] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(path.join(repository, file)), { recursive: true })
    fs.writeFileSync(path.join(repository, file), source)
  }
  fs.mkdirSync(path.join(repository, 'node_modules'), { recursive: true })
  for (const link of ['scripts', 'node_modules/typescript', 'node_modules/convex'])
    fs.symlinkSync(path.join(root, link), path.join(repository, link))
  const result = spawnSync(process.execPath, ['scripts/check-task-writes.mjs'], {
    cwd: repository,
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (result.error) throw result.error
  return { status: result.status, output: result.stdout + result.stderr }
}

/* A schema with tasks, their descriptions, projects, the ids both held and
 * a table without them that has fields of the same names. */
const schema = `import { defineSchema, defineTable, type DataModelFromSchemaDefinition, type GenericMutationCtx } from 'convex/server'
import type { GenericId } from 'convex/values'
import { v } from 'convex/values'
const schema = defineSchema({
  issues: defineTable({ id: v.string(), org_id: v.string(), project_id: v.string(), title: v.string(), description: v.optional(v.string()), archived_at: v.optional(v.string()) }),
  issue_descriptions: defineTable({ issue_id: v.string(), org_id: v.string(), description: v.string(), project_id: v.optional(v.string()), archived_at: v.optional(v.string()) }),
  projects: defineTable({ id: v.string(), org_id: v.string(), name: v.string() }),
  used_ids: defineTable({ table: v.string(), row_id: v.string(), org_id: v.string() }),
  comments: defineTable({ body: v.string(), description: v.optional(v.string()), project_id: v.optional(v.string()), archived_at: v.optional(v.string()) }),
})
export default schema
export type DataModel = DataModelFromSchemaDefinition<typeof schema>
export type Tables = keyof DataModel & string
export type Ctx = GenericMutationCtx<DataModel>
export type Id<T extends Tables> = GenericId<T>
`

const imports = `import type { WithoutSystemFields } from 'convex/server'
import type { Ctx, DataModel, Id, Tables } from './schema'
import { insertUnique, insertUnique as putRow, insertUsed } from './lib/db'
type Task = WithoutSystemFields<DataModel['issues']['document']>
type Project = WithoutSystemFields<DataModel['projects']['document']>
`

/* The generic writers the check allows, whose callers it reads, each with
 * the used_ids row of a task's or project's id, and one beside them that it
 * does not allow. */
const db = `import type { WithoutSystemFields } from 'convex/server'
import type { Ctx, DataModel, Tables } from '../schema'
const used = (db: Ctx['db'], table: string) => db.insert('used_ids', { table, row_id: 'a', org_id: 'b' })
export const insertUnique = async <T extends Tables>(ctx: Ctx, table: T, doc: WithoutSystemFields<DataModel[T]['document']>) => {
  await used(ctx.db, table)
  return ctx.db.insert(table, doc)
}
export async function insertUsed<T extends Tables>(db: Ctx['db'], table: T, doc: WithoutSystemFields<DataModel[T]['document']>) {
  await used(db, table)
  return db.insert(table, doc)
}
export const insertAny = <T extends Tables>(ctx: Ctx, table: T, doc: WithoutSystemFields<DataModel[T]['document']>) =>
  ctx.db.insert(table, doc)
export const rawTask = (ctx: Ctx, doc: WithoutSystemFields<DataModel['issues']['document']>) =>
  ctx.db.insert('issues', doc)
`

const owner = `${imports.replaceAll("'./", "'../")}
export const insertTask = async (ctx: Ctx, doc: Task) => {
  await insertUnique(ctx, 'issues', doc)
  await ctx.db.insert('issue_descriptions', { issue_id: doc.id, org_id: doc.org_id, description: doc.description ?? '' })
}
export const patchTask = (ctx: Ctx, id: Id<'issues'>, fields: Partial<Task>) => ctx.db.patch(id, fields)
`

const good = `${imports}
export const title = (ctx: Ctx, id: Id<'issues'>) => ctx.db.patch(id, { title: 'Plan' })
export const fields = (ctx: Ctx, id: Id<'issues'>, w: Omit<Partial<Task>, 'description' | 'project_id' | 'archived_at'>) => ctx.db.patch('issues', id, w)
export const comment = (ctx: Ctx) => ctx.db.insert('comments', { body: 'Hi', description: 'not a task' })
export const edit = (ctx: Ctx, id: Id<'comments'>) => ctx.db.patch(id, { description: 'not a task' })
export const shelve = (ctx: Ctx, id: Id<'comments'>) => ctx.db.patch(id, { project_id: 'p', archived_at: 'now' })
export const unique = (ctx: Ctx) => insertUnique(ctx, 'comments', { body: 'Hi' })
export const gone = (ctx: Ctx, id: Id<'issues'>) => ctx.db.delete(id)
export const text = 'a.b'.replace('.', '')
export const tidy = (ctx: Ctx, id: Id<'comments'>) => {
  const { patch } = ctx.db
  return patch(id, { body: 'Tidy', description: 'not a task' })
}
export const uniqueComment = (ctx: Ctx) => putRow(ctx, 'comments', { body: 'Hi' })
export const aliasComment = (ctx: Ctx) => {
  const write = insertUnique
  const writeAgain = write
  return writeAgain(ctx, 'comments', { body: 'Hi' })
}
export const project = (ctx: Ctx, doc: Project) => insertUsed(ctx.db, 'projects', doc)
export const chosen = (ctx: Ctx, doc: Project) => insertUnique(ctx, 'projects', doc)
export const rename = (ctx: Ctx, id: Id<'projects'>) => ctx.db.patch(id, { name: 'Plan' })
`

/* Each write the check refuses, one a line, with the start of its sentence
 * and, where the call does not follow the arrow, the text it starts with. */
const refused = [
  [
    "export const insert = (ctx: Ctx, doc: Task) => ctx.db.insert('issues', doc)",
    'this inserts a task row',
  ],
  [
    "export const replace = (ctx: Ctx, id: Id<'issues'>, doc: Task) => ctx.db.replace(id, doc)",
    'this replaces a task row',
  ],
  [
    "export const describe = (ctx: Ctx, id: Id<'issues'>) => ctx.db.patch(id, { description: 'x' })",
    "this patch can change a task's description",
  ],
  [
    "export const named = (ctx: Ctx, id: Id<'issues'>) => ctx.db.patch('issues', id, { description: 'x' })",
    "this patch can change a task's description",
  ],
  [
    "export const either = (ctx: Ctx, id: Id<'issues'> | Id<'comments'>, f: Record<string, string>) => ctx.db.patch(id, f)",
    "this patch can change a task's description",
  ],
  [
    "export const move = (ctx: Ctx, id: Id<'issues'>) => ctx.db.patch(id, { project_id: 'p' })",
    "this patch can change a task's description, project or archived state",
  ],
  [
    "export const archive = (ctx: Ctx, id: Id<'issues'>) => ctx.db.patch('issues', id, { archived_at: 'now', title: 'Done' })",
    "this patch can change a task's description, project or archived state",
  ],
  [
    "export const restore = (ctx: Ctx, id: Id<'issues'>) => ctx.db.patch(id, { archived_at: undefined })",
    "this patch can change a task's description, project or archived state",
  ],
  [
    "export const keepsText = (ctx: Ctx, id: Id<'issues'>, w: Omit<Partial<Task>, 'description'>) => ctx.db.patch('issues', id, w)",
    "this patch can change a task's description, project or archived state",
  ],
  [
    "export const row = (ctx: Ctx) => ctx.db.insert('issue_descriptions', { issue_id: 'a', org_id: 'b', description: '' })",
    'this writes issue_descriptions',
  ],
  [
    "export const viaUnique = (ctx: Ctx, doc: Task) => insertUnique(ctx, 'issues', doc)",
    'this inserts a task row',
  ],
  [
    "export const put = <T extends Tables>(ctx: Ctx, t: T, doc: WithoutSystemFields<DataModel[T]['document']>) => ctx.db.insert(t, doc)",
    'this writes a table that the check cannot read',
  ],
  [
    "export const aliased = (ctx: Ctx, doc: Task) => putRow(ctx, 'issues', doc)",
    'this inserts a task row',
  ],
  [
    "export const indexed = (ctx: Ctx, id: Id<'issues'>) => ctx.db['patch'](id, { description: 'x' })",
    "this patch can change a task's description",
  ],
  [
    "export const destructured = (ctx: Ctx, doc: Task) => { const { insert } = ctx.db; return insert('issues', doc) }",
    'this inserts a task row',
    "insert('issues'",
  ],
  [
    "export const renamed = (ctx: Ctx, id: Id<'issues'>) => { const { patch: p } = ctx.db; return p(id, { description: 'x' }) }",
    "this patch can change a task's description",
    'p(id',
  ],
  [
    "export const assigned = (ctx: Ctx, id: Id<'issues'>, doc: Task) => { const r = ctx.db.replace; return r(id, doc) }",
    'this replaces a task row',
    'r(id',
  ],
  [
    "export const aliasedInsert = (ctx: Ctx, doc: Task) => { const write = insertUnique; return write(ctx, 'issues', doc) }",
    'this inserts a task row',
    'write(ctx',
  ],
  [
    "export const aliasedPatch = (ctx: Ctx, id: Id<'issues'>) => { const { patch: patchAlias } = ctx.db; const writeAgain = patchAlias; return writeAgain(id, { description: 'x' }) }",
    "this patch can change a task's description",
    'writeAgain(id',
  ],
  [
    "export const viaUsed = (ctx: Ctx, doc: Task) => insertUsed(ctx.db, 'issues', doc)",
    'this inserts a task row without its description row',
  ],
  [
    "export const projectRow = (ctx: Ctx, doc: Project) => ctx.db.insert('projects', doc)",
    'this inserts a project row without the used_ids row of its id',
  ],
  [
    "export const projectAgain = (ctx: Ctx, id: Id<'projects'>, doc: Project) => ctx.db.replace(id, doc)",
    'this replaces a project row without the used_ids row of its id',
  ],
  [
    "export const record = (ctx: Ctx) => ctx.db.insert('used_ids', { table: 'issues', row_id: 'a', org_id: 'b' })",
    'this inserts a used_ids row',
  ],
]

describe('the task write check', { timeout: 60_000 }, () => {
  it('fails on each write of a task row, description, project or archived state outside model/descriptions.ts, and passes the rest', () => {
    const bad = `${imports}\n${refused.map(([line]) => line).join('\n')}\n`
    const { status, output } = check({
      'schema.ts': schema,
      'lib/db.ts': db,
      'model/descriptions.ts': owner,
      'good.ts': good,
      'bad.ts': bad,
      'tests/plant.test.ts': `${imports}\nexport const plant = (ctx: Ctx, doc: Task) => ctx.db.insert('issues', doc)\n`,
    })
    expect(status).toBe(1)
    const lines = bad.split('\n')
    const expected = refused.map(([source, sentence, starts]) => {
      const line = lines.indexOf(source)
      const call = starts === undefined ? source.lastIndexOf('=> ') + 3 : source.indexOf(starts)
      return `convex/bad.ts:${line + 1}:${call + 1} - ${sentence}`
    })
    const found = output.split('\n').filter((line) => line.startsWith('convex/'))
    // insertAny is in lib/db.ts but is neither insertUnique nor insertUsed,
    // so it may not write a table of a type parameter, and lib/db.ts, which
    // alone writes used_ids, meets the description rules as any file does
    expect(found[0]).toMatch(
      /^convex\/lib\/db\.ts:13:3 - this writes a table that the check cannot read/,
    )
    expect(found[1]).toMatch(
      /^convex\/lib\/db\.ts:15:3 - this inserts a task row without its description row/,
    )
    const inBad = found.slice(2)
    expect(inBad).toHaveLength(expected.length)
    for (const [i, line] of inBad.entries()) expect(line.startsWith(expected[i]), line).toBe(true)
  })

  it('passes a tree whose task writes all go through model/descriptions.ts', () => {
    const { status, output } = check({
      'schema.ts': schema,
      'lib/db.ts': db.slice(0, db.indexOf('export const insertAny')),
      'model/descriptions.ts': owner,
      'good.ts': good,
    })
    expect(output).toBe('')
    expect(status).toBe(0)
  })

  it('fails when the code writes the database without model/descriptions.ts', () => {
    const { status, output } = check({
      'schema.ts': schema,
      'lib/db.ts': db.slice(0, db.indexOf('export const insertAny')),
      'good.ts': good,
    })
    expect(status).toBe(1)
    expect(output).toContain('convex/model/descriptions.ts - ')
    expect(output).toContain('does not hold it, though its code writes the database')
  })

  it('fails on each write in model/descriptions.ts that skips the used_ids row or names no table', () => {
    // each line, with the start of its sentence
    const lines = [
      [
        "export const raw = (ctx: Ctx, doc: Task) => ctx.db.insert('issues', doc)",
        'this inserts a task row without the used_ids row of its id',
      ],
      [
        "export const rawProject = (ctx: Ctx, doc: Project) => ctx.db.insert('projects', doc)",
        'this inserts a project row without the used_ids row of its id',
      ],
      [
        "export const swap = (ctx: Ctx, id: Id<'issues'>, doc: Task) => ctx.db.replace(id, doc)",
        'this replaces a task row without the used_ids row of its id',
      ],
      [
        "export const any = <T extends Tables>(ctx: Ctx, t: T, doc: WithoutSystemFields<DataModel[T]['document']>) => ctx.db.insert(t, doc)",
        'this writes a table that the check cannot read',
      ],
    ]
    const source = `${owner}${lines.map(([line]) => line).join('\n')}\n`
    const { status, output } = check({
      'schema.ts': schema,
      'lib/db.ts': db.slice(0, db.indexOf('export const insertAny')),
      'model/descriptions.ts': source,
    })
    expect(status).toBe(1)
    const rows = source.split('\n')
    const found = output.split('\n').filter((line) => line.startsWith('convex/'))
    expect(found).toHaveLength(lines.length)
    for (const [i, [line, sentence]] of lines.entries())
      expect(
        found[i].startsWith(
          `convex/model/descriptions.ts:${rows.indexOf(line) + 1}:${line.lastIndexOf('=> ') + 4} - ${sentence}`,
        ),
        found[i],
      ).toBe(true)
  })

  it('fails when it finds no insert of used_ids in lib/db.ts, which would mean it reads none', () => {
    const { status, output } = check({
      'schema.ts': schema,
      'lib/db.ts': `${db.slice(0, db.indexOf('const used'))}export const insertUnique = <T extends Tables>(ctx: Ctx, table: T, doc: WithoutSystemFields<DataModel[T]['document']>) => ctx.db.insert(table, doc)\nexport const insertUsed = insertUnique\n`,
      'model/descriptions.ts': owner,
    })
    expect(status).toBe(1)
    expect(output).toContain('convex/lib/db.ts - the check found no insert of used_ids in it')
  })

  it('fails when it finds no write in model/descriptions.ts, which would mean it reads none', () => {
    const { status, output } = check({
      'schema.ts': schema,
      'model/descriptions.ts': 'export const none = 0\n',
    })
    expect(status).toBe(1)
    expect(output).toContain('the check found no database write in it')
  })
})
