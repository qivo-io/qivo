#!/usr/bin/env node
/* The public contract for docs/guide. The qivo.io website renders these
 * Markdown files from an exact commit of this repository, fetching only
 * `docs/guide/pages.json`, the files it lists, their relative images and the
 * agent guides in public/. This check keeps those inputs valid before merge:
 * a page the website cannot render fails its build, and qivo.io keeps the
 * previous version. Run it with `npm run build` or the test suite.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import MarkdownIt from 'markdown-it'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))

/** Page files are flat, lowercase Markdown names inside docs/guide. */
export const PAGE_FILE = /^[a-z0-9][a-z0-9-]*\.md$/
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const AGENT_GUIDES = ['llms.txt', 'skill.md', 'auth.md']
export const IMAGE_EXTENSIONS = ['.avif', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp']
const ORIGINS = new Set(['https://qivo.io', 'https://www.qivo.io'])

/** The website's heading ID rule: lowercase ASCII, hyphens, at most 60 characters. */
const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[§"'’“”]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

const md = new MarkdownIt({ html: false })

/** Heading IDs, links and images in one Markdown source. */
function scan(source) {
  const ids = new Set()
  const links = []
  const images = []
  let h1 = false
  const visit = (tokens) => {
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      if (token.type === 'heading_open') {
        const base = slugify(tokens[i + 1].content) || 'section'
        let id = base
        let suffix = 1
        while (ids.has(id)) id = `${base}-${++suffix}`
        ids.add(id)
        if (token.tag === 'h1') h1 = true
      }
      if (token.type === 'link_open') links.push(token.attrGet('href'))
      if (token.type === 'image') images.push({ src: token.attrGet('src'), alt: token.content })
      if (token.children) visit(token.children)
    }
  }
  visit(md.parse(source, {}))
  return { ids, links, images, h1 }
}

/** Returns every contract violation; an empty array means the guide is publishable. */
export function checkDocs(root = projectRoot) {
  const guide = join(root, 'docs/guide')
  const errors = []
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(guide, 'pages.json'), 'utf8'))
  } catch (error) {
    return [`docs/guide/pages.json: ${error.message}`]
  }
  const entries = [manifest?.overview, ...(Array.isArray(manifest?.pages) ? manifest.pages : [])]
  if (!manifest?.overview || entries.length < 2) return ['pages.json needs an overview and pages']

  const files = new Map()
  const slugs = new Map()
  const orders = new Set()
  for (const [index, entry] of entries.entries()) {
    const overview = index === 0
    const label = `pages.json ${overview ? 'overview' : `page ${index}`}`
    for (const field of ['file', 'title', 'description'])
      if (typeof entry?.[field] !== 'string' || !entry[field].trim())
        errors.push(`${label}: missing ${field}`)
    if (!PAGE_FILE.test(entry?.file || '')) {
      errors.push(`${label}: invalid file name`)
      continue
    }
    if (files.has(entry.file)) errors.push(`${label}: duplicate file ${entry.file}`)
    if (!overview) {
      if (!SLUG.test(entry.slug || '')) errors.push(`${label}: invalid slug`)
      else if (slugs.has(entry.slug)) errors.push(`${label}: duplicate slug ${entry.slug}`)
      if (!Number.isInteger(entry.order) || entry.order < 1 || orders.has(entry.order))
        errors.push(`${label}: invalid or duplicate order`)
      orders.add(entry.order)
    }
    let source
    try {
      source = readFileSync(join(guide, entry.file), 'utf8')
    } catch {
      errors.push(`${label}: cannot read docs/guide/${entry.file}`)
      continue
    }
    const page = { ...entry, ...scan(source) }
    for (const [id, previous] of Object.entries(entry.aliases || {})) {
      if (!page.ids.has(id)) errors.push(`${entry.file}: alias target "${id}" does not exist`)
      for (const alias of Array.isArray(previous) ? previous : [null])
        if (typeof alias === 'string' && SLUG.test(alias)) page.ids.add(alias)
        else errors.push(`${entry.file}: invalid alias for "${id}"`)
    }
    files.set(entry.file, page)
    if (!overview && SLUG.test(entry.slug || '')) slugs.set(entry.slug, page)
  }
  slugs.set('', files.get(manifest.overview.file))

  for (const name of readdirSync(guide))
    if (name.endsWith('.md') && !files.has(name))
      errors.push(`docs/guide/${name}: not listed in pages.json`)

  const anchor = (target, hash, where, href) => {
    const id = decodeURIComponent(hash.slice(1))
    if (id && target && !target.ids.has(id)) errors.push(`${where}: broken anchor "${href}"`)
  }
  const agentIds = new Map()
  const checkSiteLink = (url, where, href) => {
    const docs = /^\/docs\/(?:([a-z0-9-]+)\/)?$/.exec(url.pathname)
    if (docs) {
      const target = slugs.get(docs[1] || '')
      if (!target) errors.push(`${where}: unknown documentation page "${href}"`)
      return anchor(target, url.hash, where, href)
    }
    const guideName = url.pathname.slice(1)
    if (AGENT_GUIDES.includes(guideName)) {
      if (!agentIds.has(guideName))
        agentIds.set(guideName, scan(readFileSync(join(root, 'public', guideName), 'utf8')))
      if (guideName.endsWith('.md')) anchor(agentIds.get(guideName), url.hash, where, href)
      return
    }
    // Website and application routes are served outside this repository.
    if (!/^\/(?:$|pricing\/$|app(?:\/.*)?$|admin$)/.test(url.pathname))
      errors.push(`${where}: unknown qivo.io path "${href}"`)
  }

  for (const page of files.values()) {
    if (page.h1) errors.push(`${page.file}: use metadata for the page title and ## for subsections`)
    for (const href of page.links) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^https:\/\//i.test(href)) continue
      const url = new URL(href, `https://qivo.io/docs/`)
      if (/^https:\/\//i.test(href) || href.startsWith('/')) {
        if (ORIGINS.has(url.origin)) checkSiteLink(url, page.file, href)
        continue
      }
      const [path, hash = ''] = href.split('#')
      const name = posix.normalize(decodeURIComponent(path || page.file))
      const target = files.get(name)
      if (!target) errors.push(`${page.file}: broken page link "${href}"`)
      else anchor(target, hash && `#${hash}`, page.file, href)
    }
    for (const { src, alt } of page.images) {
      if (!alt.trim()) errors.push(`${page.file}: image needs alternative text "${src}"`)
      if (/^[a-z][a-z0-9+.-]*:|^\//i.test(src)) {
        errors.push(`${page.file}: images must be relative files in docs/guide "${src}"`)
        continue
      }
      const decoded = decodeURIComponent(src.split(/[?#]/)[0])
      const path = posix.normalize(decoded)
      const file = resolve(guide, path)
      if (
        posix.isAbsolute(path) ||
        path !== decoded.replace(/^\.\//, '') ||
        path.includes('\\') ||
        [...path].some((character) => character.charCodeAt(0) < 32) ||
        path.startsWith('../') ||
        !IMAGE_EXTENSIONS.includes(extname(path).toLowerCase()) ||
        !existsSync(file) ||
        !statSync(file).isFile()
      )
        errors.push(`${page.file}: missing or invalid image "${src}"`)
    }
  }

  for (const name of AGENT_GUIDES) {
    const text = readFileSync(join(root, 'public', name), 'utf8')
    for (const [href] of text.matchAll(/https:\/\/(?:www\.)?qivo\.io\/docs\b[^\s)>\]"'`]*/g))
      checkSiteLink(new URL(href), `public/${name}`, href)
  }
  return [...new Set(errors)]
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkDocs()
  if (errors.length) {
    console.error(`[docs] Documentation errors:\n${errors.map((e) => `  ${e}`).join('\n')}`)
    process.exitCode = 1
  } else console.log('[docs] docs/guide and agent-guide documentation links are valid')
}
