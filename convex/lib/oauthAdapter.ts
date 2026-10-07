import { getCurrentAuthContext } from '@better-auth/core/context'
import type { DBAdapter } from '@better-auth/core/db/adapter'
import type { GenericCtx } from '@convex-dev/better-auth'
import { requireRunMutationCtx } from '@convex-dev/better-auth/utils'
import type { BetterAuthOptions } from 'better-auth/minimal'
import { components } from '../_generated/api'
import type { DataModel } from '../_generated/dataModel'
import { sha256hex } from '../machine/auth'

type LazyAdapter = (options: BetterAuthOptions) => DBAdapter
const fields = new Set(['id', 'token', 'clientId', 'userId', 'referenceId', 'sessionId', 'revoked'])

// Wrap the final Better Auth adapter, after its transforms. The provider uses
// incrementOne as a CAS even though it increments no columns. Delegating that
// fallback to Convex's generic equality filter compares undefined !== null.
// Keep this workaround narrow and fail closed if a future provider changes it.
export const oauthAdapter =
  (ctx: GenericCtx<DataModel>, factory: LazyAdapter): LazyAdapter =>
  (options) => {
    const adapter = factory(options)
    const narrowFamily = async (operation: {
      model: string
      where?: Parameters<DBAdapter['deleteMany']>[0]['where']
    }) => {
      if (
        operation.model !== 'oauthRefreshToken' ||
        !operation.where?.some((guard) => guard.field === 'clientId') ||
        !operation.where.some((guard) => guard.field === 'userId') ||
        operation.where.some((guard) => guard.field === 'referenceId')
      )
        return operation.where
      // The revocation endpoint can race the rotation CAS too. Preserve all
      // provider predicates and narrow its family cleanup to the actual grant.
      const endpoint = await getCurrentAuthContext()
      let raw = endpoint.body?.refresh_token || endpoint.body?.token
      if (typeof raw !== 'string') return null
      if (raw.startsWith('Bearer ')) raw = raw.slice(7)
      if (!raw.startsWith('qvr_')) return null
      const row = await adapter.findOne<{ referenceId?: string }>({
        model: 'oauthRefreshToken',
        where: [{ field: 'token', value: await sha256hex(raw.slice(4)) }],
      })
      if (!row?.referenceId) return null
      return [...operation.where, { field: 'referenceId', value: row.referenceId }]
    }
    return {
      ...adapter,
      findOne: async <T>(operation: Parameters<DBAdapter['findOne']>[0]) => {
        const row = await adapter.findOne<T>(operation)
        // The upstream replay branch deletes every family for the same user and
        // client. Qivo's durable ledger revokes the exact connection instead.
        // Hide a consumed refresh row before that branch can affect a reconnect.
        if (
          operation.model === 'oauthRefreshToken' &&
          row &&
          (row as { revoked?: number }).revoked != null
        )
          return null
        return row
      },
      findMany: async <T>(operation: Parameters<DBAdapter['findMany']>[0]) => {
        const where = await narrowFamily(operation)
        return where === null ? [] : adapter.findMany<T>({ ...operation, where })
      },
      deleteMany: async (operation) => {
        const where = await narrowFamily(operation)
        return where === null ? 0 : adapter.deleteMany({ ...operation, where: where || [] })
      },
      incrementOne: async (operation) => {
        if (operation.model !== 'oauthRefreshToken') return adapter.incrementOne(operation)
        if (
          Object.keys(operation.increment).length ||
          !operation.set ||
          Object.keys(operation.set).length !== 1 ||
          !('revoked' in operation.set)
        )
          throw new Error('Unsupported OAuth refresh CAS operation')
        const revoked = operation.set.revoked
        const revokedAt =
          revoked instanceof Date ? revoked.getTime() : typeof revoked === 'number' ? revoked : NaN
        if (
          !Number.isFinite(revokedAt) ||
          !operation.where ||
          operation.where.some(
            (guard) =>
              !fields.has(guard.field) ||
              (guard.operator !== undefined && guard.operator !== 'eq') ||
              (guard.connector !== undefined && guard.connector !== 'AND') ||
              (guard.mode !== undefined && guard.mode !== 'sensitive') ||
              (typeof guard.value !== 'string' && guard.value !== null),
          )
        )
          throw new Error('Unsupported OAuth refresh CAS predicates')
        const where = operation.where.map(({ field, value }) => ({ field, value })) as {
          field: 'id' | 'token' | 'clientId' | 'userId' | 'referenceId' | 'sessionId' | 'revoked'
          value: string | null
        }[]
        return (await requireRunMutationCtx(ctx).runMutation(
          components.betterAuth.oauth.claimRefreshToken,
          { where, revokedAt },
        )) as never
      },
    }
  }
