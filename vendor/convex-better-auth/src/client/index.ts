/* Copied from get-convex/better-auth src/client/index.ts at 3f41cbcf
 * (Apache-2.0, see ../../LICENSE). Qivo changed it: it leaves out the check
 * of the installed convex version, which package.json pins, and the
 * exports Qivo does not use. */
export type { CreateAuth, GenericCtx } from '../utils'
export { convexAdapter } from './adapter'
export { createApi } from './create-api'
export type { AuthFunctions, Triggers } from './create-client'
export { createClient } from './create-client'
