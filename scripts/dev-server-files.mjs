import { realpathSync } from 'node:fs'
import { normalizePath } from 'vite'

/* Development only. The dev server serves every file under the checkout
   unless server.fs.deny refuses it, and reloads open pages when a watched
   file changes. These rules keep local secrets and disposable files out of
   both.

   Directories that hold whole checkouts, such as dev-temp/ and .claude/, can
   themselves contain this checkout, so the rules name this checkout's own
   directories by their full paths, never a directory of that name on the
   way. */

/** Ignored local directories: disposable files and fixture credentials,
 * demo journals and review screenshots, Vercel's pulled settings, other
 * agent sessions' checkouts with their own dev-temp/, and admin console
 * screenshots. */
const LOCAL = ['dev-temp', '.local', '.vercel', '.claude', 'scripts/shots']

/** Escapes a literal path for Vite's picomatch globs. */
const literalGlob = (path) => path.replace(/[\\()[\]{}*?!+@|]/g, '\\$&')

/**
 * The server.watch and server.fs options for the checkout at `root`.
 *
 * Vite resolves symlinks in its root, so the rules name the local
 * directories under both the given and the resolved checkout path. The
 * watcher rewrites a glob's backslashes to slashes before matching, which
 * breaks an escaped path, so the watch rule compares path prefixes instead.
 * server.fs.deny takes globs only and matches them without that rewrite.
 */
export function devServerFiles(root) {
  const checkouts = new Set(
    [root, realpathSync.native(root)].map((path) => normalizePath(path).replace(/\/$/, '')),
  )
  const directories = [...checkouts].flatMap((checkout) =>
    LOCAL.map((name) => `${checkout}/${name}`),
  )
  return {
    watch: {
      ignored: [
        (path) => {
          const file = normalizePath(path)
          return directories.some(
            (directory) => file === directory || file.startsWith(`${directory}/`),
          )
        },
      ],
    },
    fs: {
      // A deny list replaces Vite's own, so it repeats Vite's defaults.
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem,key,p12,pfx,cer,der}',
        '.npmrc',
        '.yarnrc.yml',
        '**/.git/**',
        // Credential files anywhere, such as a stash an older contract pass
        // left in tests/contract/.credentials.json.
        'credentials.json',
        '*.credentials.json',
        ...directories.flatMap((directory) => {
          const glob = literalGlob(directory)
          return [glob, `${glob}/**`]
        }),
      ],
    },
  }
}
