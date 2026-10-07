import { betterAuth } from 'better-auth/minimal'
import { createAuthOptions } from '../auth'

/* Static instance consumed only by `npx auth generate` (schema regeneration —
 * see schema.ts header). Never called at runtime — and analyzed inside the
 * component sandbox, where no deployment env vars exist, so it builds its
 * options schemaOnly rather than requiring SITE_URL. */
export const auth = betterAuth(createAuthOptions({} as never, { schemaOnly: true }))
