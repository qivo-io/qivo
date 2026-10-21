import { normalizePath } from 'vite'

/* Development only. The dev server serves every file under the checkout
   unless server.fs.deny refuses it, and reloads open pages when a watched
   file changes. These rules keep local secrets and disposable files out of
   both.

   Directories that hold whole checkouts, such as dev-temp/ and .claude/, can
   themselves contain this checkout, so the rules name this checkout's own
   directories by their full paths, never a directory of that name on the
   way. */

/** Escapes a literal path for Vite's picomatch globs. */
const literalGlob = (path) => path.replace(/[\\()[\]{}*?!+@|]/g, '\\$&')

/**
 * The server.watch and server.fs options for the checkout at `root`.
 *
 * The watcher rewrites a glob's backslashes to slashes before matching, which
 * breaks an escaped path, so the watch rule compares path prefixes instead.
 * server.fs.deny takes globs only and matches them without that rewrite.
 */
export function devServerFiles(root) {
  const checkout = normalizePath(root).replace(/\/$/, '')
  const devTemp = `${checkout}/dev-temp`
  return {
    // Writing into dev-temp/ must not reload the pages under test.
    watch: {
      ignored: [
        (path) => {
          const file = normalizePath(path)
          return file === devTemp || file.startsWith(`${devTemp}/`)
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
        '.credentials.json',
        // Ignored local directories: disposable files and fixture
        // credentials, demo journals and review screenshots, Vercel's pulled
        // settings, and other agent sessions' checkouts with their own
        // dev-temp/.
        ...['dev-temp', '.local', '.vercel', '.claude'].flatMap((name) => {
          const directory = literalGlob(`${checkout}/${name}`)
          return [directory, `${directory}/**`]
        }),
      ],
    },
  }
}
