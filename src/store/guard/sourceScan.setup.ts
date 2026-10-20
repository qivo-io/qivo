import { readFileSync } from 'node:fs'
import { parseSync } from 'oxc-parser'

/* A small walk over a source file's ESTree (oxc-parser), for the store's
   layer guard (layerGuard.test.ts). Every node is visited with its
   ancestors, innermost last. */

/** An ESTree node as oxc-parser returns it. */
export type AstNode = { type: string; start: number; end: number; [key: string]: unknown }

const isNode = (value: unknown): value is AstNode =>
  !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'

/** Parses `path` and answers its source and program. */
export function parseFile(path: string) {
  const source = readFileSync(path, 'utf8')
  const { program, errors } = parseSync(path, source)
  if (errors.length) throw new Error(`${path} does not parse: ${errors[0].message}`)
  return { source, program: program as unknown as AstNode }
}

/** Calls `visit` on every node under `root` with its ancestors. */
export function walk(root: AstNode, visit: (node: AstNode, ancestors: AstNode[]) => void) {
  const stack: AstNode[] = []
  const step = (node: AstNode) => {
    visit(node, stack)
    stack.push(node)
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) step(item)
      } else if (isNode(value)) step(value)
    }
    stack.pop()
  }
  step(root)
}

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
/* Nodes a value passes through unchanged on its way to a name. */
const THROUGH = new Set([
  'ParenthesizedExpression',
  'ConditionalExpression',
  'LogicalExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'AwaitExpression',
])

/** The name of a key: an identifier's, or a string literal's. */
const keyName = (key: unknown) =>
  isNode(key) ? String(key.type === 'Identifier' ? key.name : (key.value ?? '')) : ''

/** The name `fn` (a function node with its ancestors) is known by: a
    declaration's own, the variable or property it is the value of, also
    through a wrapper call such as withUpdateBlock(async () => ...), or ''. */
export function functionName(fn: AstNode, ancestors: AstNode[]): string {
  if (fn.type === 'FunctionDeclaration') return keyName(fn.id)
  let at = ancestors.length - 1
  let child = fn
  while (at >= 0 && THROUGH.has(ancestors[at].type)) child = ancestors[at--]
  const parent = ancestors[at]
  if (!parent) return ''
  if (parent.type === 'VariableDeclarator') return keyName(parent.id)
  if (parent.type === 'Property' || parent.type === 'MethodDefinition') return keyName(parent.key)
  // a wrapper call that is itself a variable's or a property's value
  if (parent.type === 'CallExpression' && (parent.arguments as AstNode[]).includes(child)) {
    const holder = ancestors[at - 1]
    if (holder?.type === 'VariableDeclarator') return keyName(holder.id)
    if (holder?.type === 'Property') return keyName(holder.key)
  }
  return ''
}

/** The functions around a node, innermost first, each with its name. */
export function enclosing(ancestors: AstNode[]): { fn: AstNode; name: string; at: number }[] {
  const out: { fn: AstNode; name: string; at: number }[] = []
  for (let at = ancestors.length - 1; at >= 0; at--) {
    const fn = ancestors[at]
    if (FUNCTIONS.has(fn.type)) out.push({ fn, name: functionName(fn, ancestors.slice(0, at)), at })
  }
  return out
}

/** The innermost named function around a node, or ''. */
export const ownerName = (ancestors: AstNode[]) =>
  enclosing(ancestors).find((f) => f.name)?.name ?? ''

/** The source text of `node`. */
export const textOf = (source: string, node: AstNode) => source.slice(node.start, node.end)

/** The Convex function names (`module:name`) a node's text refers to as api.module.name. */
export const apiNames = (text: string) =>
  [...text.matchAll(/\bapi\.(\w+)\.(\w+)\b/g)].map(([, module, name]) => `${module}:${name}`)
