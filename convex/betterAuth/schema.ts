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
  /* `sessionId_expiresAt` lets a session's end revoke only its live access
   * tokens (oauth.ts revokeSessionAccessTokens), however many expired ones a
   * long session holds. */
  oauthAccessToken: generatedTables.oauthAccessToken.index('sessionId_expiresAt', [
    'sessionId',
    'expiresAt',
  ]),
  oauthConsent: generatedTables.oauthConsent.index('clientId_referenceId_userId', ['clientId', 'referenceId', 'userId']),
}

export default defineSchema(tables)
