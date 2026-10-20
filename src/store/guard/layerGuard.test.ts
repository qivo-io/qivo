import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture } from '../plannerFixture.setup'
import {
  type AstNode,
  apiNames,
  enclosing,
  ownerName,
  parseFile,
  textOf,
  walk,
} from './sourceScan.setup'
import { recipes } from './writeRecipes.setup'

// the probes below boot the store over a Convex double
const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../../lib/convex', () => ({ convex: network }))
vi.mock('../../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

/* The guard that every store write paints through its own layer
   (store/layers.ts, store/planner.ts send). The source checks read the
   store with oxc-parser; the probes break the rules on purpose, so the
   store's own check (checkLayers) is seen to catch them. */

const STORE = 'src/store/planner.ts'
const { source, program } = parseFile(STORE)

type Call = { node: AstNode; ancestors: AstNode[] }
const calls: Call[] = []
walk(program, (node, ancestors) => {
  if (node.type === 'CallExpression') calls.push({ node, ancestors: [...ancestors] })
})
const callee = (call: Call) => textOf(source, call.node.callee as AstNode)
const firstArgument = (call: Call) => {
  const first = (call.node.arguments as AstNode[])[0]
  return first ? textOf(source, first) : ''
}

/* Functions whose job is building or painting rows: the anchors' builders,
   disposal, and the paint helpers a layer's paint calls. */
const PAINT_HELPERS = new Set([
  'buildRows',
  'buildThreadRows',
  'disposeDemoStore',
  'purgeIssueRows',
  'dropProjectRows',
  'dropDeletedTasks',
  'markLoadedMessagesRead',
  'patchIssueRow',
  'clearParentHours',
  // the probe below breaks the rule on purpose
  'writeOutside',
])
const ROW_CHANGES = new Set(['set', 'delete', 'push', 'splice', 'clear', 'add', 'unshift', 'pop'])
const THROUGH = new Set(['ParenthesizedExpression', 'ConditionalExpression', 'LogicalExpression'])

/** Whether the function at `at` among `ancestors`, named `name`, paints a
    layer: the value of a `workspace` or `paint` property, one whose name
    ends in Paint, or returned from one. */
function paints(ancestors: AstNode[], at: number, name: string): boolean {
  if (name.endsWith('Paint')) return true
  let up = at - 1
  while (up >= 0 && THROUGH.has(ancestors[up].type)) up--
  const holder = ancestors[up]
  if (!holder) return false
  if (holder.type === 'Property') {
    const key = textOf(source, holder.key as AstNode)
    if (key === 'workspace' || key === 'paint') return true
  }
  const returned = holder.type === 'ReturnStatement' || holder.type === 'ArrowFunctionExpression'
  const outer = enclosing(ancestors.slice(0, holder.type === 'ReturnStatement' ? up : up + 1))[0]
  return returned && !!outer?.name.endsWith('Paint')
}

describe('the store sends every write through one door', () => {
  it('calls convex.mutation only in dispatch, dispatch only in start, start only in send', () => {
    const owners = (name: string) =>
      calls.filter((call) => callee(call) === name).map((call) => ownerName(call.ancestors))
    expect(new Set(owners('convex.mutation'))).toEqual(new Set(['dispatch']))
    expect(new Set(owners('dispatch'))).toEqual(new Set(['start']))
    expect(new Set(owners('start'))).toEqual(new Set(['send', 'sendAwaited']))
    // and nothing else in the store reaches Convex's write paths
    const direct = calls.filter((call) => /^convex\.(action|mutation)$/.test(callee(call)))
    expect(direct).toHaveLength(1)
  })

  it('changes row sections only inside a paint or a row builder', () => {
    const outside: string[] = []
    walk(program, (node, ancestors) => {
      let section: AstNode | null = null
      if (node.type === 'AssignmentExpression') section = node.left as AstNode
      else if (
        node.type === 'CallExpression' &&
        (node.callee as AstNode).type === 'MemberExpression'
      ) {
        const member = node.callee as AstNode
        if (ROW_CHANGES.has(textOf(source, member.property as AstNode)))
          section = member.object as AstNode
      }
      if (!section || !/^rows\.\w+$/.test(textOf(source, section))) return
      const allowed = enclosing(ancestors).some(
        ({ name, at }) => PAINT_HELPERS.has(name) || paints(ancestors, at, name),
      )
      if (!allowed) {
        const line = source.slice(0, node.start).split('\n').length
        outside.push(`${STORE}:${line} ${textOf(source, node).split('\n')[0]}`)
      }
    })
    expect(outside).toEqual([])
  })
})

describe('every write has a recipe', () => {
  const sends = calls
    .filter((call) => callee(call) === 'send' || callee(call) === 'sendAwaited')
    .map((call) => ({ names: apiNames(firstArgument(call)), mutator: ownerName(call.ancestors) }))
  const sent = new Set(sends.flatMap((s) => s.names))

  it('names one or more mutations in every send', () => {
    expect(sends.filter((s) => !s.names.length)).toEqual([])
    // the inventory found 78 call sites; new ones add recipes
    expect(sends.length).toBeGreaterThanOrEqual(78)
  })

  it('has a recipe for every mutation sent, and sends every recipe’s mutation', () => {
    const recipeNames = new Set(recipes.map((r) => r.mutation))
    expect([...sent].filter((name) => !recipeNames.has(name))).toEqual([])
    expect([...recipeNames].filter((name) => !sent.has(name))).toEqual([])
  })

  it('names in a recipe every function that sends a write', () => {
    const mutators = new Set(recipes.map((r) => r.mutator))
    expect([...new Set(sends.map((s) => s.mutator))].filter((m) => !mutators.has(m))).toEqual([])
    // and each recipe's mutator sends its mutation
    for (const recipe of recipes)
      expect(
        sends.some((s) => s.mutator === recipe.mutator && s.names.includes(recipe.mutation)),
        recipe.what,
      ).toBe(true)
  })
})

describe('Convex writes outside the store', () => {
  /* Each one, with the reason it does not go through the store. The admin
     console (src/admin/) has its own client flows and no store at all. */
  const ALLOWED: Record<string, string[]> = {
    // the no-seat screen creates the home organization before the store boots
    'src/AuthGate.tsx': ['identity:createOrganization'],
    // a demo is set up before its store boots
    'src/DemoGate.tsx': ['demo:ensureMine'],
    // these act on their own live queries, not on the snapshot (planner.ts
    // snapshot health), so they do not pause or paint
    'src/panels/OrganizationDeletion.tsx': ['orgRemovals:keep', 'orgRemovals:request'],
    'src/panels/OrganizationExport.tsx': ['orgRemovals:recordExport'],
    'src/panels/BillingSettings.tsx': [
      'billing:usageReport',
      'billingActions:cancelSubscription',
      'billingActions:checkout',
      'billingActions:portal',
    ],
  }
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory())
        return path === 'src/store' || path === 'src/admin' ? [] : files(path)
      return /\.tsx?$/.test(name) && !/\.(test|setup)\.tsx?$/.test(name) ? [path] : []
    })

  it('match the allowlist', () => {
    const found: Record<string, string[]> = {}
    for (const path of files('src')) {
      const parsed = parseFile(path)
      walk(parsed.program, (node) => {
        if (node.type !== 'CallExpression') return
        const target = node.callee as AstNode
        if (target.type !== 'MemberExpression') return
        const verb = textOf(parsed.source, target.property as AstNode)
        if (verb !== 'mutation' && verb !== 'action') return
        if (!/\bconvex\b/.test(textOf(parsed.source, target.object as AstNode))) return
        const first = (node.arguments as AstNode[])[0]
        found[path] = [
          ...(found[path] ?? []),
          ...apiNames(first ? textOf(parsed.source, first) : ''),
        ]
      })
    }
    for (const list of Object.values(found)) list.sort()
    for (const list of Object.values(ALLOWED)) list.sort()
    expect(found).toEqual(ALLOWED)
  })
})

describe('the store catches a paint that breaks the rules', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function boot() {
    vi.resetModules()
    vi.useFakeTimers()
    vi.stubGlobal('window', { showToast: vi.fn() })
    const snap = plannerFixture()
    snap.issues.push({
      id: 'task-a',
      org_id: snap.orgs[0].id,
      project_id: snap.projects[0].id,
      num: 1,
      title: 'Probe',
      description: '',
      status: 'todo',
      priority: 'low',
      paused: false,
      created_at: '2026-09-14T08:00:00.000Z',
      updated_at: '2026-09-14T08:00:00.000Z',
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    network.query.mockResolvedValue(null)
    network.mutation.mockResolvedValue(null)
    network.onUpdate.mockImplementation((_ref, _args, receive) => {
      receive(structuredClone(snap))
      return () => {}
    })
    const store = await import('../planner')
    await store.initStore()
    if (!store.__layerProbe) throw new Error('the layer probe is test-only')
    return store.__layerProbe
  }

  it('throws when a row changes outside a layer', async () => {
    const probe = await boot()
    expect(() => probe.writeOutside()).toThrow('rows changed outside a layer')
  })

  it('throws when a paint reads the clock', async () => {
    const probe = await boot()
    expect(() => probe.paintClock()).toThrow('a paint read the clock')
  })
})
