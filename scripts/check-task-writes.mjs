/* Fails when code in convex/ writes a task row, a task description or a
 * task's project or archived state anywhere but
 * convex/model/descriptions.ts, or inserts a task or project without the
 * used_ids row of its id. Task descriptions are kept in issue_descriptions
 * beside the task rows (schema.ts), each row with copies of its task's
 * project and archived state, and that file writes both in one
 * transaction, so the copies stay equal. Every id a task or project takes
 * is recorded in used_ids (schema.ts) in the transaction that inserts it,
 * and only lib/db.ts writes those rows, through insertUnique and
 * insertUsed, so no new task or project takes an id once used. It reads
 * every write through Convex's database writer (`insert`, `patch` and
 * `replace`) and every call of lib/db.ts insertUnique and insertUsed with
 * TypeScript's checker, outside the tests, which plant rows directly, and
 * fails on one that
 *
 * - inserts a row that may be a task (insertTask) or replaces one
 *   (patchTask),
 * - patches a row that may be a task with fields that may hold its
 *   description, project or archived state, a `description`, `project_id`
 *   or `archived_at` property or an index signature (patchTask; a write
 *   that changes none of them types its fields as TaskPatch),
 * - writes issue_descriptions,
 * - inserts or replaces a row that may be a task or project through
 *   Convex's writer outside lib/db.ts, model/descriptions.ts included
 *   (insertUnique, insertUsed),
 * - inserts a used_ids row outside lib/db.ts,
 * - or writes a table named by a type parameter, whose table the check
 *   cannot read. Only the generic writers below may, and for insertUnique
 *   and insertUsed the check reads the table each call names.
 *
 * It finds a write by the function it calls, whatever its name at the call:
 * `ctx.db.patch(...)`, `ctx.db['patch'](...)`, a writer method taken out
 * of the database by destructuring or assignment, insertUnique or
 * insertUsed under another name, and a constant that holds any of these,
 * however many constants deep. The checker reads a table from the type of
 * the argument that names it, a table name or an id, whose type carries its
 * table. A union counts every table it may be. Deleting rows is left to the
 * tests of every teardown.
 *
 * It prints nothing when it passes. It fails when it finds no write in
 * model/descriptions.ts or no insert of used_ids in lib/db.ts, which would
 * mean it reads none, and when the program writes the database without
 * model/descriptions.ts. Pass the path of a tsconfig.json whose files in
 * convex/ to check; convex/'s is the default. */
import fs from 'node:fs'
import path from 'node:path'
import * as ts from 'typescript/unstable/ast'
import { API, TypeFlags } from 'typescript/unstable/sync'
import { closeTypeScriptAPI } from './typescript-api.mjs'

const config = path.resolve(process.argv[2] ?? 'convex/tsconfig.json')
const convexDirectory = fs.realpathSync(path.resolve('convex'))
const owner = 'model/descriptions.ts'
/* The file that alone inserts used_ids rows and inserts tasks and projects
 * through Convex's writer, and the tables whose ids used_ids records
 * (lib/enums.ts USED_ID_TABLES). */
const usedOwner = 'lib/db.ts'
const usedTables = ['issues', 'projects']

/* The generic writers, functions in files under convex/ that write a table
 * their caller names. demoWriter wraps Convex's `insert`, so the check
 * reads its callers' writes anyway. For insertUnique and insertUsed it reads
 * the table each call names (`named`). */
const genericWriters = new Map([
  ['lib/db.ts', new Set(['insertUnique', 'insertUsed'])],
  ['lib/demo.ts', new Set(['demoWriter'])],
])
const named = { file: 'lib/db.ts', names: new Set(['insertUnique', 'insertUsed']), table: 1 }

const writes = new Set(['insert', 'patch', 'replace'])
/* The task fields a description row holds or copies. */
const copied = ['description', 'project_id', 'archived_at']
const writerNames = new Set([...writes, ...named.names])
const convexPackage = /[/\\]node_modules[/\\]convex[/\\]/
const skipped = /[/\\](?:node_modules|_generated|tests)[/\\]/

/** The text a name or string literal holds, or undefined. */
const textOf = (node) =>
  node &&
  (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined

/** The name a call's callee calls by: a property's, an indexed string's or
 * an identifier's. */
function calleeName(callee) {
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  if (ts.isElementAccessExpression(callee)) return textOf(callee.argumentExpression)
  if (ts.isIdentifier(callee)) return callee.text
  return undefined
}

/** The local names `sourceFile` gives a writer, insertUnique or insertUsed: an import
 * under another name, a destructured property, a variable assigned a
 * property of that name, and a variable assigned any of these names, how
 * many aliases deep it goes. */
function localWriters(sourceFile) {
  const names = new Set(writerNames)
  // `const alias = name` pairs, followed once every pair is read
  const aliases = []
  const visit = (node) => {
    if (ts.isImportSpecifier(node)) {
      if (writerNames.has((node.propertyName ?? node.name).text)) names.add(node.name.text)
    } else if (ts.isBindingElement(node) && node.name && ts.isIdentifier(node.name)) {
      const key = node.propertyName ? textOf(node.propertyName) : node.name.text
      if (key !== undefined && writerNames.has(key)) names.add(node.name.text)
    } else if (
      ts.isVariableDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const init = node.initializer
      if (ts.isIdentifier(init)) aliases.push([node.name.text, init.text])
      const name =
        ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init)
          ? calleeName(init)
          : undefined
      if (name !== undefined && writerNames.has(name)) names.add(node.name.text)
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  for (let grew = true; grew; ) {
    grew = false
    for (const [alias, name] of aliases)
      if (names.has(name) && !names.has(alias)) {
        names.add(alias)
        grew = true
      }
  }
  return names
}

/** The names of the functions around `node`, innermost first. */
function enclosingNames(node) {
  const names = []
  for (let at = node.parent; at; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name)
      names.push(at.name.text)
    else if (
      ts.isVariableDeclaration(at) &&
      ts.isIdentifier(at.name) &&
      at.initializer &&
      (ts.isArrowFunction(at.initializer) || ts.isFunctionExpression(at.initializer))
    )
      names.push(at.name.text)
  }
  return names
}

const failures = []
const api = new API()
try {
  const project = api.updateSnapshot({ openProjects: [config] }).getProject(config)
  if (!project) throw new Error(`TypeScript could not open ${config}`)
  const { program, checker } = project
  // TypeScript's canonical path of a file under convex/, the one declarations carry
  const canonical = (file) => program.getSourceFile(path.join(convexDirectory, file))?.path
  const ownerKey = canonical(owner)
  const usedKey = canonical(usedOwner)
  const namedKey = canonical(named.file)
  const generic = new Map(
    [...genericWriters]
      .map(([file, names]) => [canonical(file), names])
      .filter(([key]) => key !== undefined),
  )
  let ownerWrites = 0
  let usedWrites = 0
  let allWrites = 0
  /** Whether `symbol`, the symbol of a callee's type declared in lib/db.ts,
   * is insertUnique's or insertUsed's. A function declaration's carries its
   * name, and an arrow function's takes the name of the constant that holds
   * it. */
  const isNamed = (symbol) =>
    named.names.has(symbol.name) ||
    named.names.has(
      enclosingNames(symbol.declarations[0].resolve(project) ?? { parent: undefined })[0],
    )

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
  /** Whether fields of `type` may hold a description, a project or an
   * archived state. */
  const mayCopy = (type) =>
    !type ||
    type.isTypeParameter() ||
    type.isErrorType() ||
    (type.isUnionType()
      ? type.getTypes().some(mayCopy)
      : (type.flags & TypeFlags.Any) !== 0 ||
        copied.some((field) => checker.getPropertyOfType(type, field) !== undefined) ||
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
    const names = localWriters(sourceFile)
    const calls = []
    const visit = (node) => {
      if (ts.isCallExpression(node) && names.has(calleeName(node.expression))) calls.push(node)
      node.forEachChild(visit)
    }
    sourceFile.forEachChild(visit)
    if (calls.length === 0) continue
    // what each callee is, by the symbol of its type, in one request
    const types = checker.getTypeAtLocation(calls.map((call) => call.expression))
    for (const [index, call] of calls.entries()) {
      const symbol = types[index]?.getSymbol()
      const declared = symbol?.declarations?.[0]?.path
      if (!symbol || !declared) continue
      let table
      let fields
      let kind
      // a write through Convex's writer, rather than through insertUnique
      // or insertUsed, which write the used_ids row of a task or project
      let direct = false
      if (writes.has(symbol.name) && convexPackage.test(declared)) {
        // insert(table, value); patch and replace (id, value) or (table, id, value)
        table = call.arguments[0]
        fields = call.arguments.at(-1)
        kind = symbol.name
        direct = true
      } else if (declared === namedKey && isNamed(symbol)) {
        table = call.arguments[named.table]
        kind = 'insert'
      } else continue
      if (!table) continue
      allWrites++
      if (key === ownerKey) ownerWrites++
      const tables = new Set(tablesOf(checker.getTypeAtLocation(table)))
      if (tables.has('*')) {
        const names = generic.get(key)
        if (names && enclosingNames(call).some((name) => names.has(name))) continue
        failures.push(
          `${at(call)} - this writes a table that the check cannot read from its type. Name the table, or its id, with its own type.`,
        )
        continue
      }
      if (key === usedKey) {
        if (tables.has('used_ids') && kind === 'insert') usedWrites++
        continue
      }
      if (tables.has('used_ids') && kind === 'insert') {
        failures.push(`${at(call)} - this inserts a used_ids row, which only ${usedOwner} writes.`)
        continue
      }
      // a task outside the owner meets the description rules below, whose
      // insertTask writes its used_ids row too
      const used = usedTables.filter(
        (name) => tables.has(name) && (name !== 'issues' || key === ownerKey),
      )
      if (direct && (kind === 'insert' || kind === 'replace') && used.length > 0) {
        failures.push(
          `${at(call)} - this ${kind === 'insert' ? 'inserts' : 'replaces'} a ${used.includes('issues') ? 'task' : 'project'} row without the used_ids row of its id. Use ${usedOwner} insertUnique for an id a caller chose, or insertUsed.`,
        )
        continue
      }
      if (key === ownerKey) continue
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
      else if (mayCopy(fields && checker.getTypeAtLocation(fields)))
        failures.push(
          `${at(call)} - this patch can change a task's description, project or archived state without its description row. Use ${owner} patchTask, or type fields that leave them alone as TaskPatch.`,
        )
    }
  }
  if (ownerKey === undefined && allWrites > 0)
    failures.push(
      `convex/${owner} - ${config} does not hold it, though its code writes the database, so the check cannot tell which writes it allows.`,
    )
  // A check that finds no write in the file that holds them all reads none.
  if (ownerKey !== undefined && ownerWrites === 0)
    failures.push(
      `convex/${owner} - the check found no database write in it, so it may read none anywhere. Update scripts/check-task-writes.mjs for the installed typescript and convex.`,
    )
  if (usedKey !== undefined && usedWrites === 0)
    failures.push(
      `convex/${usedOwner} - the check found no insert of used_ids in it, so it may read none anywhere. Update scripts/check-task-writes.mjs for the installed typescript and convex.`,
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
    `\nTask rows and their description rows, which copy the task's project and archived state, are written together, by ${owner} (schema.ts issue_descriptions), and every task and project with the used_ids row of its id, by ${usedOwner} (schema.ts used_ids).`,
  )
  process.exit(1)
}
