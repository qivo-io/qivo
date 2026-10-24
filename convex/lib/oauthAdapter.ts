import { getCurrentAuthContext } from '@better-auth/core/context'
import type { DBAdapter } from '@better-auth/core/db/adapter'
import type { BetterAuthOptions } from 'better-auth/minimal'
import type { GenericCtx } from '../../vendor/convex-better-auth/src/client'
import { components } from '../_generated/api'
import type { DataModel } from '../_generated/dataModel'
import { sha256hex } from '../machine/auth'

type LazyAdapter = (options: BetterAuthOptions) => DBAdapter

// Wrap the final Better Auth adapter, after its transforms, to keep a
// refresh token's replay from touching other connections. The provider's
// rotation claims a refresh token with incrementOne on `revoked eq null`,
// which the adapter runs as one mutation that also matches a never-revoked
// token, whose `revoked` Convex stores as absent
// (vendor/convex-better-auth/src/client/adapter-utils.ts). It also answers a
// client Better Auth 1.6 registered as 1.6 served it (legacyClient).
export const oauthAdapter =
  (ctx: GenericCtx<DataModel>, factory: LazyAdapter): LazyAdapter =>
  (options) => {
    const adapter = factory(options)
    /* Better Auth 1.6 decided by a client's `public` whether to ask for its
     * secret. 1.7 reads only tokenEndpointAuthMethod, and its output
     * transform drops `public`, which it no longer declares. Until
     * internal/oauthClientBackfill.ts has written a 1.6 client, it is answered
     * as 1.6 served it: a public client with the method 'none', and a
     * confidential one never with 'none', which would let it in without its
     * secret. This goes with the legacy fields in betterAuth/schema.ts. */
    const legacyClient = async <T>(row: T): Promise<T> => {
      const client = row as { clientId?: string; tokenEndpointAuthMethod?: string | null }
      if (!client.clientId) return row
      const stored = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: 'oauthClient',
        where: [{ field: 'clientId', value: client.clientId }],
      })) as { public?: boolean | null } | null
      const method =
        stored?.public === true
          ? 'none'
          : stored?.public === false && client.tokenEndpointAuthMethod === 'none'
            ? 'client_secret_basic'
            : client.tokenEndpointAuthMethod
      return method === client.tokenEndpointAuthMethod
        ? row
        : { ...row, tokenEndpointAuthMethod: method }
    }
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
        if (operation.model === 'oauthClient' && row) return await legacyClient(row)
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
