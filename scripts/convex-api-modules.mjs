/* convex/_generated/api.d.ts must list every Convex module. `npx convex dev`
 * and deploys regenerate it, but CI typechecks the committed copy, and that
 * copy fell behind twice without any check noticing. Codegen itself needs a
 * deployment, so this applies the Convex CLI's module rules (bundler
 * entryPoints in convex 1.45) to the source tree instead.
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
      if (!ext || rel.startsWith(`_generated${sep}`) || rel.startsWith('_deps')) continue
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

/** Module paths the committed api.d.ts imports. */
export function generatedModules(apiDts) {
  return [...apiDts.matchAll(/^import type \* as \w+ from "\.\.\/(.+)\.js";$/gm)]
    .map((m) => m[1])
    .sort()
}

/** Differences between the source tree and the committed api.d.ts. */
export function apiModuleDrift(convexDir) {
  const source = sourceModules(convexDir)
  const listed = generatedModules(readFileSync(join(convexDir, '_generated/api.d.ts'), 'utf8'))
  return {
    missing: source.filter((m) => !listed.includes(m)),
    extra: listed.filter((m) => !source.includes(m)),
  }
}
