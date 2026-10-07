import { v } from 'convex/values'
import { components } from './_generated/api'
import { internalMutation, internalQuery } from './_generated/server'
import { createAuth } from './auth'
import { byId } from './lib/db'
import { isDemoDeployment, refuseDemoFeature } from './lib/demo'
import { authedMutation, authedQuery, badRequest, notFound } from './lib/functions'
import { canonicalOAuthQuery, homeProfile, mcpResource, validateOAuthQuery } from './lib/oauth'
import { authorizationHash } from './lib/oauthProvider'
import { newUuid } from './model/orgs'

export const getContext = authedMutation({
  args: { oauth_query: v.string() },
  handler: async (ctx, args) => {
    refuseDemoFeature()
    let oauthQuery: string
    let client: { client_name?: string }
    try {
      oauthQuery = canonicalOAuthQuery(args.oauth_query)
      const query = new URLSearchParams(oauthQuery)
      validateOAuthQuery(query)
      client = await createAuth(ctx).api.getOAuthClientPublicPrelogin({
        body: { client_id: query.get('client_id') || '', oauth_query: oauthQuery },
      })
    } catch {
      throw badRequest('This connection request is invalid or expired. Reconnect from your app.')
    }
    const query = new URLSearchParams(oauthQuery)
    const hash = await authorizationHash(ctx.authUserId, query)
    const connection = await ctx.db
      .query('oauth_connections')
      .withIndex('by_authorization', (q) => q.eq('authorization_hash', hash))
      .unique()
    if (connection?.revoked_at)
      throw badRequest('This connection was disconnected. Reconnect from your app.')
    const profile = connection
      ? await byId(ctx, 'profiles', connection.profile_id)
      : homeProfile([...ctx.myProfiles.values()])
    if (!profile?.active || profile.auth_user_id !== ctx.authUserId)
      throw badRequest('This organization is no longer available. Reconnect from your app.')
    const org = await byId(ctx, 'organizations', profile.org_id)
    if (!org) throw badRequest('This organization is no longer available.')
    if (!connection)
      await ctx.db.insert('oauth_connections', {
        id: newUuid(),
        authorization_hash: hash,
        auth_user_id: ctx.authUserId,
        profile_id: profile.id,
        org_id: org.id,
        client_id: query.get('client_id') || '',
        client_name: client.client_name || 'Unnamed app',
        resource: mcpResource(),
        requested_scopes: (query.get('scope') || '').split(' ').filter(Boolean),
        scopes: [],
        created_at: new Date().toISOString(),
        authorization_expires_at: new Date(Number(query.get('exp')) * 1000).toISOString(),
      })
    return {
      oauthQuery,
      clientId: query.get('client_id') || '',
      clientName: client.client_name || 'Unnamed app',
      redirectOrigin: new URL(query.get('redirect_uri') || '').origin,
      profileId: profile.id,
      profileName: profile.name,
      orgId: org.id,
      orgName: org.name,
      orgRole: profile.org_role,
      scopes: (query.get('scope') || '').split(' ').filter(Boolean),
      resource: mcpResource(),
    }
  },
})

export const list = authedQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query('oauth_connections')
      .withIndex('by_auth_user', (q) => q.eq('auth_user_id', ctx.authUserId))
      .collect()
    return Promise.all(
      rows
        .filter((row) => row.approved_at && row.revocation_reason !== 'deleted')
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(async (row) => ({
          id: row.id,
          clientId: row.client_id,
          clientName: row.client_name,
          profileId: row.profile_id,
          profileName: (await byId(ctx, 'profiles', row.profile_id))?.name || 'Removed member',
          orgId: row.org_id,
          orgName: (await byId(ctx, 'organizations', row.org_id))?.name || 'Removed organization',
          scopes: row.scopes,
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at ?? null,
          revokedAt: row.revoked_at ?? null,
        })),
    )
  },
})

export const revoke = authedMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const connection = await byId(ctx, 'oauth_connections', id)
    if (!connection || connection.auth_user_id !== ctx.authUserId)
      throw notFound('Connection not found.')
    // Delete from the person's list, retaining the grant and replay hashes so
    // previously approved consent and issued credentials cannot revive it.
    await ctx.db.patch(connection._id, {
      revoked_at: connection.revoked_at ?? new Date().toISOString(),
      revocation_reason: 'deleted',
    })
    return true
  },
})

export const ensure = internalMutation({
  args: {
    authorizationHash: v.string(),
    authUserId: v.string(),
    clientId: v.string(),
    clientName: v.string(),
    resource: v.string(),
    requestedScopes: v.array(v.string()),
    scopes: v.array(v.string()),
    approve: v.boolean(),
    expiresAt: v.string(),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString()
    let row = await ctx.db
      .query('oauth_connections')
      .withIndex('by_authorization', (q) => q.eq('authorization_hash', args.authorizationHash))
      .unique()
    if (!row) {
      const profiles = await ctx.db
        .query('profiles')
        .withIndex('by_auth', (q) => q.eq('auth_user_id', args.authUserId))
        .collect()
      const home = homeProfile(profiles)
      const id = await ctx.db.insert('oauth_connections', {
        id: newUuid(),
        authorization_hash: args.authorizationHash,
        auth_user_id: args.authUserId,
        profile_id: home.id,
        org_id: home.org_id,
        client_id: args.clientId,
        client_name: args.clientName,
        resource: args.resource,
        requested_scopes: args.requestedScopes,
        scopes: [],
        created_at: now,
        authorization_expires_at: args.expiresAt,
      })
      row = await ctx.db.get(id)
    }
    if (
      !row ||
      row.revoked_at ||
      row.authorization_expires_at <= now ||
      row.auth_user_id !== args.authUserId ||
      row.client_id !== args.clientId ||
      row.resource !== args.resource
    )
      return null
    const profile = await byId(ctx, 'profiles', row.profile_id)
    if (
      !profile?.active ||
      profile.kind !== 'person' ||
      profile.auth_user_id !== row.auth_user_id ||
      profile.org_id !== row.org_id
    )
      return null
    if (args.approve) {
      if (
        !args.scopes.includes('qivo:read') ||
        args.scopes.some((scope) => !row.requested_scopes.includes(scope))
      )
        return null
      if (
        row.approved_at &&
        (row.scopes.length !== args.scopes.length ||
          args.scopes.some((scope) => !row.scopes.includes(scope)))
      )
        return null
      if (!row.approved_at) await ctx.db.patch(row._id, { approved_at: now, scopes: args.scopes })
    }
    return row.id
  },
})

const kind = v.union(v.literal('authorization_code'), v.literal('refresh_token'))

export const registerCode = internalMutation({
  args: { id: v.string(), credentialHash: v.string() },
  handler: async (ctx, args) => {
    const row = await byId(ctx, 'oauth_connections', args.id)
    if (!row?.approved_at || row.revoked_at) return false
    const existing = await ctx.db
      .query('oauth_credential_uses')
      .withIndex('by_hash', (q) =>
        q.eq('kind', 'authorization_code').eq('credential_hash', args.credentialHash),
      )
      .unique()
    if (existing) return false
    await ctx.db.insert('oauth_credential_uses', {
      connection_id: row.id,
      credential_hash: args.credentialHash,
      kind: 'authorization_code',
    })
    return true
  },
})

export const claimIssuance = internalMutation({
  args: {
    id: v.string(),
    authUserId: v.string(),
    clientId: v.string(),
    resource: v.string(),
    scopes: v.array(v.string()),
    credentialHash: v.string(),
    kind,
  },
  handler: async (ctx, args) => {
    const row = await byId(ctx, 'oauth_connections', args.id)
    const now = new Date().toISOString()
    if (
      !row ||
      row.revoked_at ||
      !row.approved_at ||
      row.auth_user_id !== args.authUserId ||
      row.client_id !== args.clientId ||
      row.resource !== args.resource ||
      !args.scopes.includes('qivo:read') ||
      args.scopes.some((scope) => !row.scopes.includes(scope))
    )
      return false
    const profile = await byId(ctx, 'profiles', row.profile_id)
    if (
      !profile?.active ||
      profile.kind !== 'person' ||
      profile.auth_user_id !== row.auth_user_id ||
      profile.org_id !== row.org_id
    )
      return false
    const used = await ctx.db
      .query('oauth_credential_uses')
      .withIndex('by_hash', (q) =>
        q.eq('kind', args.kind).eq('credential_hash', args.credentialHash),
      )
      .unique()
    if (used?.used_at || (args.kind === 'authorization_code' && row.code_used_at)) {
      // Return refusal, then throw outside this mutation: throwing here would
      // roll back the revocation and let a concurrent winner survive replay.
      await ctx.db.patch(row._id, { revoked_at: now, revocation_reason: 'credential_replay' })
      return false
    }
    if (args.kind === 'authorization_code' && (!used || used.connection_id !== row.id)) return false
    if (used) await ctx.db.patch(used._id, { used_at: now })
    else
      await ctx.db.insert('oauth_credential_uses', {
        connection_id: row.id,
        credential_hash: args.credentialHash,
        kind: args.kind,
        used_at: now,
      })
    if (args.kind === 'authorization_code') await ctx.db.patch(row._id, { code_used_at: now })
    return true
  },
})

export const revokeReplay = internalMutation({
  args: { kind, credentialHash: v.string(), clientId: v.string() },
  handler: async (ctx, args) => {
    const used = await ctx.db
      .query('oauth_credential_uses')
      .withIndex('by_hash', (q) =>
        q.eq('kind', args.kind).eq('credential_hash', args.credentialHash),
      )
      .unique()
    if (!used) return
    const row = await byId(ctx, 'oauth_connections', used.connection_id)
    if (row && row.client_id === args.clientId && !row.revoked_at)
      await ctx.db.patch(row._id, {
        revoked_at: new Date().toISOString(),
        revocation_reason: 'credential_replay',
      })
  },
})

export const lookupAccess = internalQuery({
  args: { tokenHash: v.string(), resource: v.string() },
  handler: async (ctx, args) => {
    if (isDemoDeployment()) return null
    const token = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'oauthAccessToken',
      where: [{ field: 'token', value: args.tokenHash }],
    })) as {
      referenceId?: string
      userId?: string
      clientId: string
      expiresAt: number
      scopes: string[]
    } | null
    if (!token?.referenceId || !Number.isFinite(token.expiresAt) || token.expiresAt <= Date.now())
      return null
    const row = await byId(ctx, 'oauth_connections', token.referenceId)
    if (
      !row?.approved_at ||
      row.revoked_at ||
      row.resource !== args.resource ||
      token.userId !== row.auth_user_id ||
      token.clientId !== row.client_id ||
      token.scopes.some((scope) => !row.scopes.includes(scope))
    )
      return null
    const client = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'oauthClient',
      where: [{ field: 'clientId', value: row.client_id }],
    })) as { disabled?: boolean } | null
    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: '_id', value: row.auth_user_id }],
    })) as { banned?: boolean } | null
    const profile = await byId(ctx, 'profiles', row.profile_id)
    if (
      !client ||
      client.disabled ||
      !user ||
      user.banned ||
      !profile?.active ||
      profile.kind !== 'person' ||
      profile.auth_user_id !== row.auth_user_id ||
      profile.org_id !== row.org_id
    )
      return null
    return {
      connectionId: row.id,
      connectionRowId: row._id,
      profileId: row.profile_id,
      scopes: token.scopes,
    }
  },
})

export const touch = internalMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const row = await byId(ctx, 'oauth_connections', id)
    if (!row || row.revoked_at) return false
    await ctx.db.patch(row._id, { last_used_at: new Date().toISOString() })
    return true
  },
})
