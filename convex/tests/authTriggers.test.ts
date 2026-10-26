/* The Better Auth component's row triggers (authTriggers.ts) run once for
 * each row a bulk delete removes, in that delete's transaction, and every
 * call loads its module's imports again. A trigger whose module loaded
 * Better Auth cost about 30 ms a session on a local backend, and a ban of
 * 200 sessions then failed on Convex's time limit for one transaction. A
 * demo start calls demo.ts once for each of its calls, every app boot calls
 * identity.ts claimMySeats, and each makes the component lookup for the
 * caller's session (betterAuth/sessions.ts). Every REST and MCP call checks
 * its credential through nested calls (machine/auth.ts, oauthAccess.ts) and
 * the component lookups of a person's login and an OAuth token (betterAuth/
 * lookups.ts). This keeps Better Auth, auth.ts and the adapter's client out
 * of everything these modules load, and out of every module the REST and
 * MCP routes run in a nested call. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'

const sources = import.meta.glob(['../**/*.ts', '!../tests/**', '!../**/_generated/**'], {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

/** The modules a module imports or re-exports at run time, `import type`
 * and `export type` left out, as written: a relative path or a package
 * name. A dynamic `import()` counts too. */
function runtimeImports(source: string): string[] {
  const out: string[] = []
  for (const match of source.matchAll(/^import\s+(type\s+)?[^'"]*?from\s+'([^']+)'/gms))
    if (!match[1]) out.push(match[2])
  for (const match of source.matchAll(/^import\s+'([^']+)'/gm)) out.push(match[1])
  for (const match of source.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)) out.push(match[1])
  const reexport = /^export\s+(type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s+'([^']+)'/gm
  for (const match of source.matchAll(reexport)) if (!match[1]) out.push(match[2])
  return out
}

/** The path of the module `spec` names from module `from`, as the glob keys
 * it, or null for a package. A `.js` name finds its `.ts` source, as the
 * bundler does. */
function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const parts = from.split('/').slice(0, -1)
  for (const part of spec.split('/'))
    if (part === '..') parts.pop()
    else if (part !== '.') parts.push(part)
  const base = parts.join('/')
  const candidates = [base, `${base}.ts`, `${base}/index.ts`, base.replace(/\.js$/, '.ts')]
  return candidates.find((path) => path in sources) ?? base
}

/** Every module `entry` loads at run time, and every package they name. */
function loaded(entry: string) {
  const modules = new Set<string>()
  const packages = new Set<string>()
  const visit = (path: string) => {
    if (modules.has(path)) return
    modules.add(path)
    for (const spec of runtimeImports(sources[path] ?? '')) {
      const local = resolve(path, spec)
      if (local === null) packages.add(spec)
      else visit(local)
    }
  }
  visit(entry)
  return { modules, packages }
}

/** The Better Auth packages and Qivo's copy of the adapter among `loaded`. */
function betterAuthIn({ modules, packages }: ReturnType<typeof loaded>) {
  return [
    ...[...packages].filter((name) => /^(@better-auth|better-auth)\b/.test(name)),
    ...[...modules].filter((path) => path.includes('vendor/convex-better-auth')),
  ]
}

/** The function references in `source`: the module each names and the
 * top-level declaration it is in, a reference in a top-level comment
 * counting for the declaration after it. They are internal.a.b.fn and
 * components.betterAuth.a.fn as written, and makeFunctionReference's
 * 'a/b:fn'. `unread` holds a makeFunctionReference whose name is no such
 * string. Text that only looks like a reference counts too, which can only
 * make a walk reach more. */
function references(source: string) {
  const declarations = [
    ...source.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+(\w+)/gm),
  ]
  const found: { module: string; declaration: string }[] = []
  const unread: string[] = []
  const add = (index: number, module: string) => {
    const line = source.slice(source.lastIndexOf('\n', index) + 1)
    const declaration = /^(\/\*| \*|\/\/)/.test(line)
      ? declarations.find((d) => d.index > index)
      : declarations.findLast((d) => d.index <= index)
    found.push({ module, declaration: declaration?.[1] ?? '(module)' })
  }
  for (const match of source.matchAll(/\binternal\.([\w.]+)\.\w+/g))
    add(match.index, `../${match[1].replace(/\./g, '/')}.ts`)
  for (const match of source.matchAll(/\bcomponents\.betterAuth\.([\w.]+)\.\w+/g))
    add(match.index, `../betterAuth/${match[1].replace(/\./g, '/')}.ts`)
  for (const match of source.matchAll(
    /\bmakeFunctionReference\s*(?:<[\s\S]*?>)?\s*\(\s*([^,)]*)/g,
  )) {
    const name = /^'([\w/]+):\w+'$/.exec(match[1].trim())
    if (name) add(match.index, `../${name[1]}.ts`)
    else unread.push(match[1].trim())
  }
  return { found, unread }
}

/* Declarations that name a module loading Better Auth, in code the REST and
 * MCP routes load, though the routes never run them, as `references` names
 * them, each with what runs it. The walk does not follow them, and the test
 * fails once one is gone. */
const NOT_RUN_BY_MACHINE_CALLS: Record<string, string> = {
  '../demo.ts expire': "a demo's scheduled end",
  '../lib/demo.ts clampDemoSession': 'a sign-in on the demo (authTriggers.ts)',
  '../lib/functions.ts operatorCheckRef': 'platformAction, for platform operators',
  '../lib/functions.ts platformAction': 'platform operators',
  '../model/admin.ts operatorEmail': "a platform operator's audit row",
  '../model/usage.ts sessionsPage': 'the usage report (usage.ts sessions)',
  '../panoramaImages.ts operatorEmail': "a platform operator's audit row",
}

/** Every module whose functions the REST and MCP routes run, with the
 * reference that first reached it: each module machine/*.ts and everything
 * it loads names, then each module those modules and everything they load
 * name, to a fixpoint. `excused` holds the NOT_RUN_BY_MACHINE_CALLS entries
 * the walk met, and `unread` the references by name it could not read. */
function machineCalls() {
  const reached = new Map<string, string>()
  const excused = new Set<string>()
  const unread: string[] = []
  const scanned = new Set<string>()
  const queue = Object.keys(sources).filter((path) => path.startsWith('../machine/'))
  for (let next = queue.shift(); next !== undefined; next = queue.shift())
    for (const path of loaded(next).modules) {
      if (scanned.has(path)) continue
      scanned.add(path)
      const named = references(sources[path] ?? '')
      unread.push(...named.unread.map((name) => `${path} ${name}`))
      for (const { module, declaration } of named.found) {
        const by = `${path} ${declaration}`
        if (by in NOT_RUN_BY_MACHINE_CALLS) excused.add(by)
        else if (!reached.has(module)) {
          reached.set(module, by)
          queue.push(module)
        }
      }
    }
  return { reached, excused, unread }
}

describe('the auth triggers, the demo start, the boot claim and the machine calls', () => {
  it.each([
    ['../authTriggers.ts', '../lib/sessionEnd.ts'],
    ['../demo.ts', '../lib/authUser.ts'],
    ['../identity.ts', '../lib/authUser.ts'],
    ['../betterAuth/sessions.ts', '../betterAuth/_generated/server'],
    ['../oauthAccess.ts', '../lib/access.ts'],
    ['../machine/auth.ts', '../lib/access.ts'],
    ['../betterAuth/lookups.ts', '../betterAuth/schema.ts'],
  ])('%s loads neither Better Auth nor auth.ts', (entry, uses) => {
    const found = loaded(entry)
    expect(found.modules.has(uses)).toBe(true)
    expect(found.modules.has('../auth.ts')).toBe(false)
    expect(betterAuthIn(found)).toEqual([])
  })

  it('reach every module the REST and MCP routes run, nested call after nested call', () => {
    const { reached, excused, unread } = machineCalls()
    const failures = [...reached].flatMap(([module, by]) => {
      if (!(module in sources)) return [`${by} names ${module}, which is no module`]
      const found = loaded(module)
      const unknown = [...found.modules].filter(
        (path) => !(path in sources) && !/_generated\/|vendor\/convex-better-auth/.test(path),
      )
      return [
        ...(found.modules.has('../auth.ts') || betterAuthIn(found).length > 0
          ? [`${module} loads Better Auth, named by ${by}`]
          : []),
        ...unknown.map((path) => `${module} loads ${path}, which the walk cannot read`),
      ]
    })
    expect(failures).toEqual([])
    expect(unread).toEqual([])
    expect(Object.keys(NOT_RUN_BY_MACHINE_CALLS).filter((by) => !excused.has(by))).toEqual([])
    // named by machine/*.ts, by a module they load (lib/access.ts), by name
    // (model/labels.ts), and by a module a nested call runs
    for (const module of [
      '../oauthAccess.ts',
      '../machine/auth.ts',
      '../betterAuth/lookups.ts',
      '../labelRemovals.ts',
      '../backgroundPreviews.ts',
    ])
      expect(reached.has(module), module).toBe(true)
  })

  it('read each way a reference is written, and the declaration it is in', () => {
    const source = [
      "import { makeFunctionReference } from 'convex/server'",
      '/* Not `internal.notes.old`: */',
      "const ref = makeFunctionReference<'query', { id: string }>('lib/named:fn')",
      'export const run = action({',
      '  handler: async (ctx) => {',
      '    // components.betterAuth.lookups.userBan',
      '    await ctx.runQuery(internal.machine.records.list, {})',
      '    await ctx.runQuery(components.betterAuth.adapter.findOne, {})',
      '    await ctx.runQuery(makeFunctionReference(name), {})',
      '  },',
      '})',
    ].join('\n')
    expect(references(source)).toEqual({
      found: [
        { module: '../notes.ts', declaration: 'ref' },
        { module: '../machine/records.ts', declaration: 'run' },
        { module: '../betterAuth/lookups.ts', declaration: 'run' },
        { module: '../betterAuth/adapter.ts', declaration: 'run' },
        { module: '../lib/named.ts', declaration: 'ref' },
      ],
      unread: ['name'],
    })
  })

  it('see a module that would load Better Auth', () => {
    // adminAuth.ts calls Better Auth's API through auth.ts
    const found = loaded('../adminAuth.ts')
    expect(found.modules.has('../auth.ts')).toBe(true)
    expect(betterAuthIn(found).some((name) => name.startsWith('better-auth'))).toBe(true)
    // the component adapter's functions build Better Auth's options
    expect(loaded('../betterAuth/adapter.ts').modules.has('../auth.ts')).toBe(true)
  })

  it('follow a module reached only through a re-export', () => {
    // demo.ts reaches lib/panoramaImage.ts only through lib/panorama.ts's
    // `export { ... } from './panoramaImage'`
    expect(loaded('../demo.ts').modules.has('../lib/panoramaImage.ts')).toBe(true)
  })
})
