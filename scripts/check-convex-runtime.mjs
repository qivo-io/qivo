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
 * them with TypeScript's checker. A name read at runtime that only Node's
 * types (@types/node and the undici-types it uses) declare must be one of
 * the runtime's globals below, and `process` may only be read as
 * `process.env`. A runtime import of a Node module or of a 'use node' file
 * fails. Types are erased, so type positions and `import type` may name
 * Node's types. Tests, which Convex skips, keep Node's globals. */
import fs from 'node:fs'
import path from 'node:path'
import * as ts from 'typescript/unstable/ast'
import { API } from 'typescript/unstable/sync'
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
/* Files Convex reads from convex/ apart from its entry points, and bundles
 * for the default runtime too. */
const configFiles = new Set(['schema', 'auth.config', 'convex.config'])
// The extensions esbuild may take an entry point from, in Convex's bundler.
const entryExtensions = /\.(?:[cm]?[jt]s|[jt]sx)$/
/* Convex's bundler replaces these modules in the default runtime with the
 * two globals of the same names. */
const asyncHooks = /^(?:node:)?async_hooks$/
const asyncHooksExports = new Set(['AsyncLocalStorage', 'AsyncResource'])
const config = path.resolve('convex/tsconfig.json')
const convexDirectory = path.dirname(config)
const nodeTypes = /[/\\]node_modules[/\\](?:@types[/\\]node|undici-types)[/\\]/

/**
 * Returns the files in convex/ that Convex bundles for the default runtime
 * unless they say 'use node', by the rules of its bundler's entryPoints:
 * script extensions, outside _generated, no leading dot or #, no space in
 * the path and one dot in the name, plus the config files it bundles apart.
 */
function bundledFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory())
      return ['_generated', 'node_modules'].includes(entry.name) ? [] : bundledFiles(file)
    const name = entry.name.replace(/\.[^.]+$/, '')
    return entryExtensions.test(entry.name) &&
      !/^[.#]/.test(entry.name) &&
      !path.relative(convexDirectory, file).includes(' ') &&
      (!name.includes('.') || configFiles.has(name))
      ? [file]
      : []
  })
}

/** Tells whether a file's directive prologue holds 'use node', as Convex reads it. */
function usesNode(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break
    if (statement.expression.text === 'use node') return true
  }
  return false
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
 * Returns the imports and exports of a file that stay in its JavaScript,
 * with the declaration that names each module. The config sets
 * verbatimModuleSyntax, so only `import type`, `export type` and import
 * types are erased.
 */
function runtimeImports(sourceFile) {
  const found = []
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword)
        found.push({ specifier: node.moduleSpecifier, declaration: node })
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && !node.isTypeOnly)
        found.push({ specifier: node.moduleSpecifier, declaration: node })
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference))
        found.push({ specifier: node.moduleReference.expression, declaration: node })
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      found.push({ specifier: node.arguments[0], declaration: node })
    }
    if (!erased(node)) node.forEachChild(visit)
  }
  visit(sourceFile)
  return found.filter(({ specifier }) => specifier && ts.isStringLiteral(specifier))
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
 * Returns the identifiers a file reads or declares at runtime, outside the
 * erased code. Imports are left to runtimeImports.
 */
function runtimeIdentifiers(sourceFile) {
  const found = []
  const visit = (node) => {
    if (ts.isIdentifier(node)) found.push(node)
    else if (ts.isExpressionWithTypeArguments(node)) {
      // A class's extends clause or an instantiation expression runs, its
      // type arguments do not. An implements clause is erased whole.
      if (node.parent.token !== ts.SyntaxKind.ImplementsKeyword) visit(node.expression)
    } else if (!erased(node) && !ts.isImportDeclaration(node)) node.forEachChild(visit)
  }
  visit(sourceFile)
  return found
}

/**
 * Tells whether an identifier names something to look up, as opposed to a
 * property, a label or a declaration's own name, which the checker may
 * leave without a symbol. A shorthand property is both, and reads a name.
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
  const sources = new Map()
  let nodeTypesLoaded = false
  for (const file of program.getSourceFileNames()) {
    const resolved = path.resolve(file)
    if (nodeTypes.test(resolved)) nodeTypesLoaded = true
    if (/[/\\]node_modules[/\\]/.test(resolved)) continue
    const sourceFile = program.getSourceFile(file)
    if (!sourceFile) throw new Error(`TypeScript could not read ${file}`)
    // Declaration files, such as the generated api.d.ts, never run.
    if (!sourceFile.isDeclarationFile) sources.set(resolved, sourceFile)
  }
  // Without Node's types no name resolves to them, and every file would pass.
  if (!nodeTypesLoaded) throw new Error(`${config} does not load Node's types`)
  for (const sourceFile of sources.values()) if (usesNode(sourceFile)) nodeFiles++

  // Convex's entry points and config files, then what they import at runtime.
  const runtime = new Set()
  const pending = []
  const at = (file, node) => {
    const sourceFile = sources.get(file)
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    return `${path.relative(process.cwd(), file)}:${line + 1}:${character + 1}`
  }
  for (const file of bundledFiles(convexDirectory)) {
    const sourceFile = sources.get(file)
    if (!sourceFile) failures.push(`${path.relative(process.cwd(), file)} is not in ${config}.`)
    else if (!usesNode(sourceFile)) pending.push(file)
  }
  for (const file of pending) runtime.add(file)
  while (pending.length) {
    const file = pending.pop()
    const found = runtimeImports(sources.get(file))
    const modules = found.length ? checker.getSymbolAtLocation(found.map((i) => i.specifier)) : []
    found.forEach(({ specifier, declaration }, index) => {
      const declarations = modules[index]?.declarations ?? []
      // A module TypeScript cannot resolve would escape every check here.
      if (!declarations.length)
        failures.push(`${at(file, specifier)} - TypeScript does not resolve ${specifier.text}.`)
      if (declarations.length && declarations.every((d) => nodeTypes.test(d.path))) {
        if (!asyncHooks.test(specifier.text))
          failures.push(
            `${at(file, specifier)} - ${specifier.text} is a Node module, which the default runtime does not provide.`,
          )
        else if (!takesShimmedAsyncHooks(declaration))
          failures.push(
            `${at(file, specifier)} - the default runtime's ${specifier.text} holds only AsyncLocalStorage and AsyncResource, so import them by name.`,
          )
        return
      }
      for (const { path: target } of declarations) {
        const imported = sources.get(path.resolve(target))
        if (!imported) continue
        if (usesNode(imported))
          failures.push(
            `${at(file, specifier)} - ${specifier.text} starts with 'use node', and the default runtime cannot run it.`,
          )
        else if (!runtime.has(path.resolve(target))) {
          runtime.add(path.resolve(target))
          pending.push(path.resolve(target))
        }
      }
    })
  }

  const nodeOnly = (symbol) =>
    Boolean(symbol?.declarations.length) &&
    symbol.declarations.every((declaration) => nodeTypes.test(declaration.path))
  // A member, such as Request's headers, belongs to its global. The parent
  // of a global is none, or `declare global`.
  const global = (symbol) => [undefined, '__global'].includes(symbol.getParent()?.name)
  for (const file of runtime) {
    checked++
    const names = runtimeIdentifiers(sources.get(file))
    const symbols = names.length ? checker.getSymbolAtLocation(names) : []
    names.forEach((name, index) => {
      const parent = name.parent
      // `{ Buffer }` reads Buffer, but its symbol is the property's.
      const symbol =
        ts.isShorthandPropertyAssignment(parent) && parent.name === name
          ? checker.getShorthandAssignmentValueSymbol(parent)
          : symbols[index]
      if (!symbol) {
        if (isReference(name))
          failures.push(`${at(file, name)} - TypeScript does not resolve ${name.text}.`)
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
          `${at(file, name)} - process holds only env in the default runtime, so read process.env.`,
        )
      else if (!runtimeGlobals.has(symbol.name))
        failures.push(
          `${at(file, name)} - ${symbol.name} is a Node global, which the default runtime does not provide.`,
        )
    })
  }
  // A config that holds no such file would make this pass without reading anything.
  if (!checked) failures.push(`${config} holds no convex/ file that runs in the default runtime.`)
} finally {
  await closeTypeScriptAPI(api)
}

if (failures.length) {
  console.error(failures.join('\n'))
  console.error(
    "\nCode in convex/ runs in Convex's default runtime unless its file starts with 'use node'. Use a web API, or move the code to a 'use node' file, which may hold actions only.",
  )
  process.exit(1)
}
console.log(
  `${checked} files run in Convex's default runtime and use only its globals; ${nodeFiles} run in Node.`,
)
