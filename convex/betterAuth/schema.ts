// Keep generated provider fields separate from local performance indexes.
import { defineSchema } from 'convex/server'
import { tables as generatedTables } from './schema.generated'

export const tables = {
  ...generatedTables,
  oauthConsent: generatedTables.oauthConsent.index('clientId_referenceId_userId', ['clientId', 'referenceId', 'userId']),
}

export default defineSchema(tables)
