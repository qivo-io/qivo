/** Explicit nonproduction operator provisioning. Credentials are server env values. */
import { hashPassword } from 'better-auth/crypto'
import { v } from 'convex/values'
import { components, internal } from '../_generated/api'
import { internalAction, internalMutation } from '../_generated/server'
import { deploymentEnvironment, deploymentOrigin, refuseProduction } from '../lib/deployment'
import { audit } from '../model/admin'
import { MARKETING_DEMO, marketingId } from './marketingDemoData'

const FIXTURE_NOTE = 'Private nonproduction fixture operator'
type AuthUser = {
  _id: string
  email: string
  emailVerified: boolean
  role?: string | null
  banned?: boolean | null
  banReason?: string | null
}

function operatorCredentials() {
  const email = process.env.QIVO_ADMIN_EMAIL?.trim().toLowerCase()
  const password = process.env.QIVO_ADMIN_PW
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Set a private QIVO_ADMIN_EMAIL before provisioning a fixture operator')
  }
  if (!password || password.length < 32 || password.length > 128) {
    throw new Error('Set QIVO_ADMIN_PW to a generated private password of 32 to 128 characters')
  }
  return { email, password }
}

/** The component account and operator membership commit in one transaction. */
export const provisionOperator = internalMutation({
  args: { email: v.string(), password_hash: v.string() },
  handler: async (ctx, { email, password_hash }) => {
    refuseProduction('operator')
    if (
      email !== operatorCredentials().email ||
      !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(password_hash)
    ) {
      throw new Error('Operator provisioning does not match the private configuration')
    }
    const existing = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: 'email', value: email }],
    })) as AuthUser | null
    if (existing) {
      const membership = await ctx.db
        .query('platform_admins')
        .withIndex('by_auth_user', (q) => q.eq('auth_user_id', existing._id))
        .unique()
      const seat = await ctx.db
        .query('profiles')
        .withIndex('by_auth', (q) => q.eq('auth_user_id', existing._id))
        .first()
      if (
        membership?.note !== FIXTURE_NOTE ||
        seat ||
        existing.banned ||
        existing.role !== 'admin'
      ) {
        throw new Error(
          'The operator address is already in use. Existing accounts are never adopted or reset.',
        )
      }
      return { auth_user_id: existing._id, created: false }
    }
    const now = Date.now()
    const user = (await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: 'user',
        data: {
          name: 'Fixture operator',
          email,
          emailVerified: true,
          role: 'admin',
          createdAt: now,
          updatedAt: now,
        },
      },
    })) as AuthUser
    await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: 'account',
        data: {
          accountId: user._id,
          providerId: 'credential',
          userId: user._id,
          password: password_hash,
          createdAt: now,
          updatedAt: now,
        },
      },
    })
    await ctx.db.insert('platform_admins', {
      auth_user_id: user._id,
      note: FIXTURE_NOTE,
      created_at: new Date(now).toISOString(),
    })
    return { auth_user_id: user._id, created: true }
  },
})

/** Repeating this command preserves the account, its password and all sessions. */
export const testOperator = internalAction({
  args: {},
  handler: async (ctx): Promise<{ auth_user_id: string; created: boolean }> => {
    refuseProduction('operator')
    const { email, password } = operatorCredentials()
    return await ctx.runMutation(internal.internal.operator.provisionOperator, {
      email,
      password_hash: await hashPassword(password),
    })
  },
})

const RETIRED_REASON = 'Published fixture credential retired'
const LEGACY_CREDENTIAL_SET = '00000000-0000-4000-8000-000000000000'

/** Retire only receipt-owned legacy fixtures. Data stays intact and dry run is the default. */
export const retireLegacyFixtures = internalMutation({
  args: { expected_site_url: v.string(), dry_run: v.optional(v.boolean()) },
  handler: async (ctx, { expected_site_url, dry_run = true }) => {
    deploymentEnvironment()
    if (deploymentOrigin() !== expected_site_url) {
      throw new Error('Fixture retirement requires the exact deployment SITE_URL')
    }
    const targets = new Set<string>()
    const profiles = []
    const record = await ctx.db
      .query('marketing_demo')
      .withIndex('by_key', (q) => q.eq('key', 'northstar-labs'))
      .unique()
    if (record?.credential_set_id === LEGACY_CREDENTIAL_SET) {
      if (record.org_id !== (await marketingId('northstar-labs', 'org'))) {
        throw new Error('Legacy fixture ownership could not be verified')
      }
      const roster = await ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', record.org_id))
        .collect()
      if (roster.length !== MARKETING_DEMO.people.length) {
        throw new Error('The legacy fixture roster changed. Review it manually before retirement.')
      }
      for (const person of MARKETING_DEMO.people) {
        const profileId = await marketingId('northstar-labs', `person:${person.key}`)
        const profile = roster.find((row) => row.id === profileId)
        if (!profile || profile.kind !== person.kind) {
          throw new Error('Legacy fixture profile ownership could not be verified')
        }
        profiles.push(profile)
        if (person.kind === 'agent') continue
        const userId = record.auth_ids[person.key]
        const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: 'user',
          where: [{ field: '_id', value: userId }],
        })) as AuthUser | null
        if (
          !user ||
          user.email !== `${person.key}@demo.qivo.io` ||
          profile.auth_user_id !== userId
        ) {
          throw new Error('Legacy fixture login ownership could not be verified')
        }
        const elevated = await ctx.db
          .query('platform_admins')
          .withIndex('by_auth_user', (q) => q.eq('auth_user_id', userId))
          .first()
        if (elevated || user.role?.split(',').includes('admin')) {
          throw new Error('A legacy fixture account has operator privileges. Review it manually.')
        }
        const seats = await ctx.db
          .query('profiles')
          .withIndex('by_auth', (q) => q.eq('auth_user_id', userId))
          .collect()
        if (seats.some((seat) => seat.org_id !== record.org_id)) {
          throw new Error(
            'A legacy fixture account has access outside its owned organization. Review it manually.',
          )
        }
        targets.add(userId)
      }
    }
    // The old address is a retirement identifier, never a provisioned login.
    const operator = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: 'email', value: 'operator@demo.local' }],
    })) as AuthUser | null
    let operatorMembership = null
    if (operator) {
      operatorMembership = await ctx.db
        .query('platform_admins')
        .withIndex('by_auth_user', (q) => q.eq('auth_user_id', operator._id))
        .unique()
      const seat = await ctx.db
        .query('profiles')
        .withIndex('by_auth', (q) => q.eq('auth_user_id', operator._id))
        .first()
      if (
        seat ||
        (!operatorMembership?.note.startsWith('Test operator for the admin smoke drive') &&
          operator.banReason !== RETIRED_REASON)
      ) {
        throw new Error(
          'The legacy operator no longer matches its fixture marker. Review it manually.',
        )
      }
      targets.add(operator._id)
    }
    let replacementRequired = false
    if (operatorMembership) {
      replacementRequired = true
      for (const member of await ctx.db.query('platform_admins').collect()) {
        if (targets.has(member.auth_user_id)) continue
        const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: 'user',
          where: [{ field: '_id', value: member.auth_user_id }],
        })) as AuthUser | null
        if (user && !user.banned && user.emailVerified && user.role?.split(',').includes('admin')) {
          replacementRequired = false
          break
        }
      }
    }
    const summary = {
      dry_run,
      accounts: targets.size,
      profiles: profiles.length,
      operator_replacement_required: replacementRequired,
    }
    if (dry_run) return summary
    if (replacementRequired)
      throw new Error(
        'Provision a private replacement operator before retiring the legacy operator',
      )
    const now = new Date().toISOString()
    let changedAccounts = 0
    for (const userId of targets) {
      const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: 'user',
        where: [{ field: '_id', value: userId }],
      })) as AuthUser | null
      if (
        user?.banned &&
        user.banReason === RETIRED_REASON &&
        !user.emailVerified &&
        user.role === 'user'
      )
        continue
      changedAccounts++
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: 'user',
          where: [{ field: '_id', value: userId }],
          update: {
            banned: true,
            banReason: RETIRED_REASON,
            banExpires: null,
            role: 'user',
            emailVerified: false,
            updatedAt: Date.now(),
          },
        },
      })
      await ctx.runMutation(components.betterAuth.adapter.updateMany, {
        input: {
          model: 'account',
          where: [
            { field: 'userId', value: userId },
            { field: 'providerId', value: 'credential' },
          ],
          update: { password: null, updatedAt: Date.now() },
        },
        paginationOpts: { numItems: 200, cursor: null },
      })
      for (const model of [
        'session',
        'oauthAccessToken',
        'oauthRefreshToken',
        'oauthConsent',
      ] as const) {
        let cursor: string | null = null
        for (;;) {
          const page: { isDone: boolean; continueCursor: string } = await ctx.runMutation(
            components.betterAuth.adapter.deleteMany,
            {
              input: { model, where: [{ field: 'userId', value: userId }] },
              paginationOpts: { numItems: 200, cursor },
            },
          )
          if (page.isDone) break
          cursor = page.continueCursor
        }
      }
      const connections = await ctx.db
        .query('oauth_connections')
        .withIndex('by_auth_user', (q) => q.eq('auth_user_id', userId))
        .collect()
      for (const connection of connections) {
        if (!connection.revoked_at)
          await ctx.db.patch(connection._id, {
            revoked_at: now,
            revocation_reason: 'fixture_retirement',
          })
      }
    }
    for (const profile of profiles) {
      if (profile.active) await ctx.db.patch(profile._id, { active: false })
      for (const table of ['mcp_tokens', 'agent_keys'] as const) {
        const tokens = await ctx.db
          .query(table)
          .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
          .collect()
        for (const token of tokens)
          if (!token.revoked_at) await ctx.db.patch(token._id, { revoked_at: now })
      }
    }
    if (operatorMembership) await ctx.db.delete(operatorMembership._id)
    if (changedAccounts) {
      await audit(ctx, {
        actor_email: 'cli',
        action: 'retire_legacy_fixture_credentials',
        detail: { accounts: changedAccounts, profiles: profiles.length },
      })
    }
    return summary
  },
})
