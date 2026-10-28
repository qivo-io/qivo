/* Fails when code in convex/ writes a task row or a task description
 * anywhere but convex/model/descriptions.ts. Task descriptions are kept in
 * issue_descriptions beside the task rows (schema.ts), and that file writes
 * both in one transaction, so the copies stay equal. It reads every write
 * through Convex's database writer (`insert`, `patch` and `replace`) with
 * TypeScript's checker, outside the tests, which plant rows directly, and
 * fails on one that
 *
 * - inserts a row that may be a task (insertTask) or replaces one
 *   (patchTask),
 * - patches a row that may be a task with fields that may hold its
 *   description, a `description` property or an index signature
 *   (patchTask; a write that never changes the description types its
 *   fields as TaskPatch),
 * - writes issue_descriptions,
 * - or writes a table named by a type parameter, whose table the check
 *   cannot read. The generic writers below are the exceptions, and for
 *   lib/db.ts insertUnique the check reads the table each call names.
 *
 * The check reads a table from the type of the argument that names it, a
 * table name or an id, whose type carries its table. A union counts every
 * table it may be. Deleting rows is left to the tests of every teardown. It
 * prints nothing when it passes, and fails when it finds no write in
 * model/descriptions.ts, which would mean it reads none. Pass the
 * path of a tsconfig.json whose files in convex/ to check; convex/'s is the
 * default. */
import fs from 'node:fs'
import path from 'node:path'
import * as ts from 'typescript/unstable/ast'
import { API, TypeFlags } from 'typescript/unstable/sync'
import { closeTypeScriptAPI } from './typescript-api.mjs'

const config = path.resolve(process.argv[2] ?? 'convex/tsconfig.json')
const convexDirectory = fs.realpathSync(path.resolve('convex'))
const owner = 'model/descriptions.ts'

/* The generic writers, files under convex/ that write a table their caller
 * names. lib/demo.ts demoWriter wraps Convex's `insert`, so the check reads
 * its callers' writes anyway. For lib/db.ts insertUnique it reads the table
 * each call names (`unique`). */
const genericWriters = ['lib/db.ts', 'lib/demo.ts']
const unique = { file: 'lib/db.ts', name: 'insertUnique', table: 1 }

const writes = new Set(['insert', 'patch', 'replace'])
const convexPackage = /[/\\]node_modules[/\\]convex[/\\]/
const skipped = /[/\\](?:node_modules|_generated|tests)[/\\]/

const failures = []
const api = new API()
try {
  const project = api.updateSnapshot({ openProjects: [config] }).getProject(config)
  if (!project) throw new Error(`TypeScript could not open ${config}`)
  const { program, checker } = project
  // TypeScript's canonical path of a file under convex/, the one declarations carry
  const canonical = (file) => program.getSourceFile(path.join(convexDirectory, file))?.path
  const ownerKey = canonical(owner)
  let ownerWrites = 0
  const generic = new Set(genericWriters.map(canonical).filter(Boolean))
  const uniqueKey = canonical(unique.file)

  /** The tables a table name or id type may name; '*' for one the check
   * cannot read, such as a type parameter or any. */
  const tablesOf = (type) => {
    if (!type || type.isTypeParameter() || type.isErrorType()) return ['*']
    if (type.isUnionType()) return type.getTypes().flatMap(tablesOf)
    if (type.isStringLiteralType()) return [type.value]
    const table = checker.getPropertyOfType(type, '__tableName')
    if (table) return tablesOf(checker.getTypeOfSymbol(table))
    return ['*']
  }
  /** Whether fields of `type` may hold a description. */
  const mayDescribe = (type) =>
    !type ||
    type.isTypeParameter() ||
    type.isErrorType() ||
    (type.isUnionType()
      ? type.getTypes().some(mayDescribe)
      : (type.flags & TypeFlags.Any) !== 0 ||
        checker.getPropertyOfType(type, 'description') !== undefined ||
        checker.getIndexInfosOfType(type).length > 0)

  for (const file of program.getSourceFileNames()) {
    // only convex/'s own code, not what it imports from elsewhere
    if (path.relative(convexDirectory, file).startsWith('..') || skipped.test(file)) continue
    const sourceFile = program.getSourceFile(file)
    if (!sourceFile || sourceFile.isDeclarationFile) continue
    const key = sourceFile.path
    const at = (node) => {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      return `${path.relative(process.cwd(), sourceFile.fileName)}:${start.line + 1}:${start.character + 1}`
    }
    const calls = []
    const visit = (node) => {
      if (ts.isCallExpression(node)) calls.push(node)
      node.forEachChild(visit)
    }
    sourceFile.forEachChild(visit)
    for (const call of calls) {
      const callee = call.expression
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : undefined
      if (name === undefined) continue
      const through = writes.has(name) && ts.isPropertyAccessExpression(callee)
      if (!through && name !== unique.name) continue
      const declared = checker.getResolvedSignature(call)?.declaration?.path
      if (!declared) continue
      let table
      let fields
      let kind
      if (through && convexPackage.test(declared)) {
        // insert(table, value); patch and replace (id, value) or (table, id, value)
        table = call.arguments[0]
        fields = call.arguments.at(-1)
        kind = name
      } else if (name === unique.name && declared === uniqueKey) {
        table = call.arguments[unique.table]
        kind = 'insert'
      } else continue
      if (!table) continue
      if (key === ownerKey) {
        ownerWrites++
        continue
      }
      const tables = new Set(tablesOf(checker.getTypeAtLocation(table)))
      if (tables.has('*')) {
        if (generic.has(key)) continue
        failures.push(
          `${at(call)} - this writes a table that the check cannot read from its type. Name the table, or its id, with its own type.`,
        )
        continue
      }
      if (!tables.has('issues') && !tables.has('issue_descriptions')) continue
      if (tables.has('issue_descriptions'))
        failures.push(`${at(call)} - this writes issue_descriptions, which only ${owner} writes.`)
      else if (kind === 'insert')
        failures.push(
          `${at(call)} - this inserts a task row without its description row. Use ${owner} insertTask.`,
        )
      else if (kind === 'replace')
        failures.push(
          `${at(call)} - this replaces a task row without its description row. Use ${owner} patchTask.`,
        )
      else if (mayDescribe(fields && checker.getTypeAtLocation(fields)))
        failures.push(
          `${at(call)} - this patch can change a task's description without its description row. Use ${owner} patchTask, or type fields that leave the description alone as TaskPatch.`,
        )
    }
  }
  // A check that finds no write in the file that holds them all reads none.
  if (ownerKey && !ownerWrites)
    failures.push(
      `convex/${owner} - the check found no database write in it, so it may read none anywhere. Update scripts/check-task-writes.mjs for the installed typescript and convex.`,
    )
} catch (error) {
  // Closing after a failed read can fail too, and would hide the read's error.
  await closeTypeScriptAPI(api).catch(() => {})
  throw error
}
await closeTypeScriptAPI(api)

if (failures.length) {
  console.error(failures.join('\n'))
  console.error(
    `\nTask rows and their descriptions are written together, by ${owner} (schema.ts issue_descriptions).`,
  )
  process.exit(1)
}
