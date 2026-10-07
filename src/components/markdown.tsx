/* Markdown renderer for issue descriptions — walks the AST from lib/md and
   builds React elements (raw HTML is never interpreted; hrefs are whitelisted
   by sanitizeHref). Images resolve "att:<id>" sources into short-lived minted
   URLs on the access-checked file gateway and reveal copy/download buttons
   in their top-right corner on hover. */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { HoverTooltip } from '@/components/ui/tooltip'
import type { MdBlock, MdInline } from '../lib/md'
import { parseMd, sanitizeHref } from '../lib/md'
import { P } from '../store/planner'
import { copyImage, downloadImage, openImageFull } from './imgActions'
import { Icon } from './qivo'

function MdImage({ alt, src }: { alt: string; src: string }) {
  const attId = src.startsWith('att:') ? src.slice(4) : null
  const uploading = src.startsWith('uploading:')
  const external = !attId && !uploading ? sanitizeHref(src) : null
  const [url, setUrl] = useState<string | null>(external)
  const [gone, setGone] = useState(!attId && !uploading && !external)
  const retried = useRef(false)

  useEffect(() => {
    let alive = true
    if (attId) {
      // reset: React reuses this instance when an edit swaps the src in place
      setGone(false)
      setUrl(null)
      retried.current = false
      void P.attachmentUrl(attId).then((u) => {
        if (alive) {
          u ? setUrl(u) : setGone(true)
        }
      })
    } else {
      /* The same swap landing on a plain URL. `external` is recomputed every
         render, but `url`/`gone` were only ever seeded at mount, so without
         this branch the img keeps painting the src the instance FIRST had —
         an edit from one external image to another, or from att: to external,
         showed the old picture under the new alt text. */
      setUrl(external)
      setGone(!uploading && !external)
      retried.current = false
    }
    return () => {
      alive = false
    }
  }, [attId, external, uploading])

  if (uploading) {
    return (
      <span className="mdimgph">
        <Icon name="paperclip" size={13} />
        Uploading image…
      </span>
    )
  }
  if (gone) {
    return (
      <HoverTooltip content={alt}>
        <span className="mdimgph">
          <Icon name="blocked" size={13} />
          Image unavailable
        </span>
      </HoverTooltip>
    )
  }
  if (!url) {
    return <span className="mdimgph">Loading image…</span>
  }

  const freshUrl = async () => (attId ? await P.attachmentUrl(attId) : url)

  return (
    <span className="mdimgwrap" {...(attId ? { 'data-att': attId } : {})}>
      <HoverTooltip content={alt}>
        <img
          className="mdimg"
          src={url}
          alt={alt}
          onClick={() => void openImageFull(freshUrl)}
          onError={() => {
            // minted URLs live ~10 minutes; a late load gets one fresh URL retry
            if (attId && !retried.current) {
              retried.current = true
              void P.attachmentUrl(attId).then((u) => (u ? setUrl(u) : setGone(true)))
            } else setGone(true)
          }}
        />
      </HoverTooltip>
      <span className="mdimgbtns">
        <Button
          type="button"
          className="mdimgbtn"
          title="Copy image"
          aria-label="Copy image"
          onClick={() => void copyImage(freshUrl)}
          variant="unstyled"
        >
          <Icon name="copy" size={13} />
        </Button>
        <Button
          type="button"
          className="mdimgbtn"
          title="Download image"
          aria-label="Download image"
          onClick={() => void downloadImage(attId, url)}
          variant="unstyled"
        >
          <Icon name="download" size={13} />
        </Button>
      </span>
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
