/* Copied from get-convex/better-auth src/plugins/convex/client.ts at 3f41cbcf
 * (Apache-2.0, see ../../../LICENSE). Unchanged apart from formatting. */
import type { BetterAuthClientPlugin } from 'better-auth/client'
import { VERSION } from '../../version'
import type { convex } from './index'

/** The browser side of the convex() plugin, which types its endpoints. */
export const convexClient = () =>
  ({
    id: 'convex',
    version: VERSION,
    $InferServerPlugin: {} as ReturnType<typeof convex>,
  }) satisfies BetterAuthClientPlugin
