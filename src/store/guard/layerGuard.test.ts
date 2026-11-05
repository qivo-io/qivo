import { readdirSync, readFileSync, statSync } from 'node:fs'
import { posix } from 'node:path'
import { parseSync } from 'oxc-parser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture } from '../plannerFixture.setup'
import {
  type AstNode,
  apiNames,
  enclosing,
  functionName,
  ownerName,
  parseFile,
  textOf,
  walk,
} from './sourceScan.setup'
import { recipes } from './writeRecipes.setup'

// the probes below boot the store over a Convex double
const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../../lib/convex', async () => ({
  convex: network,
  live: (await import('./liveDouble.setup')).liveOver(network),
}))
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

/* The whole-list walks of the workspace's tasks and of their rows. */
const WALKS = [
  /\bP\.issues\b/,
  /\bPLANNER\.issues\b/,
  /\bscopedIssues\b/,
  /\brows\.issues\.(?!get\(|has\()/,
  /\brows\.issueLabels\b/,
  /\brows\.attachments\.values\(/,
  /\brows\.issueSubs\b/,
  /peekList\('issue(Subs|Labels)'\)/,
]

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
  'buildThreadRows',
  'countInbox',
  'disposeDemoStore',
  'purgeIssueRows',
  'dropProjectRows',
  'dropDeletedTasks',
  'markLoadedMessagesRead',
  'patchIssueRow',
  'clearParentHours',
  'paintDescriptionImages',
  // the probes below break the rule on purpose
  'writeOutside',
  'writeServerRow',
  'corruptTask',
])
/** Whether call `node` is a Convex write: `.mutation(` or `.action(` on an
    object whose text names `convex`, however it is written (convex?.mutation,
    (convex as T).mutation, convex['mutation']). */
function writesThroughConvex(text: string, node: AstNode): boolean {
  let target = node.callee as AstNode
  while (target.type === 'ChainExpression' || target.type === 'ParenthesizedExpression')
    target = target.expression as AstNode
  if (target.type !== 'MemberExpression') return false
  const property = target.property as AstNode
  const verb = property.type === 'Literal' ? String(property.value) : textOf(text, property)
  return (
    (verb === 'mutation' || verb === 'action') &&
    /\bconvex\b/.test(textOf(text, target.object as AstNode))
  )
}

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
    // and nothing else in the store reaches Convex's write paths, however
    // the call is written
    const direct = calls.filter((call) => writesThroughConvex(source, call.node))
    expect(direct.map((call) => ownerName(call.ancestors))).toEqual(['dispatch'])
  })

  it('has no other store file that writes to Convex', () => {
    const others = readdirSync('src/store')
      .filter((name) => /\.tsx?$/.test(name) && !/\.(test|setup)\.tsx?$/.test(name))
      .map((name) => posix.join('src/store', name))
      .filter((path) => path !== STORE)
    const found: string[] = []
    for (const path of others) {
      const parsed = parseFile(path)
      walk(parsed.program, (node) => {
        if (node.type === 'CallExpression' && writesThroughConvex(parsed.source, node))
          found.push(`${path}: ${textOf(parsed.source, node).split('\n')[0]}`)
      })
    }
    expect(found).toEqual([])
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
    // the store's inventory found 78 call sites; there are more now
    expect(sends.length).toBeGreaterThanOrEqual(78)
  })

  it('has a recipe for every mutation sent, and sends every recipe’s mutation', () => {
    const recipeNames = new Set(recipes.map((r) => r.mutation))
    expect([...sent].filter((name) => !recipeNames.has(name))).toEqual([])
    expect([...recipeNames].filter((name) => !sent.has(name))).toEqual([])
  })

  it('has a recipe for every function and mutation it sends', () => {
    const covered = new Set(recipes.map((r) => `${r.mutator} ${r.mutation}`))
    const pairs = new Set(sends.flatMap((s) => s.names.map((name) => `${s.mutator} ${name}`)))
    expect([...pairs].filter((pair) => !covered.has(pair))).toEqual([])
    // and each recipe's mutator sends its mutation
    for (const recipe of recipes)
      expect(
        sends.some((s) => s.mutator === recipe.mutator && s.names.includes(recipe.mutation)),
        recipe.what,
      ).toBe(true)
  })
})

describe('the writes from the task window’s own answer', () => {
  /* The store functions that serve a task the window shows from its own
     answer, which the workspace does not hold (planner.ts answerTaskOf),
     and the readers they and the window ask. Once tasks load on demand,
     the workspace holds a few tasks, so none of them may walk its task
     lists; one row looked up by its uuid or handle is allowed. The paints
     they give the workspace (labelRowsPaint, followRowsPaint,
     moveRowsPaint) skip until the workspace holds the task, and walk then
     what the held path walks. So do the reads of a task a window opens by
     a reference (planner.ts refRead), which resolve a number or a uuid on
     the server, and the window's delay of such a task (P.windowDelay). */
  const ANSWER_PATH = [
    'answerTaskOf',
    'updateAnswerTask',
    'toggleAnswerLabel',
    'followAnswerTask',
    'answerUploadTarget',
    'removeUnheldAttachment',
    'moveAnswerTask',
    'deleteAnswerTask',
    'answerParent',
    'answerFamilyOf',
    'familyOf',
    'taskShown',
    'shownHandleOf',
    'editsFromAnswer',
    'answerSaveWaits',
    'refSeats',
    'nextRefArgs',
    'runRefRead',
    'takeRefNews',
    'referenceNews',
    'syncRefRead',
    'refHandle',
    'refMoves',
    'watchTaskRef',
    'openTask',
    'openTarget',
    'unheldWatched',
    'unheldTask',
    'windowDelay',
    'windowDelayIssue',
    'syncWindowLoad',
    // the relation pickers' read and writes, which take a task or its other
    // end from a server answer (t3/limits-relation-pickers)
    'parentUuidOf',
    'subtaskListPaint',
    'setSubtaskParent',
    'linkTasks',
    'unlinkTasks',
    'relationCandidates',
    'shownParent',
    'subtaskPickRow',
    'editsSomeProject',
    'createParent',
    'createLinked',
    'addIssue',
  ]
  const bodies = new Map<string, string>()
  walk(program, (node, ancestors) => {
    if (
      !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)
    )
      return
    const name = functionName(node, ancestors)
    if (ANSWER_PATH.includes(name)) bodies.set(name, textOf(source, node))
  })

  it('finds every function it checks', () => {
    expect([...bodies.keys()].sort()).toEqual([...ANSWER_PATH].sort())
  })

  it('walks none of the workspace’s task lists', () => {
    const found = [...bodies].flatMap(([name, text]) =>
      WALKS.filter((walk) => walk.test(text)).map((walk) => `${name}: ${walk}`),
    )
    expect(found).toEqual([])
  })

  it('catches a walk in its pattern list', () => {
    // each pattern finds what it stands for, so the scan cannot pass empty
    const samples = [
      'P.issues.find((i) => i.uuid === id)',
      'PLANNER.issues.filter(Boolean)',
      'PLANNER.scopedIssues(info)',
      'rows.issues.forEach((c) => c)',
      'rows.issueLabels.some(Boolean)',
      '[...rows.attachments.values()]',
      'rows.issueSubs.push(row)',
      "workspaceRows.peekList('issueSubs')",
    ]
    expect(samples.map((text) => WALKS.some((walk) => walk.test(text)))).toEqual(
      samples.map(() => true),
    )
    expect(WALKS.some((walk) => walk.test('rows.issues.get(uuid) ?? rows.issues.has(t)'))).toBe(
      false,
    )
  })
})

describe('the readers of every task', () => {
  /* Tasks load on demand: the workspace holds none until a reader that
     needs every task asks (store/planner.ts P.askTasks) and waits for them
     (P.tasksHeld). So every read of the whole task list outside the store
     belongs to such a reader, named here with its reason, and a new one
     fails this scan even where no test mounts it. The store's own reads go
     through its task index. */
  const READS = [...WALKS.slice(0, 3), /\bissuesInGroups\b/, /\bremainingByGroups\b/]
  const ALLOWED: Record<string, { reason: string; reads: string[] }> = {
    'src/store/planner.ts': {
      reason:
        'the field itself: rebuild assigns it, its test-build accessor keeps it, and the Roadmap’s sums walk it behind their own check (wholeListRead)',
      reads: ['rebuild: P.issues', 'remainingByGroups: issuesInGroups', '(module): PLANNER.issues'],
    },
    'src/views/Roadmap.tsx': {
      reason: 'the Roadmap waits for every task and asks (App’s TasksLoadingView, roadmap)',
      reads: ['Roadmap: P.issues', 'headRemaining: remainingByGroups'],
    },
    'src/views/MobileRoadmap.tsx': {
      reason: 'the phone Roadmap mounts inside the Roadmap, behind its ask',
      reads: ['MobileRoadmap: scopedIssues'],
    },
    'src/views/Resources.tsx': {
      reason: 'the Resources strip mounts inside the Roadmap, behind its ask',
      reads: ['ResourceStrip: P.issues'],
    },
    'src/views/TeamSync.tsx': {
      reason: 'Team sync waits for every task and asks (App’s TasksLoadingView, team_sync)',
      reads: ['PersonColumns: P.issues', 'walkOf: P.issues'],
    },
    'src/views/teamSync/TeamOpening.tsx': {
      reason: 'Team sync’s opening mounts inside Team sync, behind its ask',
      reads: ['TeamOpening: P.issues'],
    },
  }
  const FUNCTION_TYPES = new Set([
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
  ])

  /** Each read of the whole task list in `source`, outside its comments,
      string literals and the names of object properties (a method's own
      definition), as `function: read`, with the innermost named function
      around it, or `(module)` outside any. */
  function wholeListReads(path: string, text: string): string[] {
    const { program: root, comments } = parseSync(path, text)
    const skipped: { start: number; end: number }[] = [...comments]
    const fns: { start: number; end: number; name: string }[] = []
    walk(root as unknown as AstNode, (node, ancestors) => {
      if (FUNCTION_TYPES.has(node.type))
        fns.push({ start: node.start, end: node.end, name: functionName(node, ancestors) })
      if (node.type === 'Literal' && typeof node.value === 'string') skipped.push(node)
      if (node.type === 'TemplateElement') skipped.push(node)
      if (node.type === 'Property' && !node.computed) skipped.push(node.key as AstNode)
    })
    let code = text
    for (const s of skipped)
      code = code.slice(0, s.start) + ' '.repeat(s.end - s.start) + code.slice(s.end)
    const found: string[] = []
    for (const read of READS)
      for (const m of code.matchAll(new RegExp(read.source, 'g'))) {
        const at = m.index ?? 0
        const around = fns
          .filter((fn) => fn.start <= at && at < fn.end && fn.name)
          .sort((a, b) => a.end - a.start - (b.end - b.start))[0]
        found.push(`${around?.name || '(module)'}: ${m[0]}`)
      }
    return found
  }
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = posix.join(dir, name)
      if (statSync(path).isDirectory()) return sources(path)
      return /\.tsx?$/.test(name) && !/\.(test|setup)\.tsx?$/.test(name) ? [path] : []
    })

  it('finds only the readers that wait for every task', () => {
    const found: Record<string, string[]> = {}
    for (const path of sources('src')) {
      const reads = wholeListReads(path, readFileSync(path, 'utf8'))
      if (reads.length > 0) found[path] = [...new Set(reads)].sort()
    }
    expect(Object.keys(found).sort()).toEqual(Object.keys(ALLOWED).sort())
    for (const [path, { reads }] of Object.entries(ALLOWED))
      expect(found[path], path).toEqual([...reads].sort())
  })

  it('catches a planted reader, and not a comment that names the list', () => {
    const planted = [
      'export function Planted() {',
      '  // P.issues is the whole list',
      '  return P.issues.filter((it) => it.status === "todo").length',
      '}',
    ].join('\n')
    expect(wholeListReads('src/views/Planted.tsx', planted)).toEqual(['Planted: P.issues'])
    expect(wholeListReads('src/views/Quiet.tsx', '/* P.scopedIssues(info) */ export {}')).toEqual(
      [],
    )
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
      // forward slashes on every platform, as the paths it compares with
      const path = posix.join(dir, name)
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
        if (!writesThroughConvex(parsed.source, node)) return
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

  it('throws when the tasks kept up to date differ from a full rebuild', async () => {
    const probe = await boot()
    expect(() => probe.corruptTask()).toThrow('differ from a full rebuild')
  })

  it("throws when code writes into the server's rows outside a paint", async () => {
    const probe = await boot()
    expect(() => probe.writeServerRow()).toThrow(TypeError)
  })

  it('throws when a paint reads the clock', async () => {
    const probe = await boot()
    expect(() => probe.paintClock()).toThrow('a paint read the clock')
  })
})
