import MarkdownIt from 'markdown-it'

/** Keep the published heading IDs, including their ASCII and length rules. */
export const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[§"'’“”]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

/** Standard Markdown with escaped HTML and markdown-it's default URL safety.
 * Callers resolve content-relative links and images without replacing the parser.
 * Aliases retain old subsection links when contributors rename a heading.
 * Alias problems throw. When `onError` is given, it receives each one instead
 * and rendering continues, so callers can still check the rest of the page.
 */
export function render(
  source,
  {
    onHeading = null,
    resolveLink = null,
    resolveImage = null,
    aliases = {},
    onError = (message) => {
      throw new Error(message)
    },
  } = {},
) {
  const md = new MarkdownIt({ html: false })
  const tokens = md.parse(source, {})
  const used = new Set()
  const seenAliases = new Set()
  const aliasIds = new Set()
  const valid = {}
  for (const [target, ids] of Object.entries(aliases)) {
    valid[target] = []
    if (!Array.isArray(ids)) {
      onError(`Heading aliases for "${target}" must be an array of IDs`)
      continue
    }
    for (const id of ids) {
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id) || aliasIds.has(id))
        onError(`Invalid or duplicate heading alias "${id}"`)
      else {
        aliasIds.add(id)
        valid[target].push(id)
      }
    }
  }

  function visit(list) {
    for (let i = 0; i < list.length; i++) {
      const token = list[i]
      if (token.type === 'heading_open') {
        const text = list[i + 1].content
        const base = slugify(text) || 'section'
        let id = base
        let suffix = 1
        while (used.has(id)) id = `${base}-${++suffix}`
        if (aliasIds.has(id)) onError(`Heading ID "${id}" conflicts with an alias`)
        used.add(id)
        const previous = Object.hasOwn(valid, id) ? valid[id] : []
        seenAliases.add(id)
        token.attrSet('id', id)
        token.meta = { aliases: previous }
        list[i + 2].meta = { id }
        onHeading?.({ level: Number(token.tag.slice(1)), text, id, aliases: previous })
      }
      if (token.type === 'link_open' && resolveLink)
        token.attrSet('href', resolveLink(token.attrGet('href')))
      if (token.type === 'image') {
        if (resolveImage) token.attrSet('src', resolveImage(token.attrGet('src'), token.content))
        token.attrSet('loading', 'lazy')
        token.attrSet('decoding', 'async')
      }
      if (token.children) visit(token.children)
    }
  }
  visit(tokens)
  for (const id of Object.keys(aliases)) {
    if (!seenAliases.has(id)) onError(`Heading alias target "${id}" does not exist`)
  }

  md.renderer.rules.heading_open = (list, index, options, _env, self) => {
    const token = list[index]
    const spans = token.meta.aliases
      .map((id) => `<span id="${md.utils.escapeHtml(id)}"></span>`)
      .join('')
    return self.renderToken(list, index, options) + spans
  }
  md.renderer.rules.heading_close = (list, index, options, _env, self) => {
    const token = list[index]
    const anchor =
      token.tag === 'h1'
        ? ''
        : `<a class="anchor" href="#${md.utils.escapeHtml(token.meta.id)}" aria-label="Link to this section">#</a>`
    return anchor + self.renderToken(list, index, options)
  }
  return md.renderer.render(tokens, md.options, {})
}
