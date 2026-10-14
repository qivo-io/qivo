/* The machine action registry, the shape both machine surfaces use to declare
 * what they serve. Every REST route (machine/rest.ts ROUTES) and every MCP
 * tool (machine/mcp.ts TOOLS) is ONE entry with a required `access` flag and
 * a `run` that calls the endpoint's internal function. There is no default,
 * so an entry without the flag does not compile.
 *
 * The flag is the single source for three things: the MCP OAuth step-up (a
 * write tool needs qivo:write, else HTTP 403 insufficient_scope), the
 * read-only credential ceiling that builds on it, and the guard tests that
 * compare each flag with the kind of function the entry calls
 * (convex/tests/registry.test.ts).
 *
 * A read entry receives a runner that can only run queries, by type AND at
 * runtime. runEntry hands it an object holding nothing but a bound runQuery,
 * so a cast cannot reach a mutation or an action through it. */

import type { ActionCtx } from '../_generated/server'

/** Whether a machine action only reads data or may change it. */
export type MachineAccess = 'read' | 'write'

/** What a read entry may call, which is queries only. */
export type ReadRunner = Pick<ActionCtx, 'runQuery'>

/** What a write entry may call, which is queries, mutations and actions. */
export type WriteRunner = Pick<ActionCtx, 'runQuery' | 'runMutation' | 'runAction'>

/**
 * One machine action, generic over the surface's parsed input and its result.
 * The union on `access` types `run`'s runner, so the compiler refuses a read
 * entry that calls runMutation or runAction.
 */
export type MachineEntry<Input, Output> =
  | { access: 'read'; run: (runner: ReadRunner, input: Input) => Promise<Output> }
  | { access: 'write'; run: (runner: WriteRunner, input: Input) => Promise<Output> }

/** A runner holding only runQuery, bound to `ctx`. */
export function readRunner(ctx: ReadRunner): ReadRunner {
  return { runQuery: ctx.runQuery.bind(ctx) }
}

/** A runner holding runQuery, runMutation and runAction, bound to `ctx`. */
export function writeRunner(ctx: WriteRunner): WriteRunner {
  return {
    runQuery: ctx.runQuery.bind(ctx),
    runMutation: ctx.runMutation.bind(ctx),
    runAction: ctx.runAction.bind(ctx),
  }
}

/** Runs `entry` with the narrowest runner its access flag allows. */
export async function runEntry<Input, Output>(
  ctx: WriteRunner,
  entry: MachineEntry<Input, Output>,
  input: Input,
): Promise<Output> {
  if (entry.access === 'read') return await entry.run(readRunner(ctx), input)
  return await entry.run(writeRunner(ctx), input)
}
