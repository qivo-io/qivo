import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render } from './md.mjs'
import { ORIGIN } from './theme.mjs'

// The website root, which holds the homepage checked by `/#anchor` links.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${field}`)
  return value
}

/** Resolve and validate the whole guide before publishing any page or asset.
 * `contentDir` is the application's docs/guide and `publicDir` its public/
 * directory, which holds the agent guides that pages link to. */
export function loadDocs({ contentDir, publicDir }) {
  if (!contentDir || !publicDir) throw new Error('loadDocs needs contentDir and publicDir')
  contentDir = resolve(contentDir)
  publicDir = resolve(publicDir)
  const metadata = JSON.parse(readFileSync(resolve(contentDir, 'pages.json'), 'utf8'))
  if (!metadata.overview || !Array.isArray(metadata.pages) || !metadata.pages.length)
    throw new Error('docs/pages.json needs an overview and pages')

  const paths = new Set()
  const sources = new Map()
  const orders = new Set()
  const load = (entry, overview = false) => {
    const { file, title, description, slug, order } = entry
    requiredString(file, 'page file')
    requiredString(title, `title for ${file}`)
    requiredString(description, `description for ${file}`)
    if (!file.endsWith('.md')) throw new Error(`Page file must end in .md: ${file}`)
    if (!overview) {
      if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
        throw new Error(`Invalid page slug for ${file}`)
      if (!Number.isInteger(order) || order < 1 || orders.has(order))
        throw new Error(`Invalid or duplicate page order for ${file}`)
      orders.add(order)
    }
    const path = overview ? '/docs/' : `/docs/${slug}/`
    if (paths.has(path)) throw new Error(`Duplicate page slug "${slug}"`)
    paths.add(path)
    const sourcePath = resolve(contentDir, file)
    if (sources.has(sourcePath)) throw new Error(`Duplicate page file "${file}"`)
    let body
    try {
      body = readLocal(contentDir, file).toString('utf8')
    } catch (error) {
      throw new Error(`docs/${file}: cannot read page (${error.message})`)
    }
    const doc = { ...entry, path, sourcePath, body, ids: new Set() }
    sources.set(sourcePath, doc)
    return doc
  }
  const overview = load(metadata.overview, true)
  const pages = metadata.pages.map((entry) => load(entry)).sort((a, b) => a.order - b.order)
  const all = [overview, ...pages]
  const byPath = new Map(all.map((doc) => [doc.path, doc]))
  const assets = new Map()
  const links = []
  const errors = []
  const localOrigins = new Set([new URL(ORIGIN).origin, 'https://qivo.io'])
  const issue = (doc, target, message) => errors.push(`${doc.file}: ${message} "${target}"`)
  const parse = (href, doc) => new URL(href, `${ORIGIN}${doc.path}`)
  const isExternal = (url) => !localOrigins.has(url.origin)

  function resolveLink(href, doc) {
    const url = parse(href, doc)
    if (isExternal(url)) return href
    const path = decodeURIComponent(url.pathname)
    // Markdown filenames refer to source files, relative to the author's page.
    if (!/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(href) && path.endsWith('.md')) {
      const source = decodeURIComponent(href.split(/[?#]/)[0])
      const destination = sources.get(resolve(dirname(doc.sourcePath), source))
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
    const url = parse(src, doc)
    if (isExternal(url)) return src
    const pathname = decodeURIComponent(src.split(/[?#]/)[0])
    // Documentation images live with the source, never relative to the public URL.
    const rootPath = /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(src)
    let file = rootPath
      ? decodeURIComponent(url.pathname).replace(/^\/docs\/assets\//, '')
      : relative(contentDir, resolve(dirname(doc.sourcePath), pathname))
    if (rootPath && !url.pathname.startsWith('/docs/assets/')) {
      issue(doc, src, 'Local image must be relative to its page or inside /docs/assets/')
      return src
    }
    file = file.split(sep).join('/')
    try {
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
      issue(doc, doc.file, error.message)
    }
  }

  const publicIds = new Map()
  for (const { doc, href, path, hash } of links) {
    const cleanPath = `${path.replace(/\/(?:index\.html)?$/, '')}/`
    const target = byPath.get(cleanPath)
    let id
    try {
      id = decodeURIComponent(hash.slice(1))
    } catch {
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
  if (errors.length)
    throw new Error(`Documentation errors:\n${errors.map((e) => `  ${e}`).join('\n')}`)
  return { overview, pages, assets }
}
