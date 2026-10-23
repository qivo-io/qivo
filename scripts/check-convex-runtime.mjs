/* Fails when code in convex/ that runs in Convex's default runtime uses a
 * global or a module that only Node provides. Most Convex functions run in a
 * V8 isolate, and only the files that start with 'use node' run in Node. The
 * convex/ program holds both kinds, and with them Node's types (sharp's
 * types and the generated api.d.ts, which imports every module, bring them
 * in), so tsc accepts Buffer, require or a `node:` import in any file there.
 *
 * Convex bundles every file in convex/ by its own directive: a file without
 * 'use node' is a default-runtime entry point even when only Node files
 * import it, and Convex evaluates it there when it deploys. This takes the
 * files Convex bundles that way, adds what they import at runtime, and reads
 * them with TypeScript's checker. A global read at runtime that Node's types
 * (@types/node and the undici-types it uses) declare as a value must be one
 * of the runtime's globals below, and `process` may only be read as
 * `process.env`. A runtime import of a Node module or of a 'use node' file
 * fails. Types are erased, so type positions and `import type` may name
 * Node's types. Tests, which Convex skips, keep Node's globals. Whatever the
 * check cannot settle, such as an import it cannot follow, fails too.
 *
 * The bundler rules below are those of convex 1.47: its entryPoints,
 * hasUseNodeDirective (with useNodeDirectiveRegex) and mustBeIsolate in
 * convex/dist/esm/bundler/index.js, and the schema, auth config and
 * component definition bundles. */
import fs from 'node:fs'
import path from 'node:path'
import * as ts from 'typescript/unstable/ast'
import { API, SymbolFlags } from 'typescript/unstable/sync'
import { closeTypeScriptAPI } from './typescript-api.mjs'

/* The globals of the default runtime beyond ECMAScript's, which come from
 * the program's lib. Measured on a local backend (precompiled-2026-10-10)
 * as the names on globalThis and its prototypes in a query, a mutation and
 * an action, which had the same ones. They match Convex's list at
 * https://docs.convex.dev/functions/runtimes, which adds that fetch works in
 * actions only. Convex and getParent are internal and left out. `process`
 * holds only `env` there. */
const runtimeGlobals = new Set([
  'AbortController',
  'AbortSignal',
  'AsyncLocalStorage',
  'AsyncResource',
  'Blob',
  'ByteLengthQueuingStrategy',
  'CountQueuingStrategy',
  'Crypto',
  'CryptoKey',
  'DOMException',
  'Event',
  'EventTarget',
  'File',
  'FormData',
  'Headers',
  'Performance',
  'PerformanceEntry',
  'PerformanceMark',
  'PerformanceMeasure',
  'ReadableByteStreamController',
  'ReadableStream',
  'ReadableStreamBYOBReader',
  'ReadableStreamBYOBRequest',
  'ReadableStreamDefaultController',
  'ReadableStreamDefaultReader',
  'Request',
  'Response',
  'SubtleCrypto',
  'TextDecoder',
  'TextDecoderStream',
  'TextEncoder',
  'TextEncoderStream',
  'TransformStream',
  'TransformStreamDefaultController',
  'URL',
  'URLSearchParams',
  'WebAssembly',
  'WritableStream',
  'WritableStreamDefaultController',
  'WritableStreamDefaultWriter',
  'addEventListener',
  'atob',
  'btoa',
  'clearInterval',
  'clearTimeout',
  'console',
  'crypto',
  'dispatchEvent',
  'fetch',
  'performance',
  'removeEventListener',
  'self',
  'setInterval',
  'setTimeout',
  'structuredClone',
])
/* Files at the top of convex/ or of a component, by name without the
 * extension, that Convex runs in the default runtime whatever their
 * directive: it bundles the schema, the auth config and the component
 * definition apart, and refuses 'use node' in http and crons. */
const isolateOnly = new Set(['auth.config', 'convex.config', 'crons', 'http', 'schema'])
// The extensions esbuild may take an entry point from, in Convex's bundler.
const entryExtensions = /\.(?:[cm]?[jt]s|[jt]sx)$/
// The line Convex reads as 'use node' when its parser cannot read the file.
const useNodeLine = /^\s*("|')use node("|');?\s*$/
/* Convex's bundler replaces these modules in the default runtime with the
 * two globals of the same names. */
const asyncHooks = /^(?:node:)?async_hooks$/
const asyncHooksExports = new Set(['AsyncLocalStorage', 'AsyncResource'])
// The declarations that give a global its value, as opposed to its type.
const valueKinds = new Set([
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.VariableDeclaration,
])
const config = path.resolve('convex/tsconfig.json')
const convexDirectory = path.dirname(config)
const nodeTypes = /[/\\]node_modules[/\\](?:@types[/\\]node|undici-types)[/\\]/
const nodeModules = /[/\\]node_modules[/\\]/
// Convex writes these, and their declaration files describe its own JavaScript.
const generated = /[/\\]_generated[/\\][^/\\]+$/

/**
 * Returns the files Convex bundles for the default runtime from convex/ or a
 * component directory in it, by its bundler's rules. `entries` run in Node
 * when they say 'use node': script extensions, outside the top _generated/,
 * no leading dot or #, not schema.ts or schema.js, one dot in the name and no
 * space in the path. `isolated` always run in the default runtime. A
 * directory with a convex.config.ts is a component, bundled as a root of its own.
 */
function bundledFiles(root, found = { entries: [], isolated: [] }) {
  const walk = (directory) => {
    // Sorted, as Convex walks them, so the failures come in the same order everywhere.
    const sorted = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of sorted) {
      const file = path.join(directory, entry.name)
      const relative = path.relative(root, file)
      if (entry.isDirectory()) {
        if (fs.existsSync(path.join(file, 'convex.config.ts'))) bundledFiles(file, found)
        else walk(file)
        continue
      }
      if (!entryExtensions.test(entry.name)) continue
      const name = entry.name.replace(/\.[^.]+$/, '')
      if (relative === entry.name && isolateOnly.has(name)) found.isolated.push(file)
      else if (
        !relative.startsWith(`_generated${path.sep}`) &&
        !/^[.#]/.test(entry.name) &&
        !['schema.ts', 'schema.js'].includes(entry.name) &&
        !name.includes('.') &&
        !relative.includes(' ')
      )
        found.entries.push(file)
    }
  }
  walk(root)
  return found
}

/**
 * Tells how Convex's bundler reads a file's directive: 'node' when its
 * directive prologue holds 'use node' as written text and a line reads as
 * one, 'isolate' when neither holds, and 'unclear' when only one does.
 * Convex compares the directive's raw text when its parser reads the file,
 * and looks for such a line anywhere in it when the parser cannot.
 */
function directive(sourceFile) {
  if (!sourceFile.text.includes('use node')) return 'isolate'
  let prologue = false
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break
    if (statement.expression.getText(sourceFile).slice(1, -1) === 'use node') prologue = true
  }
  const line = sourceFile.text.split('\n').some((text) => useNodeLine.test(text))
  if (prologue === line) return prologue ? 'node' : 'isolate'
  return 'unclear'
}

/**
 * Tells whether a node is a type, an interface, a type alias or a `declare`
 * statement, which compile to nothing.
 */
function erased(node) {
  return (
    ts.isTypeNode(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword))
  )
}

/**
 * Returns what a file runs: the imports and exports that stay in its
 * JavaScript, with the declaration that names each module, and the
 * identifiers it reads or declares outside the erased code. The config sets
 * verbatimModuleSyntax, so only `import type`, `export type` and import
 * types are erased.
 */
function runtimeNodes(sourceFile) {
  const imports = []
  const identifiers = []
  const visit = (node) => {
    if (ts.isIdentifier(node)) identifiers.push(node)
    else if (ts.isExpressionWithTypeArguments(node)) {
      // A class's extends clause or an instantiation expression runs, its
      // type arguments do not. An implements clause is erased whole.
      if (node.parent.token !== ts.SyntaxKind.ImplementsKeyword) visit(node.expression)
    } else if (ts.isImportDeclaration(node)) {
      if (node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword)
        imports.push({ specifier: node.moduleSpecifier, declaration: node })
    } else if (!erased(node)) {
      if (ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && !node.isTypeOnly)
          imports.push({ specifier: node.moduleSpecifier, declaration: node })
      } else if (ts.isImportEqualsDeclaration(node)) {
        if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference))
          imports.push({ specifier: node.moduleReference.expression, declaration: node })
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        imports.push({ specifier: node.arguments[0], declaration: node })
      }
      node.forEachChild(visit)
    }
  }
  visit(sourceFile)
  return { imports, identifiers }
}

/**
 * Returns the names a file's top-level `declare` statements give values,
 * which make its references resolve to them instead of Node's globals.
 */
function declaredValues(sourceFile) {
  return sourceFile.statements.flatMap((statement) => {
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword))
      return []
    if (ts.isVariableStatement(statement))
      return statement.declarationList.declarations
        .map((declaration) => declaration.name)
        .filter((name) => ts.isIdentifier(name))
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    )
      return statement.name ? [statement.name] : []
    return []
  })
}

/**
 * Tells whether an import of async_hooks takes only the names Convex's
 * bundler provides, by name, the one form its replacement module serves
 * the way Node's types describe.
 */
function takesShimmedAsyncHooks(declaration) {
  const bindings = ts.isImportDeclaration(declaration)
    ? !declaration.importClause?.name && declaration.importClause?.namedBindings
    : ts.isExportDeclaration(declaration) && declaration.exportClause
  return (
    Boolean(bindings) &&
    !ts.isNamespaceImport(bindings) &&
    !ts.isNamespaceExport(bindings) &&
    bindings.elements.every(
      (element) =>
        element.isTypeOnly || asyncHooksExports.has((element.propertyName ?? element.name).text),
    )
  )
}

/**
 * Tells whether an identifier names something to look up, as opposed to a
 * property, a label or a declaration's own name, which the checker may
 * leave without a symbol and which never reads a global. A shorthand
 * property is both, and reads a name.
 */
function isReference(name) {
  const parent = name.parent
  return (
    ts.isShorthandPropertyAssignment(parent) ||
    !(
      parent.name === name ||
      parent.propertyName === name ||
      parent.label === name ||
      (ts.isQualifiedName(parent) && parent.right === name)
    )
  )
}

const api = new API()
const failures = []
let checked = 0
let nodeFiles = 0
try {
  const project = api.updateSnapshot({ openProjects: [config] }).getProject(config)
  if (!project) throw new Error(`TypeScript could not open ${config}`)
  const { program, checker } = project
  /* Keyed by TypeScript's canonical path, the one declarations carry, which
   * is lowercase on a host whose file names ignore case. */
  const sources = new Map()
  let nodeTypesLoaded = false
  for (const file of program.getSourceFileNames()) {
    if (nodeTypes.test(file)) nodeTypesLoaded = true
    if (nodeModules.test(file)) continue
    const sourceFile = program.getSourceFile(file)
    if (!sourceFile) throw new Error(`TypeScript could not read ${file}`)
    // Declaration files, such as the generated api.d.ts, never run.
    if (!sourceFile.isDeclarationFile) sources.set(sourceFile.path, sourceFile)
  }
  // Without Node's types no name resolves to them, and every file would pass.
  if (!nodeTypesLoaded) throw new Error(`${config} does not load Node's types`)
  for (const sourceFile of sources.values()) if (directive(sourceFile) === 'node') nodeFiles++

  const relative = (file) => path.relative(process.cwd(), file)
  const at = (key, node) => {
    const sourceFile = sources.get(key)
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    return `${relative(sourceFile.fileName)}:${line + 1}:${character + 1}`
  }
  // Convex's entry points and the files it bundles apart, then what they import at runtime.
  const runtime = new Set()
  const pending = []
  // Queues a file to check, once.
  const add = (key) => {
    if (!runtime.has(key)) {
      runtime.add(key)
      pending.push(key)
    }
  }
  const unclear = (key) =>
    `${relative(sources.get(key).fileName)} - Convex may run it in either runtime. Write 'use node' alone on its line at the top of the file, or no line that reads as one.`
  const { entries, isolated } = bundledFiles(convexDirectory)
  for (const file of [...entries, ...isolated]) {
    const key = program.getSourceFile(file)?.path
    if (!key || !sources.has(key)) {
      failures.push(`${relative(file)} is not in ${config}.`)
      continue
    }
    const read = directive(sources.get(key))
    if (isolated.includes(file)) {
      if (read !== 'isolate')
        failures.push(
          `${relative(file)} - Convex runs ${path.basename(file)} in the default runtime whatever its directive, so remove 'use node'.`,
        )
      add(key)
    } else if (read === 'unclear') failures.push(unclear(key))
    else if (read === 'isolate') add(key)
  }
  while (pending.length) {
    const key = pending.pop()
    const { imports } = runtimeNodes(sources.get(key))
    const named = ({ specifier }) =>
      specifier && (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier))
    for (const found of imports)
      if (!named(found))
        failures.push(
          `${at(key, found.declaration)} - this imports a module named at runtime, which the check cannot follow. Name it with a string.`,
        )
    const literal = imports.filter(named)
    const modules = literal.length
      ? checker.getSymbolAtLocation(literal.map((found) => found.specifier))
      : []
    literal.forEach(({ specifier, declaration }, index) => {
      const declarations = modules[index]?.declarations ?? []
      // A module TypeScript cannot resolve would escape every check here.
      if (!declarations.length) {
        failures.push(
          `${at(key, specifier)} - TypeScript does not resolve ${specifier.text} to a module. A file needs an import or an export, such as \`export {}\`, to be one.`,
        )
        return
      }
      // Another file's `declare module` adds to Node's module, and does not replace it.
      if (declarations.some((d) => nodeTypes.test(d.path))) {
        if (!asyncHooks.test(specifier.text))
          failures.push(
            `${at(key, specifier)} - ${specifier.text} is a Node module, which the default runtime does not provide.`,
          )
        else if (!takesShimmedAsyncHooks(declaration))
          failures.push(
            `${at(key, specifier)} - the default runtime's ${specifier.text} holds only AsyncLocalStorage and AsyncResource, so import them by name.`,
          )
        return
      }
      // The module's files. A `declare module` elsewhere only adds types to one.
      const files = declarations.filter((d) => d.kind === ts.SyntaxKind.SourceFile)
      if (!files.length && !declarations.every((d) => nodeModules.test(d.path)))
        failures.push(
          `${at(key, specifier)} - only a \`declare module\` describes ${specifier.text}, so the check cannot read what it runs.`,
        )
      for (const { path: target } of files) {
        const imported = sources.get(target)
        if (imported) {
          const read = directive(imported)
          if (read === 'node')
            failures.push(
              `${at(key, specifier)} - ${specifier.text} starts with 'use node', and the default runtime cannot run it.`,
            )
          else if (read === 'unclear') failures.push(unclear(target))
          else add(target)
        } else if (!nodeModules.test(target) && !generated.test(target))
          // Such as a declaration file, whose JavaScript beside it Convex bundles.
          failures.push(
            `${at(key, specifier)} - ${specifier.text} resolves to ${relative(target)}, which the check cannot read.`,
          )
      }
    })
  }

  // A global with a value in Node's types. Another file's interface for it adds a type only.
  const nodeOnly = (symbol) =>
    Boolean(symbol?.declarations.some((d) => valueKinds.has(d.kind) && nodeTypes.test(d.path)))
  // The parent of a global is none, or `declare global`.
  const global = (symbol) => [undefined, '__global'].includes(symbol.getParent()?.name)
  for (const key of runtime) {
    checked++
    const sourceFile = sources.get(key)
    // A local `declare` of a Node global would hide Node's from the checker.
    for (const name of declaredValues(sourceFile)) {
      if (runtimeGlobals.has(name.text)) continue
      if (nodeOnly(checker.resolveName(name.text, SymbolFlags.Value, undefined, false)))
        failures.push(
          `${at(key, name)} - this declares ${name.text}, a Node global the default runtime does not provide, and hides it from the check.`,
        )
    }
    const { identifiers } = runtimeNodes(sourceFile)
    const names = identifiers.filter(isReference)
    const symbols = names.length ? checker.getSymbolAtLocation(names) : []
    names.forEach((name, index) => {
      const parent = name.parent
      // `{ Buffer }` reads Buffer, but its symbol is the property's.
      const symbol = ts.isShorthandPropertyAssignment(parent)
        ? checker.getShorthandAssignmentValueSymbol(parent)
        : symbols[index]
      if (!symbol) {
        failures.push(`${at(key, name)} - TypeScript does not resolve ${name.text}.`)
        return
      }
      if (!nodeOnly(symbol) || !global(symbol)) return
      if (
        symbol.name === 'process' &&
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === name &&
        parent.name.text === 'env'
      )
        return
      if (symbol.name === 'process')
        failures.push(
          `${at(key, name)} - process holds only env in the default runtime, so read process.env.`,
        )
      else if (!runtimeGlobals.has(symbol.name))
        failures.push(
          `${at(key, name)} - ${symbol.name} is a Node global, which the default runtime does not provide.`,
        )
    })
  }
  // A config that holds no such file would make this pass without reading anything.
  if (!checked) failures.push(`${config} holds no convex/ file that runs in the default runtime.`)
} catch (error) {
  // Closing after a failed read can fail too, and would hide the read's error.
  await closeTypeScriptAPI(api).catch(() => {})
  throw error
}
await closeTypeScriptAPI(api)

if (failures.length) {
  // A file that several files import can fail the same way for each.
  console.error([...new Set(failures)].join('\n'))
  console.error(
    "\nCode in convex/ runs in Convex's default runtime unless its file starts with 'use node'. Use a web API, or move the code to a 'use node' file, which may hold actions only.",
  )
  process.exit(1)
}
console.log(
  `${checked} files run in Convex's default runtime and use only its globals; ${nodeFiles} run in Node.`,
)
