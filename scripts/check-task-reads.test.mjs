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
 * scripts/check-task-reads.mjs there.
 */
function check(files) {
  repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'Qivo-Task-Reads-')))
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
  const result = spawnSync(process.execPath, ['scripts/check-task-reads.mjs'], {
    cwd: repository,
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (result.error) throw result.error
  return { status: result.status, output: result.stdout + result.stderr }
}

/* A schema with tasks, their descriptions and two tables beside them with a
 * description of their own. */
const schema = `import { defineSchema, defineTable, type DataModelFromSchemaDefinition } from 'convex/server'
import { v } from 'convex/values'
const schema = defineSchema({
  issues: defineTable({ id: v.string(), title: v.string(), description: v.optional(v.string()) }),
  issue_descriptions: defineTable({ issue_id: v.string(), description: v.string() }),
  projects: defineTable({ id: v.string(), description: v.string() }),
  comments: defineTable({ body: v.string(), description: v.optional(v.string()) }),
})
export default schema
export type DataModel = DataModelFromSchemaDefinition<typeof schema>
export type Tables = keyof DataModel & string
export type Doc<T extends Tables> = DataModel[T]['document']
`

const imports = `import type { Doc } from './schema'
import { descriptionOf } from './model/descriptions'
`

/* The owner's helpers, which read both copies. */
const owner = `import type { Doc } from '../schema'
export const descriptionOf = (task: Doc<'issues'>, row: Doc<'issue_descriptions'> | null) =>
  row?.description ?? task.description ?? ''
`

const good = `${imports}
export const shown = (task: Doc<'issues'>, row: Doc<'issue_descriptions'> | null) => descriptionOf(task, row)
export const project = (p: Doc<'projects'>) => p.description
export const comment = (c: Doc<'comments'>) => c.description ?? c['description']
export const row = (r: Doc<'issue_descriptions'>) => r.description
export const dropped = ({ description: _text, ...rest }: Doc<'issues'>) => rest
export const droppedLater = (task: Doc<'issues'>) => {
  const { description: _text, ...rest } = task
  return rest
}
export const fields = (w: { description?: string }) => w.description
export const title = (task: Doc<'issues'>) => task.title
`

/* Each read the check refuses, one a line, with the text its read starts
 * with. */
const refused = [
  ["export const direct = (task: Doc<'issues'>) => task.description", 'task.description'],
  [
    "export const optional = (task: Doc<'issues'> | null) => task?.description",
    'task?.description',
  ],
  ["export const literal = (task: Doc<'issues'>) => task['description']", "task['description']"],
  [
    "export const keyed = (task: Doc<'issues'>) => { const key = 'description' as const; return task[key] }",
    'task[key]',
  ],
  ["export const param = ({ description }: Doc<'issues'>) => description", 'description }'],
  [
    "export const renamed = (task: Doc<'issues'>) => { const { description: text } = task; return text }",
    'description: text',
  ],
  [
    "export const either = (row: Doc<'issues'> | Doc<'projects'>) => row.description",
    'row.description',
  ],
  [
    "export const withText = (task: Doc<'issues'> & { description: string }) => task.description",
    'task.description',
  ],
]

describe('the task read check', { timeout: 60_000 }, () => {
  it('fails on each read of issues.description outside model/descriptions.ts, and passes the rest', () => {
    const bad = `${imports}\n${refused.map(([line]) => line).join('\n')}\n`
    const { status, output } = check({
      'schema.ts': schema,
      'model/descriptions.ts': owner,
      'good.ts': good,
      'bad.ts': bad,
      'tests/plant.test.ts': `${imports}\nexport const plant = (task: Doc<'issues'>) => task.description\n`,
    })
    expect(status).toBe(1)
    const lines = bad.split('\n')
    const expected = refused.map(([source, starts]) => {
      const line = lines.indexOf(source)
      return `convex/bad.ts:${line + 1}:${source.indexOf(starts) + 1} - this reads issues.description`
    })
    const found = output.split('\n').filter((line) => line.startsWith('convex/'))
    expect(found).toHaveLength(expected.length)
    for (const [i, line] of found.entries()) expect(line.startsWith(expected[i]), line).toBe(true)
  })

  it('passes the backfill and the function that reads the stored text on purpose', () => {
    const stored = `import type { Doc } from '../schema'\n`
    const { status, output } = check({
      'schema.ts': schema,
      'model/descriptions.ts': owner,
      'good.ts': good,
      'internal/descriptionsBackfill.ts': `${stored}export const differs = (task: Doc<'issues'>, row: Doc<'issue_descriptions'>) => row.description !== task.description\n`,
      'model/deletedItems.ts': `${stored}function cutToCaps(task: Doc<'issues'>) { return { ...task, description: (task.description ?? '').slice(0, 10) } }\nexport const cut = cutToCaps\nexport const other = (task: Doc<'issues'>) => task.description\n`,
      // a subtree walk sizes a task row with getDocumentSize, so an
      // estimate from the stored text is no longer kept
      'model/issues.ts': `${stored}const subtaskBytes = (task: Doc<'issues'>) => 3 * (task.description?.length ?? 0)\nexport const bytes = subtaskBytes\n`,
    })
    // only the reads outside the kept function fail
    expect(output.split('\n').filter((line) => line.startsWith('convex/'))).toEqual([
      expect.stringMatching(
        /^convex\/model\/deletedItems\.ts:4:47 - this reads issues\.description/,
      ),
      expect.stringMatching(/^convex\/model\/issues\.ts:2:52 - this reads issues\.description/),
    ])
    expect(status).toBe(1)
  })

  it('passes a tree whose reads all go through model/descriptions.ts', () => {
    const { status, output } = check({
      'schema.ts': schema,
      'model/descriptions.ts': owner,
      'good.ts': good,
    })
    expect(output).toBe('')
    expect(status).toBe(0)
  })

  it('fails when it finds no read in model/descriptions.ts, which would mean it reads none', () => {
    const { status, output } = check({
      'schema.ts': schema,
      'model/descriptions.ts': 'export const none = 0\n',
    })
    expect(status).toBe(1)
    expect(output).toContain('the check found no read of issues.description in it')
  })
})
