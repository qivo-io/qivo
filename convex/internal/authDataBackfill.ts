/* A one-time pass that clears the personal data Better Auth stored before
 * auth.ts stopped writing it (lib/authData.ts). That is the client IP
 * address and User-Agent on sessions, the provider tokens on Google and
 * Microsoft account rows, and the provider picture in user.image. It never
 * deletes a row and never writes a credential (password) account, whose
 * rows it reads without their password. The MCP OAuth provider's tables are
 * not read.
 *
 * One sequential chain of `start` steps, phase by phase: sessions, then
 * accounts, then users. Empty arguments start a run. Each step reads one
 * page of its phase's table through the Better Auth component, at most
 * AUTH_DATA_PAGE.rows rows. It writes null to the listed fields of each row
 * that still holds a value in one and schedules the next step with the
 * running counts. The step that finds nothing left writes the run's one
 * clear_auth_data platform_audit_log row (actor 'cli'). Its detail counts
 * the rows read (`rows`) and the sessions, accounts and users cleared.
 *
 * Running it twice, or while people sign in, is safe. auth.ts keeps every
 * new write free of these fields, a step reads and writes a row in one
 * transaction, and a row that holds none of them is not written, so a second
 * run reports zero cleared rows. Convex drops the calls a failed step
 * scheduled, so a failure ends the run without an audit row and earlier
 * steps stay committed. Run it again from empty arguments; the rows already
 * cleared are only read.
 *
 * Run it once per deployment. Running it on any hosted deployment needs the
 * user's approval first, each time. From a Qivo checkout, the private helper
 * names the deployment and refuses to run without its key, for example
 * development:
 *
 *   "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment" \
 *     development npx convex run internal/authDataBackfill:start
 *
 * The other targets are staging and production. The demo backend needs no
 * run, because its sessions were already stored without these fields and its
 * anonymous logins have no provider account or picture. The command runs
 * the first step and returns once it has scheduled the next. The audit row
 * appears in Admin › Audit when the run ends. */

import { makeFunctionReference } from 'convex/server'
import { type Infer, type ObjectType, v } from 'convex/values'
import { components } from '../_generated/api'
import { internalMutation, type MutationCtx } from '../_generated/server'
import {
  fieldsSetTo,
  holdsAny,
  PROVIDER_TOKEN_FIELDS,
  SESSION_REQUEST_FIELDS,
  USER_PROFILE_FIELDS,
} from '../lib/authData'
import { audit } from '../model/admin'

/** The most rows one step reads. A row costs at most one component write,
 * and the largest, a user row with a Microsoft photo, holds a few kilobytes,
 * so a step stays far below Convex's transaction limits. Tests lower it. */
export const AUTH_DATA_PAGE = { rows: 100 }

const PHASES = ['sessions', 'accounts', 'users'] as const
type Phase = (typeof PHASES)[number]

/* What each phase reads: its Better Auth model, the fields it clears and
 * the fields it selects. An account also reports its provider, so a
 * credential account is recognized without its password. */
const TARGETS = {
  sessions: {
    model: 'session',
    fields: SESSION_REQUEST_FIELDS,
    select: ['_id', ...SESSION_REQUEST_FIELDS],
  },
  accounts: {
    model: 'account',
    fields: PROVIDER_TOKEN_FIELDS,
    select: ['_id', 'providerId', ...PROVIDER_TOKEN_FIELDS],
  },
  users: { model: 'user', fields: USER_PROFILE_FIELDS, select: ['_id', ...USER_PROFILE_FIELDS] },
} as const

const vCounts = v.object({
  rows: v.number(), // rows read
  sessions: v.number(), // sessions whose IP address and User-Agent were cleared
  accounts: v.number(), // social accounts whose provider tokens were cleared
  users: v.number(), // users whose provider picture was cleared
})

/** The counts a run records in its clear_auth_data audit row. */
export type AuthDataCounts = Infer<typeof vCounts>

const stepArgs = {
  phase: v.optional(v.union(v.literal('sessions'), v.literal('accounts'), v.literal('users'))),
  cursor: v.optional(v.string()), // the phase's page cursor
  counts: v.optional(vCounts),
}
type Step = ObjectType<typeof stepArgs>

const startRef = makeFunctionReference<'mutation', Step, null>('internal/authDataBackfill:start')

/* Writes null to the fields `phase` clears on the row `id`. */
async function clearRow(ctx: MutationCtx, phase: Phase, id: string): Promise<void> {
  const where = [{ field: '_id' as const, value: id }]
  await ctx.runMutation(components.betterAuth.adapter.updateOne, {
    input:
      phase === 'sessions'
        ? { model: 'session', where, update: fieldsSetTo(SESSION_REQUEST_FIELDS, null) }
        : phase === 'accounts'
          ? { model: 'account', where, update: fieldsSetTo(PROVIDER_TOKEN_FIELDS, null) }
          : { model: 'user', where, update: fieldsSetTo(USER_PROFILE_FIELDS, null) },
  })
}

/** One step of the backfill, then the next one scheduled. Empty arguments
 * start a run at the first session. */
export const start = internalMutation({
  args: stepArgs,
  handler: async (ctx, a): Promise<null> => {
    const phase = a.phase ?? 'sessions'
    const counts = a.counts ?? { rows: 0, sessions: 0, accounts: 0, users: 0 }
    const target = TARGETS[phase]
    const page = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: target.model,
      select: [...target.select],
      paginationOpts: { cursor: a.cursor ?? null, numItems: Math.max(1, AUTH_DATA_PAGE.rows) },
    })) as {
      page: Array<{ _id: string; providerId?: string }>
      isDone: boolean
      continueCursor: string
    }
    for (const row of page.page) {
      counts.rows += 1
      if (row.providerId === 'credential' || !holdsAny(row, target.fields)) continue
      await clearRow(ctx, phase, row._id)
      counts[phase] += 1
    }
    const following = PHASES[PHASES.indexOf(phase) + 1]
    const next: Pick<Step, 'phase' | 'cursor'> | null = !page.isDone
      ? { phase, cursor: page.continueCursor }
      : following !== undefined
        ? { phase: following }
        : null
    if (next !== null) {
      await ctx.scheduler.runAfter(0, startRef, { ...next, counts })
      return null
    }
    await audit(ctx, { actor_email: 'cli', action: 'clear_auth_data', detail: counts })
    return null
  },
})
