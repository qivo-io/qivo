/* The Better Auth component, defined in-repo. Its schema (schema.ts) holds
 * the tables of the Better Auth options Qivo uses, the admin plugin's fields
 * among them, and its functions (adapter.ts) come from Qivo's copy of the
 * Convex adapter (vendor/convex-better-auth). */
import { defineComponent } from 'convex/server'

const component = defineComponent('betterAuth')

export default component
