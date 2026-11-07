/* Markdown renderer for issue descriptions — walks the AST from lib/md and
   builds React elements (raw HTML is never interpreted; hrefs are whitelisted
   by sanitizeHref). Images load near view through the store's inline image
   loader, "att:<id>" sources as bytes from the access-checked file gateway
   (components/inlineImage.tsx), and reveal copy/download buttons in their
   top-right corner on hover. Each image's wrapper names its source and alt
   text (data-qivo-src, data-qivo-alt) whatever its body shows, so a copy
   of the rendered text pastes back into an editor as the image itself
   (descImage.ts). */
import React, { useMemo } from 'react'
import type { MdBlock, MdInline } from '../lib/md'
import { parseMd, sanitizeHref } from '../lib/md'
import { InlineImageBody } from './inlineImage'
import { Icon } from './qivo'

function MdImage({ alt, src }: { alt: string; src: string }) {
  const attId = src.startsWith('att:') ? src.slice(4) : null
  if (src.startsWith('uploading:')) {
    return (
      <span className="mdimgph">
        <Icon name="paperclip" size={13} />
        Uploading image…
      </span>
    )
  }
  const external = attId ? null : sanitizeHref(src)
  const source = attId ? `att:${attId}` : external
  // keyed by the source, so an edit that swaps it starts afresh
  return (
    <span
      className="mdimgwrap"
      {...(attId ? { 'data-att': attId } : {})}
      {...(source ? { 'data-qivo-src': source, 'data-qivo-alt': alt } : {})}
    >
      <InlineImageBody
        key={attId ?? external ?? ''}
        alt={alt}
        attId={attId}
        external={external}
        iconSize={13}
      />
    </span>
  )
}

function Inlines({ nodes }: { nodes: MdInline[] }) {
  return (
    <>
      {/* biome-ignore lint/suspicious/useIterableCallbackReturn: the switch is exhaustive over the MdInline union, which Biome cannot see */}
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text':
            // biome-ignore lint/suspicious/noArrayIndexKey: parseMd re-derives the whole run on every edit; position is a text fragment's only identity
            return <React.Fragment key={i}>{n.text}</React.Fragment>
          case 'br':
            // biome-ignore lint/suspicious/noArrayIndexKey: a break has no identity beyond its position in the re-derived run
            return <br key={i} />
          case 'code':
            // biome-ignore lint/suspicious/noArrayIndexKey: identical code spans may repeat; position is the only collision-free identity
            return <code key={i}>{n.text}</code>
          case 'bold':
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: emphasis wraps re-derived children with no identity of their own
              <strong key={i}>
                <Inlines nodes={n.children} />
              </strong>
            )
          case 'italic':
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: emphasis wraps re-derived children with no identity of their own
              <em key={i}>
                <Inlines nodes={n.children} />
              </em>
            )
          case 'strike':
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: emphasis wraps re-derived children with no identity of their own
              <s key={i}>
                <Inlines nodes={n.children} />
              </s>
            )
          case 'underline':
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: emphasis wraps re-derived children with no identity of their own
              <u key={i}>
                <Inlines nodes={n.children} />
              </u>
            )
          case 'link': {
            const href = sanitizeHref(n.href)
            const kids = <Inlines nodes={n.children} />
            // the href is the identity; the index only disambiguates the same
            // link repeated in one run
            return href ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: see above — href carries the identity
              <a key={`${i}:${n.href}`} href={href} target="_blank" rel="noopener noreferrer">
                {kids}
              </a>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: see above — href carries the identity
              <span key={`${i}:${n.href}`}>{kids}</span>
            )
          }
          // keyed by src, not by position alone: swapping the image in a
          // paragraph remounts instead of reusing the instance, so the old
          // picture is never painted for the frame before the effect lands
          case 'image':
            // biome-ignore lint/suspicious/noArrayIndexKey: the src carries the identity; the index only disambiguates duplicates
            return <MdImage key={`${i}:${n.src}`} alt={n.alt} src={n.src} />
          // data-type/data-id/data-label are the editor Mention node's
          // parseHTML shape, so a copy from this rendered view pastes back
          // as a real mention node instead of degrading to plain text (the
          // SIGNED_ATT normalization is the image analog)
          case 'mention':
            return (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: the user id carries the identity; the index only disambiguates duplicates
                key={`${i}:${n.id}`}
                className="mention"
                data-mention={n.id}
                data-type="mention"
                data-id={n.id}
                data-label={n.name}
              >
                @{n.name}
              </span>
            )
        }
      })}
    </>
  )
}

function BlockView({ b }: { b: MdBlock }) {
  switch (b.t) {
    case 'p':
      return (
        <p>
          <Inlines nodes={b.children} />
        </p>
      )
    case 'h':
      return React.createElement(`h${b.level}`, null, <Inlines nodes={b.children} />)
    case 'quote':
      return (
        <blockquote>
          <Inlines nodes={b.children} />
        </blockquote>
      )
    case 'ul':
      return (
        <ul>
          {b.items.map((it, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: items re-derive wholesale from the text; position is the identity
            <li key={i}>
              <Inlines nodes={it} />
            </li>
          ))}
        </ul>
      )
    case 'ol':
      return (
        <ol start={b.start}>
          {b.items.map((it, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: items re-derive wholesale from the text; position is the identity
            <li key={i}>
              <Inlines nodes={it} />
            </li>
          ))}
        </ol>
      )
    case 'codeblock':
      return (
        <pre>
          <code>{b.text}</code>
        </pre>
      )
  }
}

function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMd(text), [text])
  return (
    <div className="md">
      {blocks.map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks re-derive wholesale from the text; position is the identity
        <BlockView key={i} b={b} />
      ))}
    </div>
  )
}

export { Markdown }
