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
 * The bundler rules below copy those of convex 1.48, which are 1.47's: its
 * entryPoints, hasUseNodeDirective (with useNodeDirectiveRegex) and
 * mustBeIsolate in convex/src/bundler/index.ts, the schema, auth config and
 * component bundles, the names of a component's definition file, and the
 * async_hooks shim. `copiedRules` holds a hash of each function or variable
 * that code sits in, and the check fails when the installed convex declares
 * it differently. Code outside those declarations, such as the way Convex
 * finds the components a convex.config imports, is not pinned. The check
 * reads every component directory in convex/ and fails on a component
 * imported from anywhere else instead. */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { parseSync } from 'oxc-parser'
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
/* The declaration files Convex's codegen may write in convex/_generated/,
 * which describe its own JavaScript. A component's codegen writes .ts files,
 * which the check reads. */
const generatedDeclarations = ['api.d.ts', 'api_cjs.d.cts', 'dataModel.d.ts', 'server.d.ts']
// The file that makes a directory a component, as Convex names it.
const componentDefinition = /^convex\.config\.[jt]s$/
// The names through which code reaches the global object in the default runtime.
const globalObjectNames = new Set(['globalThis', 'self'])

/* The code in the convex package that the rules here copy, by file and by
 * the name of a declaration in it, with a hash from `fingerprint`. When a
 * convex update changes one, compare the new code with the copy here, update
 * the copy and then the hash. An oxc-parser update that changes the shape of
 * its syntax tree changes every hash at once. The check cannot import the
 * rules instead: convex's bundler modules import @babel/parser and
 * @sentry/node, which only its prebuilt CLI bundle holds, and that bundle
 * exports nothing. */
const copiedRules = {
  'src/bundler/index.ts': {
    walkDir: '8a120e140763d353',
    ENTRY_POINT_EXTENSIONS: '3a3910c4e93d8889',
    entryPoints: '147e0e06849b22c2',
    useNodeDirectiveRegex: 'ba9f1cedbee45cf8',
    hasUseNodeDirective: '5433c6ee94349f6a',
    mustBeIsolate: '9d3cbcf43443706f',
    determineEnvironment: 'fdaad29ce2a57daa',
    entryPointsByEnvironment: '3a3e7f1bfca916bf',
    bundleSchema: 'ec9195654bf1eaee',
    bundleAuthConfig: '389efedf323c7d5d',
  },
  'src/bundler/debugBundle.ts': { innerEsbuild: 'ee8a7c329296e6d3' },
  'src/cli/lib/components/definition/bundle.ts': {
    sharedEsbuildOptions: '1f98ab168cc32421',
    bundleImplementations: 'd664e3ea98e4b967',
  },
  'src/cli/lib/components/constants.ts': {
    DEFINITION_FILENAME_TS: '9a6d405a7ecc2396',
    DEFINITION_FILENAME_JS: '1f4a9e271ad1b0ad',
  },
}
// The pieces scripts/convex-api-modules.mjs copies too, for the module list in api.d.ts.
const apiModuleRules = new Set(['walkDir', 'ENTRY_POINT_EXTENSIONS', 'entryPoints'])

/**
 * Returns a hash of a declaration's syntax tree, parsed without its
 * parentheses, so that a change in what the code does changes it, and a
 * comment, spacing, line breaks that keep the meaning, quotes or redundant
 * parentheses do not. A line break that changes the meaning, as after a
 * bare `return`, changes the tree. Positions, a literal's written form and
 * fields at their empty default (false, null or []) are left out, so a
 * parser update that adds such a field keeps the hash.
 */
function fingerprint(node) {
  const tree = JSON.stringify(node, function (key, value) {
    if (['start', 'end', 'parent'].includes(key)) return undefined
    if (key === 'raw' && this.type === 'Literal') return undefined
    if (key !== 'value' && (value === false || value === null)) return undefined
    if (Array.isArray(value) && !value.length) return undefined
    return value
  })
  return createHash('sha256').update(tree).digest('hex').slice(0, 16)
}

/**
 * Returns why the installed convex's bundler code differs from the code the
 * rules here copy, one reason per piece, or nothing when it is the same.
 */
function copiedRulesDrift() {
  const manifest = createRequire(path.resolve('package.json')).resolve('convex/package.json')
  const convex = path.dirname(manifest)
  const { version } = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  const reasons = []
  for (const [file, pieces] of Object.entries(copiedRules)) {
    const source = path.join(convex, file)
    if (!fs.existsSync(source)) {
      reasons.push(`convex ${version} has no ${file}, whose bundler rules the check copies.`)
      continue
    }
    const text = fs.readFileSync(source, 'utf8')
    const { program, errors } = parseSync(source, text, { preserveParens: false })
    if (errors.length) {
      reasons.push(`convex ${version}'s ${file} does not parse: ${errors[0].message}`)
      continue
    }
    /* Every function and variable the file declares by name, by that name
     * after those of the declarations around it, as in innerEsbuild.nodeShimsPlugin. */
    const declared = new Map()
    const visit = (node, scope) => {
      if (Array.isArray(node)) {
        for (const child of node) visit(child, scope)
        return
      }
      if (!node || typeof node.type !== 'string') return
      let inner = scope
      if (
        (node.type === 'FunctionDeclaration' || node.type === 'VariableDeclarator') &&
        node.id?.type === 'Identifier'
      ) {
        inner = scope ? `${scope}.${node.id.name}` : node.id.name
        declared.set(inner, [...(declared.get(inner) ?? []), node])
      }
      for (const [key, value] of Object.entries(node))
        if (key !== 'parent' && value && typeof value === 'object') visit(value, inner)
    }
    visit(program, '')
    for (const [name, pinned] of Object.entries(pieces)) {
      const nodes = declared.get(name) ?? []
      if (nodes.length !== 1) {
        reasons.push(
          nodes.length
            ? `convex ${version}'s ${file} declares ${name} ${nodes.length} times, so the check cannot tell which one its rules copy.`
            : `convex ${version}'s ${file} has no ${name}, whose rules the check copies.`,
        )
        continue
      }
      const hash = fingerprint(nodes[0])
      const copies = apiModuleRules.has(name)
        ? 'scripts/check-convex-runtime.mjs and scripts/convex-api-modules.mjs'
        : 'scripts/check-convex-runtime.mjs'
      if (hash !== pinned)
        reasons.push(
          `convex ${version} changed ${name} in ${file}. Compare it with the bundler rules in ${copies}, update them, and then its hash in copiedRules to '${hash}'.`,
        )
    }
  }
  return reasons
}

/**
 * Returns the files Convex bundles for the default runtime from convex/ or a
 * component directory in it, by its bundler's rules. `entries` run in Node
 * when they say 'use node': script extensions, outside the top _generated/,
 * no leading dot or #, not schema.ts or schema.js, one dot in the name and no
 * space in the path. `isolated` always run in the default runtime. A
 * directory with a convex.config.ts is a component, bundled as a root of its
 * own. `roots` holds convex/ and those directories.
 */
function bundledFiles(root, found = { entries: [], isolated: [], roots: [] }) {
  found.roots.push(root)
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

// An update to convex that changes the rules the check copies fails it.
const drift = copiedRulesDrift()
const failures = []
const api = new API()
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
  const { entries, isolated, roots } = bundledFiles(convexDirectory)
  // By TypeScript's canonical path, as `target` below holds it.
  const canonical = (file) => program.getSourceFile(file)?.path
  const convexWritten = new Set(
    generatedDeclarations.map((name) => canonical(path.join(convexDirectory, '_generated', name))),
  )
  // The definitions of the components whose files bundledFiles found.
  const components = new Set(roots.map((root) => canonical(path.join(root, 'convex.config.ts'))))
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
        // Convex bundles the files of a component that a convex.config imports.
        if (
          componentDefinition.test(path.basename(target)) &&
          !nodeModules.test(target) &&
          !components.has(target)
        )
          failures.push(
            `${at(key, specifier)} - ${specifier.text} defines a component whose files the check does not read. Keep a component in a directory of convex/ with a convex.config.ts.`,
          )
        const imported = sources.get(target)
        if (imported) {
          const read = directive(imported)
          if (read === 'node')
            failures.push(
              `${at(key, specifier)} - ${specifier.text} starts with 'use node', and the default runtime cannot run it.`,
            )
          else if (read === 'unclear') failures.push(unclear(target))
          else add(target)
        } else if (!nodeModules.test(target) && !convexWritten.has(target))
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
  /** Tells why reading a global fails in the default runtime, if it does. `read` yields it. */
  const refusal = (symbol, read) => {
    if (!nodeOnly(symbol) || !global(symbol)) return undefined
    if (symbol.name !== 'process')
      return runtimeGlobals.has(symbol.name)
        ? undefined
        : `${symbol.name} is a Node global, which the default runtime does not provide.`
    const env =
      ts.isPropertyAccessExpression(read.parent) &&
      read.parent.expression === read &&
      read.parent.name.text === 'env'
    return env ? undefined : 'process holds only env in the default runtime, so read process.env.'
  }
  // The global object's names, through which `globalThis.Buffer` reads a global too.
  const globalObjects = new Set(
    [...globalObjectNames]
      .map((name) => checker.resolveName(name, SymbolFlags.Value, undefined, false)?.id)
      .filter((id) => id !== undefined),
  )
  // Parentheses, casts and `!` around an expression, which leave its value alone.
  const unchanged = (node) =>
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertion(node)
  for (const key of runtime) {
    checked++
    const sourceFile = sources.get(key)
    // A local `declare` of a Node global or the global object would hide it from the checker.
    for (const name of declaredValues(sourceFile)) {
      if (globalObjectNames.has(name.text)) {
        failures.push(
          `${at(key, name)} - this declares ${name.text}, the global object of the default runtime, and hides it from the check.`,
        )
        continue
      }
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
      // `{ Buffer }` reads Buffer, but its symbol is the property's.
      const symbol = ts.isShorthandPropertyAssignment(name.parent)
        ? checker.getShorthandAssignmentValueSymbol(name.parent)
        : symbols[index]
      if (!symbol) {
        failures.push(`${at(key, name)} - TypeScript does not resolve ${name.text}.`)
        return
      }
      const reason = refusal(symbol, name)
      if (reason) failures.push(`${at(key, name)} - ${reason}`)
      if (!globalObjects.has(symbol.id)) return
      /* The global object may only be read from by name, as in
       * `globalThis.URL`. Any other use, such as `const g = globalThis` or
       * `const { Buffer } = globalThis`, would let a global through unseen.
       * A name read from it that is the global object again, as in
       * `globalThis.self`, holds to the same rule. */
      let object = name
      for (;;) {
        while (unchanged(object.parent) && object.parent.expression === object)
          object = object.parent
        const member = object.parent
        let global
        if (ts.isPropertyAccessExpression(member) && member.expression === object) {
          if (!ts.isIdentifier(member.name)) return
          global = member.name
        } else if (ts.isElementAccessExpression(member) && member.expression === object) {
          global = member.argumentExpression
          if (!ts.isStringLiteral(global) && !ts.isNoSubstitutionTemplateLiteral(global)) {
            failures.push(
              `${at(key, global)} - this reads a global named at runtime, which the check cannot follow. Name it with a string.`,
            )
            return
          }
        } else {
          failures.push(
            `${at(key, object)} - this passes on the global object, which the check cannot follow. Read each global from it by name, as in globalThis.URL.`,
          )
          return
        }
        // In the default runtime, whether the program declares the name or not.
        if (globalObjectNames.has(global.text)) {
          object = member
          continue
        }
        const read = checker.resolveName(global.text, SymbolFlags.Value, undefined, false)
        const reason = read && refusal(read, member)
        if (reason) failures.push(`${at(key, global)} - ${reason}`)
        return
      }
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
}
if (drift.length) {
  if (failures.length) console.error('')
  console.error(drift.join('\n'))
  console.error(
    "\nThe check copies these rules of Convex's bundler, so until the copy matches the installed convex it may misjudge which files run in the default runtime.",
  )
}
if (failures.length || drift.length) process.exit(1)
console.log(
  `${checked} files run in Convex's default runtime and use only its globals; ${nodeFiles} run in Node.`,
)
