/* The app's live part registry (src/store/liveParts.ts) and its transport
 * (src/lib/liveQueries.ts) for Node scripts, with the field prints the app's
 * writes send as `expected` (convex/lib/fieldPrints.ts). It loads after scripts/limits.mjs
 * has checked that this Node loads TypeScript, for the reason that module
 * gives. The app's modules import each other without a file extension, as
 * Vite resolves them, so this module first resolves such a relative import
 * to its .ts or .js file. */
import './limits.mjs'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!/^\.{1,2}\//.test(specifier) || /\.[cm]?[jt]s$/.test(specifier) || !context.parentURL)
      return nextResolve(specifier, context)
    for (const ext of ['.ts', '.js']) {
      const url = new URL(specifier + ext, context.parentURL)
      if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context)
    }
    return nextResolve(specifier, context)
  },
})

export const { createLiveQueries } = await import('../src/lib/liveQueries.ts')
export const { createLiveParts } = await import('../src/store/liveParts.ts')
export const { FIELD_CHANGED, printOf, trimmedForm } = await import('../convex/lib/fieldPrints.ts')
