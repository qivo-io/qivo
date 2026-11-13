// Keep generated provider fields separate from local indexes.
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import { tables as generatedTables } from './schema.generated'

/* The adapter reads a table through an index only when one starts with every
 * field the lookup compares for equality, and scans the table otherwise. Its
 * generator knows the lookups of Better Auth itself, not those of the OAuth
 * provider, so the indexes for them are added here, next to Qivo's own. */
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
    .index('accountId_providerId_userId', ['accountId', 'providerId', 'userId'])
    .index('providerId_userId', ['providerId', 'userId'])
    .index('userId', ['userId']),
  /* The provider finds a consent by its client and login, and with the
   * connection it belongs to (lib/oauthProvider.ts consentReferenceId).
   * betterAuth/oauth.ts clientInUse reads `clientId_userId` too. */
  oauthConsent: generatedTables.oauthConsent
    .index('clientId_userId', ['clientId', 'userId'])
    .index('clientId_referenceId_userId', ['clientId', 'referenceId', 'userId']),
  /* The provider finds the tokens an authorization code issued by the code's
   * id, to revoke them when the code is used again. When a revocation loses
   * its refresh token to a rotation, it deletes the access tokens of the
   * client and login, and the refresh tokens of the client and login that
   * Qivo narrows to the connection (lib/oauthAdapter.ts). The nightly token
   * cleanup finds the rows that protect nothing any more by the last indexes
   * (oauth.ts deleteSpentTokens). */
  oauthAccessToken: generatedTables.oauthAccessToken
    .index('authorizationCodeId', ['authorizationCodeId'])
    .index('clientId_userId', ['clientId', 'userId'])
    .index('expiresAt', ['expiresAt']),
  oauthRefreshToken: generatedTables.oauthRefreshToken
    .index('authorizationCodeId', ['authorizationCodeId'])
    .index('clientId_referenceId_userId', ['clientId', 'referenceId', 'userId'])
    .index('expiresAt', ['expiresAt'])
    .index('revoked', ['revoked']),
}

export default defineSchema(tables)
