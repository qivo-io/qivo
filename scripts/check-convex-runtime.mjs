/* Fails when code in convex/ that runs in Convex's default runtime uses a
 * global or a module that only Node provides. Most Convex functions run in a
 * V8 isolate, and only the files that start with 'use node' run in Node. The
 * convex/ program holds both kinds, and with them Node's types (sharp's
 * types and the generated api.d.ts, which imports every module, bring them
 * in), so tsc accepts Buffer, require or a `node:` import in any file there.
 *
 * This reads the convex/ program with TypeScript's checker and, in each file
 * that runs in the default runtime, resolves every name and module. A name
 * declared only by Node's types (@types/node and the undici-types it uses)
 * must be one of the runtime's globals below, and `process` may only be read
 * as `process.env`. A module declared only by Node's types fails. The
 * 'use node' files, the files that only they import and the tests keep
 * Node's globals. */
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
const config = path.resolve('convex/tsconfig.json')
const convexDirectory = path.dirname(config) + path.sep
const nodeTypes = /[/\\]node_modules[/\\](?:@types[/\\]node|undici-types)[/\\]/
// vitest runs these in Node, and Convex skips them because of the second dot.
const testFile = /[/\\]convex[/\\]tests[/\\]|\.test\.[cm]?tsx?$/

/** Tells whether a file's directive prologue holds 'use node', as Convex reads it. */
function usesNode(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break
    if (statement.expression.text === 'use node') return true
  }
  return false
}

/** Returns the string literals that name a module in a file, imported or exported. */
function moduleSpecifiers(sourceFile) {
  const specifiers = []
  const visit = (node) => {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
          ? node.moduleReference.expression
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
              ? node.argument.literal
              : undefined
    if (specifier && ts.isStringLiteral(specifier)) specifiers.push(specifier)
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return specifiers
}

/** Returns a file's identifiers, the names it reads and declares. */
function identifiers(sourceFile) {
  const found = []
  const visit = (node) => {
    if (ts.isIdentifier(node)) found.push(node)
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return found
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
  for (const file of program.getSourceFileNames()) {
    const resolved = path.resolve(file)
    if (!resolved.startsWith(convexDirectory) || nodeTypes.test(resolved)) continue
    const sourceFile = program.getSourceFile(file)
    if (!sourceFile) throw new Error(`TypeScript could not read ${file}`)
    // Declaration files, such as the generated api.d.ts, never run.
    if (!sourceFile.isDeclarationFile) sources.set(resolved, sourceFile)
  }

  // A module symbol's declaration is the file it resolves to.
  const imports = new Map()
  const importers = new Map([...sources.keys()].map((file) => [file, new Set()]))
  for (const [file, sourceFile] of sources) {
    const specifiers = moduleSpecifiers(sourceFile)
    const modules = specifiers.length ? checker.getSymbolAtLocation(specifiers) : []
    imports.set(
      file,
      specifiers.map((specifier, index) => ({ specifier, module: modules[index] })),
    )
    for (const module of modules)
      for (const declaration of module?.declarations ?? [])
        importers.get(path.resolve(declaration.path))?.add(file)
  }

  // Node runs the 'use node' files and the files that only they import.
  const node = new Set(
    [...sources].filter(([, sourceFile]) => usesNode(sourceFile)).map(([f]) => f),
  )
  for (let grew = true; grew; ) {
    grew = false
    for (const [file, from] of importers) {
      const runtimeImporters = [...from].filter((importer) => !testFile.test(importer))
      if (
        !node.has(file) &&
        runtimeImporters.length &&
        runtimeImporters.every((importer) => node.has(importer))
      ) {
        node.add(file)
        grew = true
      }
    }
  }
  nodeFiles = node.size

  const nodeOnly = (symbol) =>
    Boolean(symbol?.declarations.length) &&
    symbol.declarations.every((declaration) => nodeTypes.test(declaration.path))
  // A member, such as Request's headers, belongs to its global. The parent
  // of a global is none, or `declare global`.
  const global = (symbol) => [undefined, '__global'].includes(symbol.getParent()?.name)
  for (const [file, sourceFile] of sources) {
    if (node.has(file) || testFile.test(file)) continue
    checked++
    const relative = path.relative(process.cwd(), file)
    const at = (node) => {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      )
      return `${relative}:${line + 1}:${character + 1}`
    }
    for (const { specifier, module } of imports.get(file))
      if (nodeOnly(module))
        failures.push(
          `${at(specifier)} - ${specifier.text} is a Node module, which the default runtime does not provide.`,
        )
    const names = identifiers(sourceFile)
    const symbols = names.length ? checker.getSymbolAtLocation(names) : []
    symbols.forEach((symbol, index) => {
      if (!nodeOnly(symbol) || !global(symbol)) return
      const name = names[index]
      const parent = name.parent
      if (
        symbol.name === 'process' &&
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === name &&
        parent.name.text === 'env'
      )
        return
      if (symbol.name === 'process')
        failures.push(
          `${at(name)} - process holds only env in the default runtime, so read process.env.`,
        )
      else if (!runtimeGlobals.has(symbol.name))
        failures.push(
          `${at(name)} - ${symbol.name} is a Node global, which the default runtime does not provide.`,
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
  `${checked} convex/ files use only the default runtime's globals; ${nodeFiles} run in Node.`,
)
