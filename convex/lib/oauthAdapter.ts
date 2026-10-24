import { getCurrentAuthContext } from '@better-auth/core/context'
import type { DBAdapter } from '@better-auth/core/db/adapter'
import type { BetterAuthOptions } from 'better-auth/minimal'
import { sha256hex } from '../machine/auth'

type LazyAdapter = (options: BetterAuthOptions) => DBAdapter

// Wrap the final Better Auth adapter, after its transforms, to keep a
// refresh token's replay from touching other connections. The provider's
// rotation claims a refresh token with incrementOne on `revoked eq null`,
// which the adapter runs as one mutation that also matches a never-revoked
// token, whose `revoked` Convex stores as absent
// (vendor/convex-better-auth/src/client/adapter-utils.ts).
export const oauthAdapter =
  (factory: LazyAdapter): LazyAdapter =>
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
    }
  }
