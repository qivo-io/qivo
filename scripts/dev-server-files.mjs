import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isFileLoadingAllowed, normalizePath } from 'vite'

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

/**
 * The real path of `file` when the server's file rules refuse it, else
 * undefined. A path that does not exist names nothing to serve. Any other
 * error refuses the path itself.
 */
function refusedRealPath(config, file) {
  let real
  try {
    real = normalizePath(realpathSync.native(file))
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? undefined : file
  }
  return isFileLoadingAllowed(config, real) ? undefined : real
}

/** The files a request URL can name: an /@fs/ path, or a path under the
 * root or the public directory, decoded the ways Vite's middlewares do. */
function requestedFiles(config, url) {
  const path = url.split(/[?#]/, 1)[0]
  const decoded = new Set([path])
  for (const decode of [decodeURI, decodeURIComponent]) {
    try {
      decoded.add(decode(path))
    } catch {}
  }
  return [...decoded].flatMap((name) => {
    if (name.startsWith('/@fs/')) return [name.slice('/@fs'.length)]
    const files = [join(config.root, name)]
    if (config.publicDir) files.push(join(config.publicDir, name))
    return files
  })
}

/** The paths under `directory`, following symlinks the way Vite copies the
 * public directory into a build, each real directory once. */
function linkedPaths(directory, seen = new Set()) {
  const real = realpathSync.native(directory)
  if (seen.has(real)) return []
  seen.add(real)
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    const isDirectory = statSync(path, { throwIfNoEntry: false })?.isDirectory()
    return isDirectory ? [path, ...linkedPaths(path, seen)] : [path]
  })
}

/**
 * Refuses dev server requests for a file whose real path the server.fs rules
 * refuse. Those rules match the requested path, so a symlink in an allowed
 * directory to a file in dev-temp/, the fixture credentials directory or any
 * other refused place would otherwise be served.
 *
 * The check runs before Vite serves files, and again after the HTML fallback
 * has added `.html` or `index.html`, at one realpath call per candidate
 * file. A module that Vite's resolver finds, such as `/src/link` for
 * `/src/link.js`, already resolves to its real path, which Vite checks.
 *
 * A build copies the public directory and the files its links point to, so
 * a build fails while the public directory links to a refused file.
 */
export function refuseLinkedFiles() {
  let config
  return {
    name: 'qivo-refuse-linked-files',
    configResolved(resolved) {
      config = resolved
    },
    buildStart() {
      const { command, publicDir, build } = config
      if (command !== 'build' || !build.copyPublicDir || !publicDir || !existsSync(publicDir))
        return
      const refused = linkedPaths(publicDir).filter((path) => refusedRealPath(config, path))
      if (refused.length > 0)
        this.error(
          `The public directory links to files the dev server refuses: ${refused.map((path) => relative(config.root, path)).join(', ')}`,
        )
    },
    configureServer(server) {
      const refuse = (req, res, next) => {
        const files = requestedFiles(config, req.url ?? '/')
        if (!files.some((file) => refusedRealPath(config, file))) return next()
        config.logger.warn(`Refused ${req.url}: its real path is not served`)
        res.statusCode = 403
        res.end('Restricted')
      }
      server.middlewares.use(refuse)
      return () => server.middlewares.use(refuse)
    },
  }
}
