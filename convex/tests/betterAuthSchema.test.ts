/* The component schema Qivo builds from the generated one, and the one
 * change Qivo makes to the tables the OAuth provider declares. The adapter
 * itself is the published @convex-dev/better-auth, which tests its own
 * reads and writes. */
import { oauthProvider } from '@better-auth/oauth-provider'
import { getAuthTables } from 'better-auth/db'
import { describe, expect, it } from 'vitest'
import { createAuthOptions } from '../auth'
import authSchema from '../betterAuth/schema'
import { tables as generated } from '../betterAuth/schema.generated'

type Declared = Record<
  string,
  { fields?: unknown; indexes?: readonly { fields: readonly string[]; unique?: boolean }[] }
>

/** The unique indexes of several fields that `tables` declares, each as
 * `table (fields)`. */
const compoundUnique = (tables: Declared) =>
  Object.entries(tables).flatMap(([name, table]) =>
    (table.indexes ?? [])
      .filter((index) => index.unique && index.fields.length > 1)
      .map((index) => `${name} (${index.fields.join(', ')})`),
  )

describe('unique indexes of several fields, which the Convex adapter refuses', () => {
  /* A release that declares another fails here. Decide for that index what
   * lib/oauthProvider.ts withOrdinaryLinkIndex decided for this one: whether
   * anything Qivo serves can store its fields twice, and what a second row
   * would change. */
  it("are one in the OAuth provider as shipped, a client's link to a resource", () => {
    const provider = oauthProvider({ loginPage: '/sign-in', consentPage: '/consent' })
    expect(compoundUnique(provider.schema)).toEqual(['oauthClientResource (clientId, resourceId)'])
  })

  it('are none in the tables Qivo hands the adapter', () => {
    const tables = getAuthTables(createAuthOptions({} as never, { schemaOnly: true }))
    expect(compoundUnique(tables)).toEqual([])
    // the link is still declared as an index, only not as a unique one
    expect(tables.oauthClientResource.indexes).toEqual([
      { fields: ['clientId', 'resourceId'], unique: false },
    ])
  })
})

describe('the component schema', () => {
  it('keeps every generated field and index of the account table it extends', () => {
    const ours = authSchema.tables.account
    const theirs = generated.account
    expect(Object.keys(ours.validator.fields)).toEqual(
      expect.arrayContaining(Object.keys(theirs.validator.fields)),
    )
    expect(ours[' indexes']()).toEqual(theirs[' indexes']())
  })

  it("indexes a client's link to a resource by both fields, as Qivo's lookups read it", () => {
    expect(authSchema.tables.oauthClientResource[' indexes']()).toContainEqual({
      indexDescriptor: 'clientId_resourceId',
      fields: ['clientId', 'resourceId'],
    })
  })
})
