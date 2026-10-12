import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render } from './md.mjs'
import { ORIGIN } from './theme.mjs'

// The website root, which holds the homepage checked by `/#anchor` links.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Page files are flat, lowercase Markdown names inside docs/guide. */
const PAGE_FILE = /^[a-z0-9][a-z0-9-]*\.md$/
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** The agent guides in public/. Their links to /docs/ pages must keep working. */
const AGENT_GUIDES = ['llms.txt', 'skill.md', 'auth.md']
/** A URL with a scheme or a root path, rather than a path relative to the page. */
const NOT_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|\/)/i

const IMAGE_TYPES = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

function within(root, file) {
  const path = relative(root, file)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/** The decoded text, or null when it holds a malformed percent escape. */
function decode(text) {
  try {
    return decodeURIComponent(text)
  } catch {
    return null
  }
}

function readLocal(root, file) {
  const path = resolve(root, file)
  if (
    !within(root, path) ||
    !statSync(path).isFile() ||
    !within(realpathSync(root), realpathSync(path))
  )
    throw new Error(`File must be inside ${root}`)
  return readFileSync(path)
}

/** Resolve, render and validate the whole guide. `contentDir` is the
 * application's docs/guide and `publicDir` its public/ directory, which holds
 * the agent guides. `errors` lists every problem found, one line each, and the
 * guide may be published only when it is empty. scripts/docs-contract.mjs
 * reports these errors without building the website. */
export function inspectDocs({ contentDir, publicDir }) {
  if (!contentDir || !publicDir) throw new Error('inspectDocs needs contentDir and publicDir')
  contentDir = resolve(contentDir)
  publicDir = resolve(publicDir)
  let metadata
  try {
    metadata = JSON.parse(readFileSync(resolve(contentDir, 'pages.json'), 'utf8'))
  } catch (error) {
    return { errors: [`pages.json: ${error.message}`] }
  }
  if (!metadata?.overview || !Array.isArray(metadata.pages) || !metadata.pages.length)
    return { errors: ['pages.json needs an overview and pages'] }

  const errors = []
  const paths = new Set()
  const sources = new Map()
  const orders = new Set()
  /** The page for one pages.json entry, or null when its file cannot be read. */
  const load = (entry, index) => {
    const overview = index === 0
    const label = `pages.json ${overview ? 'overview' : `page ${index}`}`
    const { file, title, description, slug, order } = entry ?? {}
    for (const [field, value] of Object.entries({ file, title, description }))
      if (typeof value !== 'string' || !value.trim()) errors.push(`${label}: missing ${field}`)
    const path = overview ? '/docs/' : `/docs/${slug}/`
    if (!overview) {
      if (typeof slug !== 'string' || !SLUG.test(slug))
        errors.push(`${label}: invalid slug "${slug}"`)
      else if (paths.has(path)) errors.push(`${label}: duplicate slug "${slug}"`)
      if (!Number.isInteger(order) || order < 1 || orders.has(order))
        errors.push(`${label}: invalid or duplicate order ${order}`)
      paths.add(path)
      orders.add(order)
    }
    if (typeof file !== 'string') return null
    if (!PAGE_FILE.test(file)) {
      errors.push(`${label}: invalid file name "${file}"`)
      return null
    }
    const sourcePath = resolve(contentDir, file)
    if (sources.has(sourcePath)) {
      errors.push(`${label}: duplicate file "${file}"`)
      return null
    }
    let body
    try {
      body = readLocal(contentDir, file).toString('utf8')
    } catch (error) {
      errors.push(`${label}: cannot read ${file} (${error.message})`)
      return null
    }
    const doc = { ...entry, path, sourcePath, body, ids: new Set() }
    sources.set(sourcePath, doc)
    return doc
  }
  const entries = [metadata.overview, ...metadata.pages]
  const [overview, ...loaded] = entries.map(load)
  const pages = loaded.filter(Boolean).sort((a, b) => a.order - b.order)
  const all = [overview, ...pages].filter(Boolean)
  const listed = new Set(entries.map((entry) => entry?.file))
  for (const name of readdirSync(contentDir))
    if (name.endsWith('.md') && !listed.has(name)) errors.push(`${name}: not listed in pages.json`)

  const byPath = new Map(all.map((doc) => [doc.path, doc]))
  const assets = new Map()
  const links = []
  const localOrigins = new Set([new URL(ORIGIN).origin, 'https://qivo.io', 'https://www.qivo.io'])
  const issue = (doc, target, message) => errors.push(`${doc.file}: ${message} "${target}"`)
  const parse = (href, doc) => new URL(href, `${ORIGIN}${doc.path}`)
  const isExternal = (url) => !localOrigins.has(url.origin)

  function resolveLink(href, doc) {
    const url = parse(href, doc)
    if (isExternal(url)) return href
    const path = decode(url.pathname)
    const source = decode(href.split(/[?#]/)[0])
    if (path === null || source === null) {
      issue(doc, href, 'Invalid link encoding')
      return href
    }
    // Markdown filenames refer to source files in docs/guide.
    if (!NOT_RELATIVE.test(href) && path.endsWith('.md')) {
      const destination = sources.get(resolve(contentDir, source))
      if (!destination) {
        issue(doc, href, 'Broken internal page link')
        return href
      }
      links.push({ doc, href, path: destination.path, hash: url.hash })
      return `${destination.path}${url.search}${url.hash}`
    }
    links.push({ doc, href, path, hash: url.hash })
    // Keep links to this product on the selected environment when previewing.
    return ORIGIN !== 'https://qivo.io' && url.origin === 'https://qivo.io'
      ? `${url.pathname}${url.search}${url.hash}`
      : href
  }

  function resolveImage(src, alt, doc) {
    if (!alt.trim()) issue(doc, src, 'Image needs descriptive alternative text')
    // Documentation images live with the source, never at a URL.
    if (NOT_RELATIVE.test(src)) {
      issue(doc, src, 'Image must be a relative path to a file in docs/guide')
      return src
    }
    const url = parse(src, doc)
    const written = decode(src.split(/[?#]/)[0])
    const file = posix.normalize(written ?? '')
    try {
      if (
        written === null ||
        file !== written.replace(/^\.\//, '') ||
        file.includes('\\') ||
        [...file].some((character) => character.charCodeAt(0) < 32)
      )
        throw new Error('Use a plain path such as ./images/name.webp')
      if (!IMAGE_TYPES[extname(file).toLowerCase()]) throw new Error('Unsupported image extension')
      assets.set(`docs/assets/${file}`, readLocal(contentDir, file))
    } catch (error) {
      issue(doc, src, `Missing or invalid local image (${error.message})`)
      return src
    }
    return `/docs/assets/${file.split('/').map(encodeURIComponent).join('/')}${url.search}${url.hash}`
  }

  for (const doc of all) {
    try {
      doc.html = render(doc.body, {
        aliases: doc.aliases,
        onHeading: ({ id, aliases, level }) => {
          if (level === 1) issue(doc, id, 'Use metadata for the page title and ## for subsections')
          doc.ids.add(id)
          for (const alias of aliases) doc.ids.add(alias)
        },
        resolveLink: (href) => resolveLink(href, doc),
        resolveImage: (src, alt) => resolveImage(src, alt, doc),
      })
    } catch (error) {
      errors.push(`${doc.file}: ${error.message}`)
    }
  }

  for (const name of AGENT_GUIDES) {
    const guide = { file: `public/${name}` }
    let text
    try {
      text = readLocal(publicDir, name).toString('utf8')
    } catch (error) {
      errors.push(`${guide.file}: cannot read agent guide (${error.message})`)
      continue
    }
    for (const [href] of text.matchAll(/https:\/\/(?:www\.)?qivo\.io\/docs\b[^\s)>\]"'`]*/g)) {
      const url = new URL(href)
      links.push({ doc: guide, href, path: url.pathname, hash: url.hash })
    }
  }

  const publicIds = new Map()
  for (const { doc, href, path, hash } of links) {
    const cleanPath = `${path.replace(/\/(?:index\.html)?$/, '')}/`
    const target = byPath.get(cleanPath)
    const id = decode(hash.slice(1))
    if (id === null) {
      issue(doc, href, 'Invalid internal anchor encoding')
      continue
    }
    if (target) {
      if (id && !target.ids.has(id)) issue(doc, href, 'Broken internal anchor')
      continue
    }
    if (path === '/app' || path.startsWith('/app/') || path === '/admin') continue
    if (path === '/pricing' || cleanPath === '/pricing/') {
      if (id) issue(doc, href, 'Broken internal anchor')
      continue
    }
    try {
      const home = path === '/' || path === '/index.html'
      const file = home ? 'index.html' : path.replace(/^\//, '')
      const key = home ? 'home' : file
      const data = readLocal(home ? ROOT : publicDir, file)
      if (id) {
        if (!publicIds.has(key)) {
          const ids = new Set()
          if (extname(file) === '.md') {
            render(data.toString('utf8'), { onHeading: (heading) => ids.add(heading.id) })
          } else {
            for (const match of data.toString('utf8').matchAll(/\bid=["']([^"']+)["']/g))
              ids.add(match[1])
          }
          publicIds.set(key, ids)
        }
        if (!publicIds.get(key).has(id)) issue(doc, href, 'Broken internal anchor')
      }
    } catch {
      issue(doc, href, 'Broken internal link')
    }
  }
  return { errors: [...new Set(errors)], overview, pages, assets }
}

/** The guide, ready to publish. Throws with every problem listed when it is not. */
export function loadDocs(options) {
  const { errors, ...guide } = inspectDocs(options)
  if (errors.length)
    throw new Error(`Documentation errors:\n${errors.map((e) => `  ${e}`).join('\n')}`)
  return guide
}
