import { createApi } from '@convex-dev/better-auth'
import { createAuthOptions } from '../auth'
import schema from './schema'

/* createApi calls the options factory at module scope, and this module is
 * analyzed inside the component sandbox, where no deployment env vars exist —
 * schemaOnly builds the options without requiring SITE_URL. Safe because
 * createApi only derives table shapes from them; nothing in the component
 * serves an origin-checked request. */
export const { create, findOne, findMany, updateOne, updateMany, deleteOne, deleteMany } =
  createApi(schema, (ctx) => createAuthOptions(ctx, { schemaOnly: true }))
