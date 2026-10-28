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

/* A schema with tasks, their descriptions and a table without them. */
const schema = `import { defineSchema, defineTable, type DataModelFromSchemaDefinition, type GenericMutationCtx } from 'convex/server'
import type { GenericId } from 'convex/values'
import { v } from 'convex/values'
const schema = defineSchema({
  issues: defineTable({ id: v.string(), org_id: v.string(), title: v.string(), description: v.optional(v.string()) }),
  issue_descriptions: defineTable({ issue_id: v.string(), org_id: v.string(), description: v.string() }),
  comments: defineTable({ body: v.string(), description: v.optional(v.string()) }),
})
export default schema
export type DataModel = DataModelFromSchemaDefinition<typeof schema>
export type Tables = keyof DataModel & string
export type Ctx = GenericMutationCtx<DataModel>
export type Id<T extends Tables> = GenericId<T>
`

const imports = `import type { WithoutSystemFields } from 'convex/server'
import type { Ctx, DataModel, Id, Tables } from './schema'
import { insertUnique, insertUnique as putRow } from './lib/db'
type Task = WithoutSystemFields<DataModel['issues']['document']>
`

/* A generic writer the check allows, whose callers it reads, and one beside
 * it that it does not allow. */
const db = `import type { WithoutSystemFields } from 'convex/server'
import type { Ctx, DataModel, Tables } from '../schema'
export const insertUnique = <T extends Tables>(ctx: Ctx, table: T, doc: WithoutSystemFields<DataModel[T]['document']>) =>
  ctx.db.insert(table, doc)
export const insertAny = <T extends Tables>(ctx: Ctx, table: T, doc: WithoutSystemFields<DataModel[T]['document']>) =>
  ctx.db.insert(table, doc)
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
export const fields = (ctx: Ctx, id: Id<'issues'>, w: Omit<Partial<Task>, 'description'>) => ctx.db.patch('issues', id, w)
export const comment = (ctx: Ctx) => ctx.db.insert('comments', { body: 'Hi', description: 'not a task' })
export const edit = (ctx: Ctx, id: Id<'comments'>) => ctx.db.patch(id, { description: 'not a task' })
export const unique = (ctx: Ctx) => insertUnique(ctx, 'comments', { body: 'Hi' })
export const gone = (ctx: Ctx, id: Id<'issues'>) => ctx.db.delete(id)
export const text = 'a.b'.replace('.', '')
export const tidy = (ctx: Ctx, id: Id<'comments'>) => {
  const { patch } = ctx.db
  return patch(id, { body: 'Tidy', description: 'not a task' })
}
export const uniqueComment = (ctx: Ctx) => putRow(ctx, 'comments', { body: 'Hi' })
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
]

describe('the task write check', { timeout: 60_000 }, () => {
  it('fails on each write of a task row or description outside model/descriptions.ts, and passes the rest', () => {
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
    // insertAny is in lib/db.ts but is not insertUnique, so it may not write
    // a table of a type parameter
    expect(found[0]).toMatch(
      /^convex\/lib\/db\.ts:6:3 - this writes a table that the check cannot read/,
    )
    const inBad = found.slice(1)
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

  it('fails when it finds no write in model/descriptions.ts, which would mean it reads none', () => {
    const { status, output } = check({
      'schema.ts': schema,
      'model/descriptions.ts': 'export const none = 0\n',
    })
    expect(status).toBe(1)
    expect(output).toContain('the check found no database write in it')
  })
})
