import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, posix, relative, resolve } from 'node:path'
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
 *
 * The watcher follows symlinks, so the watch rule also ignores a path whose
 * real path is in a local directory or the checkout's .git, at one realpath
 * call per check. A link such as src/x.html to dev-temp/report.html would
 * otherwise reload open pages on every write to the report. Turning off
 * followSymlinks instead would stop the watcher from following a link to an
 * allowed source too. A local directory that is itself a link counts under
 * its real path as well. Each check looks for those links again, so a local
 * directory created, removed or replaced by a link while the server runs
 * counts from the next check on. That takes an lstat call per local
 * directory, about 8 microseconds per check on Linux, and a realpath call
 * for a directory that is a link. The env files at the checkout's root keep
 * being watched wherever they link, because Vite restarts the server when
 * one changes.
 */
export function devServerFiles(root) {
  const checkouts = new Set(
    [root, realpathSync.native(root)].map((path) => normalizePath(path).replace(/\/$/, '')),
  )
  const directories = [...checkouts].flatMap((checkout) =>
    LOCAL.map((name) => `${checkout}/${name}`),
  )
  const within = (file, directory) => file === directory || file.startsWith(`${directory}/`)
  // Vite's own watch rules ignore .git by the watched path only.
  const named = [...directories, ...[...checkouts].map((checkout) => `${checkout}/.git`)]
  // Each named directory with its paths inside the checkout, any of which
  // makes it lead elsewhere when it is a link, such as scripts/ for
  // scripts/shots/.
  const steps = [...checkouts].flatMap((checkout) =>
    [...LOCAL, '.git'].map((name) => {
      const parts = name.split('/')
      return {
        directory: `${checkout}/${name}`,
        paths: parts.map((_, i) => `${checkout}/${parts.slice(0, i + 1).join('/')}`),
      }
    }),
  )
  const isLink = (path) => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true
  // The real paths of the local directories that link elsewhere now, unless
  // one links to a directory holding this checkout, which would ignore every
  // source. One lstat call per path finds the links, so realpath runs only
  // for a directory that is one.
  const linked = () =>
    steps.flatMap(({ directory, paths }) => {
      if (!paths.some(isLink)) return []
      let real
      try {
        real = normalizePath(realpathSync.native(directory))
      } catch {
        return []
      }
      return [...checkouts].some((checkout) => within(checkout, real)) ? [] : [real]
    })
  const inAny = (file, directories) => directories.some((directory) => within(file, directory))
  const isEnvFile = (file) =>
    checkouts.has(posix.dirname(file)) && posix.basename(file).startsWith('.env')
  return {
    watch: {
      ignored: [
        (path) => {
          const file = normalizePath(path)
          if (inAny(file, named)) return true
          if (isEnvFile(file)) return false
          const unwatched = [...named, ...linked()]
          if (inAny(file, unwatched)) return true
          // A path that cannot be resolved, such as a deleted file, names
          // nothing the watcher could follow.
          try {
            return inAny(normalizePath(realpathSync.native(path)), unwatched)
          } catch {
            return false
          }
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
 * The directories whose files Vite serves, under their given and their real
 * paths: server.fs.allow and the dependency cache. Either can be a link, for
 * example a node_modules shared with another checkout.
 */
function servedDirectories(config) {
  return [...config.server.fs.allow, config.cacheDir].flatMap((directory) => {
    try {
      return [normalizePath(directory), normalizePath(realpathSync.native(directory))]
    } catch {
      return [normalizePath(directory)]
    }
  })
}

/**
 * Whether a symlink on the way to `file` leads to a place the server.fs rules
 * refuse: a denied path, or one outside every directory Vite serves from. A
 * path without a link is left to Vite's own checks, and one that cannot be
 * resolved names nothing Vite could open.
 */
function refusedLink(config, served, file) {
  let real
  try {
    real = normalizePath(realpathSync.native(file))
  } catch {
    return false
  }
  if (real === normalizePath(file)) return false
  // Vite's compiled server.fs.deny, the glob its own checks match.
  if (config.fsDenyGlob(real)) return true
  const inside = (directory) => real === directory || real.startsWith(`${directory}/`)
  return !config.safeModulePaths.has(real) && !served.some(inside)
}

/** A Windows drive at the start of an /@fs/ path. */
const VOLUME = /^\/[A-Z]:/i

/**
 * The files a request URL can name in Vite's dev server. Each middleware
 * parses the URL its own way, so the path is taken both as sent and as a
 * browser URL would normalize it, decoded every way Vite decodes it, with and
 * without the base. It names an /@fs/ path, or a path under the root or the
 * public directory, each with the `index` file Vite's static server tries.
 */
function requestedFiles(config, url) {
  const sent = url.split(/[?#]/, 1)[0]
  const forms = [sent]
  try {
    forms.push(new URL(`http://localhost${sent}`).pathname)
  } catch {}
  const names = new Set()
  for (const form of forms)
    for (const decode of [(path) => path, decodeURI, decodeURIComponent]) {
      try {
        const name = posix.resolve('/', decode(form))
        names.add(name)
        if (config.base !== '/' && name.startsWith(config.base))
          names.add(posix.resolve('/', name.slice(config.base.length)))
      } catch {}
    }
  return [...names].flatMap((name) => {
    let files
    if (name.startsWith('/@fs/')) {
      const file = name.slice('/@fs'.length)
      // Windows: Vite resolves the path with its drive, and serves the file
      // without the drive from the current one.
      files = VOLUME.test(file) ? [file.slice(1), resolve('/', file.replace(VOLUME, ''))] : [file]
    } else {
      files = [config.root, config.publicDir].filter(Boolean).map((dir) => join(dir, name))
    }
    return files.flatMap((file) => [file, join(file, 'index')])
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
 * Refuses dev server requests for a file reached through a symlink to a place
 * the server.fs rules refuse. Those rules match the requested path, so a link
 * in an allowed directory to a file in dev-temp/, the fixture credentials
 * directory or anywhere outside the checkout would otherwise be served.
 * Files reached without a link keep Vite's own checks.
 *
 * The check answers 403 before Vite serves files, and again after the HTML
 * fallback has added `.html` or `index.html`, at a few realpath calls per
 * request. A module Vite's resolver found, such as `/@id//@fs/<path>?raw`, is
 * checked again when it loads and answered with a 404 that names no path.
 *
 * A build copies the public directory and the files its links point to, so
 * a build fails while the public directory links to a refused file.
 */
export function refuseLinkedFiles() {
  let config
  let served
  return {
    name: 'qivo-refuse-linked-files',
    // Loads modules before Vite's own loaders read the file.
    enforce: 'pre',
    configResolved(resolved) {
      config = resolved
      served = servedDirectories(config)
    },
    buildStart() {
      const { command, publicDir, build } = config
      if (command !== 'build' || !build.copyPublicDir || !publicDir || !existsSync(publicDir))
        return
      const refused = linkedPaths(publicDir).filter((path) => refusedLink(config, served, path))
      if (refused.length > 0)
        this.error(
          `The public directory links to files the dev server refuses: ${refused.map((path) => relative(config.root, path)).join(', ')}`,
        )
    },
    configureServer(server) {
      const refuse = (req, res, next) => {
        const files = requestedFiles(config, req.url ?? '/')
        if (!files.some((file) => refusedLink(config, served, file))) return next()
        config.logger.warn(`Refused ${req.url}: it links to a file that is not served`)
        res.statusCode = 403
        res.end('Restricted')
      }
      server.middlewares.use(refuse)
      return () => server.middlewares.use(refuse)
    },
    load(id) {
      const file = id.split('?', 1)[0]
      if (config.command !== 'serve' || id[0] === '\0' || !isAbsolute(file)) return
      if (!refusedLink(config, served, file)) return
      config.logger.warn(`Refused ${id}: it links to a file that is not served`)
      // Vite's transform middleware passes this on, which ends in a 404 that
      // names no path.
      throw Object.assign(new Error(`Refused ${id}`), { code: 'ERR_LOAD_URL' })
    },
  }
}
