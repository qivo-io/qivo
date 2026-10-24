// Keep generated provider fields separate from local performance indexes.
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import { tables as generatedTables } from './schema.generated'

export const tables = {
  ...generatedTables,
  /* `microsoftTenantId` is the `tid` of a Microsoft account, the person's
   * organization in Microsoft Entra, which with `accountId` (the `oid`) names
   * the person in any login system (lib/microsoftAccounts.ts). Better Auth
   * does not know the field, so it never reads, writes or returns it. */
  account: defineTable({
    ...generatedTables.account.validator.fields,
    microsoftTenantId: v.optional(v.string()),
  })
    .index('accountId', ['accountId'])
    .index('accountId_providerId', ['accountId', 'providerId'])
    .index('providerId_userId', ['providerId', 'userId'])
    .index('userId', ['userId']),
  // Better Auth 1.6 wrote `public` on every client it registered, and Convex
  // refuses a schema that a stored row breaks, so the two fields 1.7 dropped
  // stay optional here. internal/oauthClientBackfill.ts maps them to
  // applicationType and removes them; once it has run on every deployment, a
  // later change removes these two fields and the backfill.
  oauthClient: defineTable({
    ...generatedTables.oauthClient.validator.fields,
    public: v.optional(v.union(v.null(), v.boolean())),
    type: v.optional(v.union(v.null(), v.string())),
  })
    .index('clientId', ['clientId'])
    .index('userId', ['userId']),
  oauthConsent: generatedTables.oauthConsent.index('clientId_referenceId_userId', ['clientId', 'referenceId', 'userId']),
}

export default defineSchema(tables)
