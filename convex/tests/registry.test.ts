/* The machine action registry (machine/registry.ts). Every agent-key REST
 * route and MCP tool declares read or write once; these tests hold each flag
 * to the kind of internal function its entry actually calls, prove a read
 * entry cannot reach a mutation at runtime, check that a garbled flag fails
 * closed, and pin the REST route matching rules. The OAuth step-up derived
 * from the flag is driven over HTTP in oauth.test.ts.
 *
 * Entries call internal functions in their surface's module or in a domain
 * module that declares entries for both surfaces (machine/records.ts), so
 * the kinds below cover every one of those modules. A domain module keeps
 * each surface's functions apart. */

import { type FunctionReference, getFunctionName } from 'convex/server'
import { describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import type { ActionCtx } from '../_generated/server'
import * as mcp from '../machine/mcp'
import * as records from '../machine/records'
import {
  type MachineAccess,
  type MachineEntry,
  needsWrite,
  readRunner,
  runEntry,
  type WriteRunner,
  writeRunner,
} from '../machine/registry'
import * as rest from '../machine/rest'

type Kind = 'query' | 'mutation' | 'action'
type Call = { via: Kind; name: string; args: unknown }
type Ctx = Pick<ActionCtx, 'runQuery' | 'runMutation' | 'runAction'>

/* A raw ctx that records what each run tries to call, and resolves an
 * empty object, so a run that reads its result's fields still finishes. */
function recorder(): { runner: Ctx; calls: Call[] } {
  const calls: Call[] = []
  const record =
    (via: Kind) =>
    async (
      ref: FunctionReference<Kind, 'public' | 'internal'>,
      ...args: unknown[]
    ): Promise<never> => {
      calls.push({ via, name: getFunctionName(ref), args: args[0] })
      return {} as never
    }
  return {
    calls,
    runner: {
      runQuery: record('query'),
      runMutation: record('mutation'),
      runAction: record('action'),
    },
  }
}

/* The registered kind of every exported Convex function in a module, keyed
 * by its function name ("machine/mcp:listTeams"). */
function registeredKinds(module: string, exports: Record<string, unknown>): Map<string, Kind> {
  const kinds = new Map<string, Kind>()
  for (const [name, value] of Object.entries(exports)) {
    if (typeof value !== 'function') continue
    const fn = value as { isQuery?: true; isMutation?: true; isAction?: true }
    const kind = fn.isQuery ? 'query' : fn.isMutation ? 'mutation' : fn.isAction ? 'action' : null
    if (kind !== null) kinds.set(`${module}:${name}`, kind)
  }
  return kinds
}

/* The principal every entry below runs as, and its credential row (only
 * get_me reads it). */
const PRINCIPAL = { callerId: 'caller', access: 'read' } as const
const CREDENTIAL = {
  profile_id: 'caller',
  credential_table: 'agent_keys',
  credential_id: 'key',
  credential_row_id: 'row',
} as const

/* One entry of a surface, run through runEntry like its dispatcher does. */
type Entry = { label: string; access: MachineAccess; run: (ctx: Ctx) => Promise<unknown> }

type Surface = { module: string; kinds: Map<string, Kind>; entries: Entry[] }

/* The registered kind of every function an entry may call, across the
 * surface modules and the domain modules. */
const KINDS = new Map<string, Kind>([
  ...registeredKinds('machine/mcp', mcp),
  ...registeredKinds('machine/rest', rest),
  ...registeredKinds('machine/records', records),
])

const SURFACES: Surface[] = [
  {
    module: 'machine/mcp',
    kinds: KINDS,
    entries: mcp.TOOLS.map((tool) => ({
      label: tool.def.name,
      access: tool.access,
      run: (ctx) =>
        runEntry(ctx, tool, { ...PRINCIPAL, credential: CREDENTIAL, args: {}, ignored: [] }),
    })),
  },
  {
    module: 'machine/rest',
    kinds: KINDS,
    entries: rest.ROUTES.map((route) => ({
      label: `${route.method} /v1/${route.path}`,
      access: route.access,
      run: (ctx) =>
        runEntry(ctx, route, {
          ...PRINCIPAL,
          credential: CREDENTIAL,
          keyName: 'key',
          // a param the path does not declare would reach the internal fn
          // as undefined, so it fails here
          param: (name) => {
            if (!route.path.split('/').includes(`:${name}`))
              throw new Error(`${route.path} declares no :${name}`)
            return 'QN-1'
          },
          query: () => undefined,
          body: '',
        }),
    })),
  },
]

/* What each entry calls, run against the recorder, and what it threw. */
async function callsOf(
  surface: Surface,
): Promise<{ label: string; access: MachineAccess; calls: Call[]; error: unknown }[]> {
  const out = []
  for (const { label, access, run } of surface.entries) {
    const { runner, calls } = recorder()
    const error = await run(runner).then(
      () => null,
      (e: unknown) => e,
    )
    out.push({ label, access, calls, error })
  }
  return out
}

describe('the machine action registry', () => {
  it('every MCP tool and REST route declares read or write, once', () => {
    for (const surface of SURFACES) {
      expect(surface.entries.length).toBeGreaterThan(0)
      const labels = surface.entries.map((e) => e.label)
      expect(new Set(labels).size, `${surface.module} declares an entry twice`).toBe(labels.length)
      for (const { label, access } of surface.entries) {
        expect(['read', 'write'], `${label} access`).toContain(access)
      }
    }
  })

  it('write entries are exactly the ones whose internal functions are mutations', async () => {
    for (const surface of SURFACES) {
      const mismatches: string[] = []
      for (const { label, access, calls, error } of await callsOf(surface)) {
        if (error !== null) mismatches.push(`${label} throws ${String(error)}`)
        if (calls.length === 0) mismatches.push(`${label} calls nothing`)
        for (const call of calls) {
          const kind = surface.kinds.get(call.name)
          if (kind !== call.via)
            mismatches.push(`${label} runs ${call.name} (${kind}) as a ${call.via}`)
        }
        const writes = calls.some((call) => call.via !== 'query')
        if (writes !== (access === 'write')) {
          mismatches.push(`${label} is ${access} but calls ${calls.map((c) => c.via).join(', ')}`)
        }
      }
      expect(mismatches).toEqual([])
    }
  })

  it('every entry passes its principal through to the internal function', async () => {
    for (const surface of SURFACES) {
      for (const { label, calls } of await callsOf(surface)) {
        for (const call of calls) {
          expect(call.args, label).toMatchObject(PRINCIPAL)
        }
      }
    }
  })

  it('every internal function is reached, and by entries of one surface only', async () => {
    const surfacesOf = new Map<string, Set<string>>()
    for (const surface of SURFACES) {
      for (const { calls } of await callsOf(surface)) {
        for (const { name } of calls) {
          surfacesOf.set(name, (surfacesOf.get(name) ?? new Set()).add(surface.module))
        }
      }
    }
    expect([...surfacesOf.keys()].sort()).toEqual([...KINDS.keys()].sort())
    const shared = [...surfacesOf].filter(([, surfaces]) => surfaces.size > 1).map(([name]) => name)
    expect(shared).toEqual([])
  })

  it('each surface module serves only its own surface', async () => {
    for (const surface of SURFACES) {
      for (const { label, calls } of await callsOf(surface)) {
        for (const { name } of calls) {
          const other = SURFACES.find((s) => s !== surface && name.startsWith(`${s.module}:`))
          expect(other, `${label} runs ${name}`).toBeUndefined()
        }
      }
    }
  })

  it('a read entry gets a runner with only runQuery, so a cast cannot write', async () => {
    const { runner, calls } = recorder()
    expect(Object.keys(readRunner(runner))).toEqual(['runQuery'])
    expect(Object.keys(writeRunner(runner)).sort()).toEqual([
      'runAction',
      'runMutation',
      'runQuery',
    ])
    const cast = (r: unknown) =>
      (r as WriteRunner).runMutation(internal.machine.mcp.deleteIssue, {
        callerId: 'c',
        access: 'write',
        ref: 'r',
      })
    await expect(runEntry(runner, { access: 'read', run: cast }, null)).rejects.toThrow(TypeError)
    expect(calls).toEqual([])
    await runEntry(runner, { access: 'write', run: cast }, null)
    expect(calls).toEqual([
      {
        via: 'mutation',
        name: 'machine/mcp:deleteIssue',
        args: { callerId: 'c', access: 'write', ref: 'r' },
      },
    ])
  })

  it('a flag that slipped past the types gets the read runner and needs write', async () => {
    const { runner } = recorder()
    for (const access of [undefined, 'Write', 'admin']) {
      const garbled = {
        access,
        run: async (r: object) => Object.keys(r),
      } as unknown as MachineEntry<null, string[]>
      expect(await runEntry(runner, garbled, null), String(access)).toEqual(['runQuery'])
      expect(needsWrite(garbled), String(access)).toBe(true)
    }
    expect(needsWrite({ access: 'read' })).toBe(false)
    expect(needsWrite({ access: 'write' })).toBe(true)
  })

  it('the compiler refuses a read entry that writes and an entry without a flag', () => {
    const writes: MachineEntry<null, unknown> = {
      access: 'read',
      run: (r) =>
        // @ts-expect-error a read entry's runner has no runMutation
        r.runMutation(internal.machine.mcp.deleteIssue, {
          callerId: 'c',
          access: 'write',
          ref: 'r',
        }),
    }
    // @ts-expect-error every entry names its access, there is no default
    const unflagged: MachineEntry<null, unknown> = { run: async () => null }
    expect([writes.access, unflagged.access]).toEqual(['read', undefined])
  })

  it('the compiler refuses a raw ctx in place of a runner', () => {
    const { runner } = recorder()
    // never called, the closure only has to compile or not
    const input = { ...PRINCIPAL, credential: CREDENTIAL, args: {} }
    // @ts-expect-error only runEntry turns a ctx into the runner an entry takes
    const bypass = () => mcp.TOOLS[0].run(runner, input)
    expect(typeof bypass).toBe('function')
  })

  it('the compiler refuses a route param its path does not declare', () => {
    const route = rest.route({
      method: 'GET',
      path: 'tasks/:ref',
      access: 'read',
      status: 200,
      run: (r, { callerId, access, param }) =>
        // @ts-expect-error the path declares :ref, not :key
        r.runQuery(internal.machine.rest.getIssue, { callerId, access, ref: param('key') }),
    })
    expect(route.path).toBe('tasks/:ref')
  })
})

describe('REST route matching', () => {
  const match = (method: string, path: string) => {
    const found = rest.findRoute(method, path.split('/').filter(Boolean))
    return found === null
      ? null
      : { route: `${found.route.method} ${found.route.path}`, ...found.params }
  }

  it('matches literal segments raw and decodes params', () => {
    expect(match('GET', 'tasks/QN-1/comments')).toEqual({
      route: 'GET tasks/:ref/comments',
      ref: 'QN-1',
    })
    expect(match('POST', 'tasks/QN-1/comments')).toEqual({
      route: 'POST tasks/:ref/comments',
      ref: 'QN-1',
    })
    expect(match('GET', 'tasks/QN%2D1')).toEqual({ route: 'GET tasks/:ref', ref: 'QN-1' })
    // invalid UTF-8 stays raw and then simply resolves to nothing
    expect(match('DELETE', 'tasks/%C0')).toEqual({ route: 'DELETE tasks/:ref', ref: '%C0' })
    expect(match('GET', 'projects/FW/users')).toEqual({
      route: 'GET projects/:ref/users',
      ref: 'FW',
    })
    expect(match('GET', 'users')).toEqual({ route: 'GET users' })
    expect(match('POST', 'tasks/QN-1/attachments/abc')).toEqual({
      route: 'POST tasks/:ref/attachments/:ticket',
      ref: 'QN-1',
      ticket: 'abc',
    })
    expect(match('GET', 'workload')).toEqual({ route: 'GET workload' })
  })

  it('answers null (the unknown-route 404) for every other method or shape', () => {
    for (const [method, path] of [
      ['PATCH', 'tasks/QN-1/comments'],
      ['DELETE', 'tasks/QN-1/comments'],
      ['PUT', 'tasks'],
      ['POST', 'tasks/QN-1'],
      ['PATCH', 'tasks'],
      ['GET', 'users/a/b'],
      ['GET', 'projects/FW/other'],
      ['POST', 'projects'],
      ['GET', '%70rojects'],
      ['GET', 'issues'],
      ['PATCH', 'tasks/QN-1/attachments/abc'],
      ['POST', 'workload'],
      ['GET', 'webhooks'],
      ['GET', ''],
    ]) {
      expect(match(method, path), `${method} ${path}`).toBeNull()
    }
  })
})
