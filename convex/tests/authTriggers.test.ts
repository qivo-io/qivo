/* The Better Auth component's row triggers (authTriggers.ts) run once for
 * each row a bulk delete removes, in that delete's transaction, and every
 * call loads its module's imports again. A trigger whose module loaded
 * Better Auth cost about 30 ms a session on a local backend, and a ban of
 * 200 sessions then failed on Convex's time limit for one transaction. A
 * demo start calls demo.ts once for each of its calls, and the component
 * lookup it makes for the caller's session (betterAuth/sessions.ts) once
 * for each of those. This keeps Better Auth, auth.ts and the adapter's
 * client out of everything these modules load. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'

const sources = import.meta.glob(['../**/*.ts', '!../tests/**', '!../**/_generated/**'], {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

/** The modules a module imports at run time, `import type` left out, as
 * written: a relative path or a package name. */
function runtimeImports(source: string): string[] {
  const out: string[] = []
  for (const match of source.matchAll(/^import\s+(type\s+)?[^'"]*?from\s+'([^']+)'/gms))
    if (!match[1]) out.push(match[2])
  for (const match of source.matchAll(/^import\s+'([^']+)'/gm)) out.push(match[1])
  return out
}

/** The path of the module `spec` names from module `from`, as the glob keys
 * it, or null for a package. */
function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const parts = from.split('/').slice(0, -1)
  for (const part of spec.split('/'))
    if (part === '..') parts.pop()
    else if (part !== '.') parts.push(part)
  const base = parts.join('/')
  for (const path of [`${base}.ts`, `${base}/index.ts`]) if (path in sources) return path
  return base
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

describe('the auth triggers and the demo start', () => {
  it.each([
    ['../authTriggers.ts', '../lib/sessionEnd.ts'],
    ['../demo.ts', '../lib/authUser.ts'],
    ['../betterAuth/sessions.ts', '../betterAuth/_generated/server'],
  ])('%s loads neither Better Auth nor auth.ts', (entry, uses) => {
    const found = loaded(entry)
    expect(found.modules.has(uses)).toBe(true)
    expect(found.modules.has('../auth.ts')).toBe(false)
    expect(betterAuthIn(found)).toEqual([])
  })

  it('see a module that would load Better Auth', () => {
    // identity.ts reads the login through auth.ts's authComponent
    const found = loaded('../identity.ts')
    expect(found.modules.has('../auth.ts')).toBe(true)
    expect(betterAuthIn(found).some((name) => name.startsWith('better-auth'))).toBe(true)
    // the component adapter's functions build Better Auth's options
    expect(loaded('../betterAuth/adapter.ts').modules.has('../auth.ts')).toBe(true)
  })
})
