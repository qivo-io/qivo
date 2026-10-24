/* convex/_generated/api.d.ts must list every Convex module. `npx convex dev`
 * and deploys regenerate it, but CI typechecks the committed copy, and that
 * copy fell behind twice without any check noticing. Codegen itself needs a
 * deployment, so this applies the Convex CLI's module rules (bundler
 * entryPoints in convex 1.48, which scripts/check-convex-runtime.mjs pins) to
 * the source tree instead.
 *
 * To fix a reported difference, run `npx convex dev` (or `npx convex codegen`)
 * against a development deployment and commit convex/_generated, or add the
 * missing lines by hand in the same sorted position. */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.jsx']

/** Module paths codegen lists for a Convex directory, such as "lib/review". */
export function sourceModules(convexDir) {
  const modules = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) {
        // a directory with its own convex.config.ts is a nested component
        if (!existsSync(join(file, 'convex.config.ts'))) walk(file)
        continue
      }
      const rel = relative(convexDir, file)
      const base = entry.name
      const ext = EXTENSIONS.find((e) => rel.endsWith(e))
      // _deps/ is reserved for bundled dependencies (the CLI refuses code there)
      if (!ext || rel.startsWith(`_generated${sep}`) || rel.startsWith(`_deps${sep}`)) continue
      if (base.startsWith('.') || base.startsWith('#') || rel.includes(' ')) continue
      if (base === 'schema.ts' || base === 'schema.js') continue
      if ((base.match(/\./g) || []).length > 1) continue
      // TypeScript files without an import or export are not modules
      const typescript = ext === '.ts' || ext === '.tsx'
      if (typescript && !/^\s{0,100}(import|export)/m.test(readFileSync(file, 'utf8'))) continue
      modules.push(rel.slice(0, -ext.length).split(sep).join('/'))
    }
  }
  walk(convexDir)
  return modules.sort()
}

/** Module paths the committed api.d.ts names, once as an import and once as
    an entry of the fullApi type map. A module counts as listed only when it
    appears in both. */
export function generatedModules(apiDts) {
  const imports = [...apiDts.matchAll(/^import type \* as \w+ from "\.\.\/(.+)\.js";$/gm)]
  // only the fullApi block counts; codegen quotes keys that are not plain
  // identifiers ("lib/review")
  const fullApi = apiDts.match(/^declare const fullApi: ApiFromModules<\{$([\s\S]*?)^\}>;$/m)
  const entries = [...(fullApi?.[1] ?? '').matchAll(/^ {2}(?:"([^"]+)"|(\w+)): typeof \w+;$/gm)]
  return {
    imports: imports.map((m) => m[1]).sort(),
    entries: entries.map((m) => m[1] ?? m[2]).sort(),
  }
}

/** Differences between the source tree and the committed api.d.ts. */
export function apiModuleDrift(convexDir) {
  const source = sourceModules(convexDir)
  const { imports, entries } = generatedModules(
    readFileSync(join(convexDir, '_generated/api.d.ts'), 'utf8'),
  )
  const named = [...new Set([...imports, ...entries])]
  return {
    missing: source.filter((m) => !imports.includes(m) || !entries.includes(m)),
    extra: named.filter((m) => !source.includes(m)).sort(),
  }
}
