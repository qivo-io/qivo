/* The machine action registry, the shape both machine surfaces use to declare
 * what they serve. Every agent-key REST route (machine/rest.ts ROUTES) and
 * every MCP tool (machine/mcp.ts TOOLS) is ONE entry with a required `access`
 * flag and a `run` that calls the endpoint's internal function. There is no
 * default, so an entry without the flag does not compile. The /v1/webhooks
 * routes and the MCP events/* methods are served outside the registry, with
 * their own credential checks.
 *
 * The flag is the single source for the MCP OAuth step-up (a write tool needs
 * qivo:write, else HTTP 403 insufficient_scope) and for the guard tests that
 * compare each flag with the kind of function the entry calls
 * (convex/tests/registry.test.ts) and drive every write entry with a
 * read-only credential (convex/tests/credentialAccess.test.ts).
 *
 * Every entry receives the Principal, which is the caller's profile uuid and
 * what its credential may do. `run` passes both to the internal function, whose
 * asMachineCaller refuses a write from a credential that can only read.
 *
 * A read entry receives a runner that can only run queries, by type AND at
 * runtime. runEntry hands it an object whose only function is a bound
 * runQuery, so a cast cannot reach a mutation or an action through it. Both
 * runners carry a brand that only readRunner and writeRunner set, so passing
 * a raw ctx to an entry's `run` does not compile and runEntry is the way to
 * dispatch. Every check fails closed. Only an exact 'write' flag gets the
 * write runner, and anything but an exact 'read' flag needs write access from
 * the credential (needsWrite). */

import type { ActionCtx } from '../_generated/server'
import type { CredentialAccess } from '../lib/enums'

/** Whether a machine action only reads data or may change it. */
export type MachineAccess = 'read' | 'write'

/**
 * Who runs a machine action, as the profile uuid the auth step resolved and
 * what its credential may do (lib/access.ts credentialAccess).
 */
export type Principal = { callerId: string; access: CredentialAccess }

/* Brands the runners below. Module-private, so no other code can turn a raw
 * ctx into a runner without going through readRunner or writeRunner. */
const brand = Symbol('machine runner')

/** The parts of an action ctx that the runners are built from. */
type Runners = Pick<ActionCtx, 'runQuery' | 'runMutation' | 'runAction'>

/** What a read entry may call, which is queries only. */
export type ReadRunner = Pick<ActionCtx, 'runQuery'> & { readonly [brand]: 'read' }

/** What a write entry may call, which is queries, mutations and actions. */
export type WriteRunner = Runners & { readonly [brand]: 'write' }

/**
 * One machine action, generic over the surface's parsed input and its result.
 * The union on `access` types `run`'s runner, so the compiler refuses a read
 * entry that calls runMutation or runAction.
 */
export type MachineEntry<Input, Output> =
  | { access: 'read'; run: (runner: ReadRunner, input: Input) => Promise<Output> }
  | { access: 'write'; run: (runner: WriteRunner, input: Input) => Promise<Output> }

/** A runner whose only function is runQuery, bound to `ctx`. */
export function readRunner(ctx: Pick<ActionCtx, 'runQuery'>): ReadRunner {
  return { runQuery: ctx.runQuery.bind(ctx), [brand]: 'read' }
}

/** A runner holding runQuery, runMutation and runAction, bound to `ctx`. */
export function writeRunner(ctx: Runners): WriteRunner {
  return {
    runQuery: ctx.runQuery.bind(ctx),
    runMutation: ctx.runMutation.bind(ctx),
    runAction: ctx.runAction.bind(ctx),
    [brand]: 'write',
  }
}

/**
 * Runs `entry` with the narrowest runner its access flag allows. Only an
 * exact 'write' gets the write runner, so a flag that slipped past the types
 * gets the read runner.
 */
export async function runEntry<Input, Output>(
  ctx: Runners,
  entry: MachineEntry<Input, Output>,
  input: Input,
): Promise<Output> {
  if (entry.access === 'write') return await entry.run(writeRunner(ctx), input)
  return await entry.run(readRunner(ctx), input)
}

/**
 * Whether the credential needs write access to run `entry`. Anything but an
 * exact 'read' counts as a write, so a flag that slipped past the types fails
 * closed.
 */
export function needsWrite(entry: { access: MachineAccess }): boolean {
  return entry.access !== 'read'
}
