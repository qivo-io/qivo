/* Fails when code in convex/ reads the text a task row stores,
 * issues.description, anywhere but convex/model/descriptions.ts and the
 * one-time migration that compares both copies,
 * convex/internal/descriptionsBackfill.ts. Task descriptions are moving
 * into issue_descriptions (schema.ts), and every reader takes a task's text
 * from model/descriptions.ts (descriptionOf, withText, descriptionsOf,
 * textsOf), which falls back to issues.description only for a task without
 * a row. Once the third release clears issues.description, a direct read
 * would silently read nothing, so the check refuses one now.
 *
 * It reads convex/'s own code with TypeScript's checker, outside the tests,
 * which plant and read rows directly, and fails on
 *
 * - a property read, `task.description` or `task?.description`,
 * - an element read whose key is the literal 'description', written as a
 *   string or held by a constant of that literal type,
 * - and a destructuring that binds `description`, in a parameter or a
 *   declaration, unless it binds it to a name that starts with `_`, which
 *   drops the field, as a row sent without the text does,
 *
 * of a value whose type may be a task row: an object type whose `_id` is an
 * id of issues (`Doc<'issues'>`, a type built on it, or a union with one).
 * A task with its text (model/descriptions.ts TaskWithText) is such a type
 * too, so code that compares a write's before and after texts calls
 * textsOf. Two functions read the stored text on purpose and pass (`kept`).
 *
 * It cannot see a task row whose fields go on whole: a spread into another
 * object, `Object.keys` or `JSON.stringify` of one, a key of a union type
 * such as the activity diff's fields, or a value cast to another type. Nor
 * can it see a type built from a task row without its `_id`, whose
 * description still comes from issues.description: a `Pick`, `Omit` or
 * `WithoutSystemFields` of `Doc<'issues'>`, a row as the app receives it
 * (lib/workspaceParts.ts AppRow), or a task Deleted items stores. TypeScript
 * keeps no declaration on a property the schema's validators infer, so the
 * check cannot tell such a type from any other with a `description`, and a
 * test for the task's other fields would also catch a write's fields
 * (model/descriptions.ts TaskFields), which hold the text the write sets.
 * The readers' tests clear issues.description and check what those paths
 * send (convex/tests/descriptionReaders.test.ts).
 *
 * It prints nothing when it passes. It fails when it finds no read in
 * model/descriptions.ts, which would mean it reads none. Pass the path of a
 * tsconfig.json whose files in convex/ to check; convex/'s is the
 * default. */
import fs from 'node:fs'
import path from 'node:path'
import * as ts from 'typescript/unstable/ast'
import { API } from 'typescript/unstable/sync'
import { closeTypeScriptAPI } from './typescript-api.mjs'

const config = path.resolve(process.argv[2] ?? 'convex/tsconfig.json')
const convexDirectory = fs.realpathSync(path.resolve('convex'))
const owner = 'model/descriptions.ts'
/* The files that may read either copy: the owner, and the backfill, which
 * compares them. */
const readers = new Set([owner, 'internal/descriptionsBackfill.ts'])
/* Functions that read the text a task row stores on purpose: Deleted items
 * stores a task with its text (model/descriptions.ts withDescription) and
 * cuts a copy too large to store, and a subtree walk estimates a task
 * row's size from the text it holds. */
const kept = new Map([
  ['model/deletedItems.ts', new Set(['cutToCaps'])],
  ['model/issues.ts', new Set(['subtaskBytes'])],
])
const field = 'description'
const skipped = /[/\\](?:node_modules|_generated|tests)[/\\]/

/** The text a name or string literal holds, or undefined. */
const textOf = (node) =>
  node &&
  (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined

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

/** The reads of `description` in `sourceFile` that the check asks about:
 * each with the node whose type tells whether it reads a task row, and,
 * for an element read through a non-literal key, the key, whose type tells
 * whether it is 'description'. */
function candidates(sourceFile) {
  const out = []
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === field) {
      out.push({ node, object: node.expression })
    } else if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression
      const text = ts.isIdentifier(key) ? undefined : textOf(key)
      if (text === field) out.push({ node, object: node.expression })
      else if (ts.isIdentifier(key)) out.push({ node, object: node.expression, key })
    } else if (ts.isObjectBindingPattern(node)) {
      for (const element of node.elements) {
        const name = element.propertyName
          ? textOf(element.propertyName)
          : ts.isIdentifier(element.name)
            ? element.name.text
            : undefined
        if (name !== field) continue
        // bound to `_name`, the field is dropped, not read
        if (ts.isIdentifier(element.name) && element.name.text.startsWith('_')) continue
        out.push({ node: element, object: node })
      }
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return out
}

const failures = []
const api = new API()
try {
  const project = api.updateSnapshot({ openProjects: [config] }).getProject(config)
  if (!project) throw new Error(`TypeScript could not open ${config}`)
  const { program, checker } = project
  const canonical = (file) => program.getSourceFile(path.join(convexDirectory, file))?.path
  const ownerKey = canonical(owner)
  let ownerReads = 0

  /** Whether `type` names the issues table, as an id's brand does. */
  const namesIssues = (type) => {
    if (!type) return false
    if (type.isUnionType()) return type.getTypes().some(namesIssues)
    if (type.isStringLiteralType()) return type.value === 'issues'
    const table = checker.getPropertyOfType(type, '__tableName')
    return table !== undefined && namesIssues(checker.getTypeOfSymbol(table))
  }
  /** Whether a value of `type` may be a task row: an object whose `_id` is
   * an id of issues, or a union with one. */
  const mayBeTask = (type) => {
    if (!type || type.isErrorType()) return false
    if (type.isUnionType()) return type.getTypes().some(mayBeTask)
    const id = checker.getPropertyOfType(type, '_id')
    return id !== undefined && namesIssues(checker.getTypeOfSymbol(id))
  }
  /** Whether a key of `type` is the literal 'description'. */
  const isField = (type) => type?.isStringLiteralType() === true && type.value === field

  for (const file of program.getSourceFileNames()) {
    if (path.relative(convexDirectory, file).startsWith('..') || skipped.test(file)) continue
    const sourceFile = program.getSourceFile(file)
    if (!sourceFile || sourceFile.isDeclarationFile) continue
    const relative = path.relative(convexDirectory, sourceFile.fileName).split(path.sep).join('/')
    const found = candidates(sourceFile)
    if (found.length === 0) continue
    const objects = checker.getTypeAtLocation(found.map((read) => read.object))
    const keyed = found.filter((read) => read.key !== undefined)
    const keyTypes = keyed.length > 0 ? checker.getTypeAtLocation(keyed.map((r) => r.key)) : []
    const keys = new Map(keyed.map((read, i) => [read, keyTypes[i]]))
    for (const [index, read] of found.entries()) {
      if (read.key !== undefined && !isField(keys.get(read))) continue
      if (!mayBeTask(objects[index])) continue
      if (sourceFile.path === ownerKey) {
        ownerReads++
        continue
      }
      if (readers.has(relative)) continue
      const allowed = kept.get(relative)
      if (allowed && enclosingNames(read.node).some((name) => allowed.has(name))) continue
      const start = sourceFile.getLineAndCharacterOfPosition(read.node.getStart(sourceFile))
      failures.push(
        `${path.relative(process.cwd(), sourceFile.fileName)}:${start.line + 1}:${start.character + 1} - this reads issues.description. Read the task's text through ${owner} (descriptionOf, withText, descriptionsOf or textsOf).`,
      )
    }
  }
  // A check that finds no read in the file that holds them all reads none.
  if (ownerKey !== undefined && ownerReads === 0)
    failures.push(
      `convex/${owner} - the check found no read of issues.description in it, so it may find none anywhere. Update scripts/check-task-reads.mjs for the installed typescript and convex.`,
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
    `\nReaders take a task's text from its description row, through ${owner} (schema.ts issue_descriptions).`,
  )
  process.exit(1)
}
