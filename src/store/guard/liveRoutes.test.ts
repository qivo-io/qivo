import { readdirSync, readFileSync, statSync } from 'node:fs'
import { posix } from 'node:path'
import { parseSync } from 'oxc-parser'
import { describe, expect, it } from 'vitest'
import { type AstNode, textOf, walk } from './sourceScan.setup'

/* One path per query (lib/liveQueries.ts, lib/liveView.ts). A live watch
   that comes second to a convex.onUpdate listener of the same query shares
   its Convex subscription and hears nothing until the answer changes
   (lib/convexOrdering.test.ts pins that), so a view would show Loading for
   good. convex.onUpdate may hold only the queries ON_UPDATE lists, each
   named in src/ only as such a listener's first argument, a one-shot
   read's or a type, so none is also read through watchLive, useLiveView,
   useLiveViews, useKeptLiveView, the paged lists' `query`, the live parts'
   watchSide or live.watch. The admin console's useLiveQuery
   (admin/views/Backgrounds.tsx) is convex.onUpdate under another name. */

/** The queries convex.onUpdate may hold, each with its reader. */
const ON_UPDATE = new Map([
  ['appearance:dailyImage', "the week's image, the appearance provider's"],
  ['billing:status', 'the read-only banner over every main page'],
  ['demo:current', "the demo's lifecycle"],
  ['teamSync:lastComments', "Team sync's last comments, the store's"],
  ['panoramaImages:library', 'the admin console'],
  ['panoramaImages:calendar', 'the admin console'],
  ['panoramaImages:summary', 'the admin console'],
  ['panoramaCuration:libraryImage', 'the admin console'],
  ['panoramaCuration:submissions', 'the admin console'],
  ['panoramaCuration:keys', 'the admin console'],
])

/** Calls that hold a query through convex.onUpdate: `.onUpdate(` and the
    admin console's wrapper. */
const isHolder = (callee: string) => callee.endsWith('.onUpdate') || callee === 'useLiveQuery'
/** One-shot reads, which hold no subscription past their answer. */
const isOneShot = (callee: string) => callee.endsWith('.query')
/** The function that wraps convex.onUpdate for a query it is handed. */
const WRAPPER = 'useLiveQuery'

/** What breaks the rule in source `source` of file `path`, one line each. */
function routeProblems(path: string, source: string): string[] {
  const { program, errors } = parseSync(path, source)
  if (errors.length) return [`${path} does not parse: ${errors[0].message}`]
  const problems: string[] = []
  const held = new Set<AstNode>()
  const line = (node: AstNode) => source.slice(0, node.start).split('\n').length
  walk(program as unknown as AstNode, (node, ancestors) => {
    if (node.type !== 'CallExpression') return
    const callee = textOf(source, node.callee as AstNode)
    const first = (node.arguments as AstNode[])[0]
    if (!first) return
    const named = /^api\.(\w+)\.(\w+)$/.exec(textOf(source, first))
    if (isHolder(callee)) {
      held.add(first)
      if (named) {
        const name = `${named[1]}:${named[2]}`
        if (!ON_UPDATE.has(name))
          problems.push(`${path}:${line(node)} holds ${name} through convex.onUpdate`)
        return
      }
      // the wrapper's own call, with the query it was handed
      const inWrapper = ancestors.some(
        (a) => a.type === 'FunctionDeclaration' && (a.id as AstNode | null)?.name === WRAPPER,
      )
      if (!inWrapper)
        problems.push(`${path}:${line(node)} holds a computed query through convex.onUpdate`)
    } else if (isOneShot(callee)) held.add(first)
  })
  walk(program as unknown as AstNode, (node) => {
    if (node.type !== 'MemberExpression' || held.has(node)) return
    const named = /^api\.(\w+)\.(\w+)$/.exec(textOf(source, node))
    if (!named) return
    const name = `${named[1]}:${named[2]}`
    if (ON_UPDATE.has(name))
      problems.push(`${path}:${line(node)} reads ${name}, which convex.onUpdate holds, another way`)
  })
  return problems
}

/* The app's source files, tests and test setups left out. */
function sources(dir = 'src'): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = posix.join(dir, entry)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry) && !/\.(test|setup)\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')
      ? [path]
      : []
  })
}

describe('one path per query', () => {
  it('holds through convex.onUpdate only the queries its list names, read no other way', () => {
    const problems = sources().flatMap((path) => routeProblems(path, readFileSync(path, 'utf8')))
    expect(problems).toEqual([])
  })

  it('lists no query that no convex.onUpdate listener holds', () => {
    const named = new Set<string>()
    for (const path of sources()) {
      const source = readFileSync(path, 'utf8')
      for (const match of source.matchAll(/(?:\.onUpdate|useLiveQuery)\(\s*api\.(\w+)\.(\w+)/g))
        named.add(`${match[1]}:${match[2]}`)
    }
    expect([...ON_UPDATE.keys()].filter((name) => !named.has(name))).toEqual([])
  })

  it('fails a query held through convex.onUpdate and read on the live transport beside it', () => {
    const planted = `
      convex.onUpdate(api.billing.details, { org_id }, take)
      const details = useKeptLiveView(api.billing.details, key)`
    expect(routeProblems('planted.tsx', planted)).toEqual([
      'planted.tsx:2 holds billing:details through convex.onUpdate',
    ])
    const listed = `
      convex.onUpdate(api.billing.status, { org_id }, take)
      watchLive(api.billing.status, { org_id }, take)
      parts.watchSide('summary', api.billing.status, {})
      void convex.query(api.billing.status, { org_id })`
    expect(routeProblems('listed.tsx', listed)).toEqual([
      'listed.tsx:3 reads billing:status, which convex.onUpdate holds, another way',
      'listed.tsx:4 reads billing:status, which convex.onUpdate holds, another way',
    ])
  })

  it('fails a computed query held through convex.onUpdate outside the admin wrapper', () => {
    const planted = `
      function watchAny(ref) { return convex.onUpdate(ref, {}, take) }
      function useLiveQuery(query, args) { return convex.onUpdate(query, args, take) }`
    expect(routeProblems('computed.ts', planted)).toEqual([
      'computed.ts:2 holds a computed query through convex.onUpdate',
    ])
  })
})
