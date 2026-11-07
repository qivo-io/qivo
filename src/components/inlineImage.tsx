/* The body of one description or comment image, for the read-only
   renderer (components/markdown.tsx) and the editor's image node view
   (components/descEditor.tsx). An `att:` image loads through the store's
   inline image loader (lib/inlineImages.ts) near view and shows a box of
   the size it will be drawn until then; an external image takes its
   source near view, from the loader's external pool. Copy, Download and
   the full-size open mint on the press (imgActions.ts). */
import { type CSSProperties, type MouseEvent, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { HoverTooltip } from '@/components/ui/tooltip'
import { useExternalImage, useInlineImage } from '../lib/inlineImages'
import { P } from '../store/planner'
import { copyImage, downloadImage, openImageFull } from './imgActions'
import { Icon } from './qivo'

/** The most an inline image is drawn tall (.mdimg's max-height). */
const DRAWN_HEIGHT = 340

/* The placeholder's box, the size the image will be drawn at: its
   recorded size within DRAWN_HEIGHT, or before any size is known a 4:3 box
   DRAWN_HEIGHT tall, so the text around it barely moves when it loads.
   .mdimgbox's max-width keeps it within the column. The width is in
   pixels, since a percentage of the shrink-to-fit wrapper around it would
   shrink it to its text. */
function boxStyle(box: { width: number; height: number } | null): CSSProperties {
  const { width, height } = box ?? { width: 4, height: 3 }
  const drawn = box ? Math.min(width, (DRAWN_HEIGHT * width) / height) : (DRAWN_HEIGHT * 4) / 3
  return { width: `${Math.round(drawn)}px`, aspectRatio: `${width} / ${height}` }
}

type Props = {
  alt: string
  /** the attachment an `att:` image shows */
  attId: string | null
  /** an external image's sanitized URL */
  external: string | null
  /** the editor's node view: double-click opens, and the buttons keep focus */
  editor?: boolean
  iconSize: number
}

/** One image's body inside its wrapper (.mdimgwrap), which positions its
    hover buttons. */
export function InlineImageBody({ alt, attId, external, editor = false, iconSize }: Props) {
  const [reach, setReach] = useState<HTMLSpanElement | null>(null)
  const image = useInlineImage(P.inlineImages, attId, reach)
  const outside = useExternalImage(P.inlineImages, attId ? null : external, reach)
  // a view already showing an attachment keeps it through a renewal
  const [showing, setShowing] = useState(false)
  const shows = attId
    ? image.near &&
      !!image.url &&
      (image.state === 'ready' || (image.state === 'renewing' && showing))
    : outside.load && !outside.unavailable
  useEffect(() => {
    if (!shows) setShowing(false)
  }, [shows])

  const gone = attId ? image.state === 'gone' : !external || outside.unavailable
  const url = (attId ? image.url : external) as string
  const freshUrl = async () => (attId ? await P.attachmentUrl(attId) : url)
  const open = () => void openImageFull(freshUrl)
  // keep focus in the editor
  const swallow = editor ? (e: MouseEvent) => e.preventDefault() : undefined
  // One reach element whatever shows, so the loader's observer keeps
  // watching the same element as the image loads.
  return (
    <span ref={setReach} className="mdimgreach">
      {gone ? (
        <>
          <HoverTooltip content={alt}>
            <span className="mdimgph">
              <Icon name="blocked" size={iconSize} />
              Image unavailable
            </span>
          </HoverTooltip>
          {!attId && external && outside.unavailable && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={alt ? `Retry image ${alt}` : 'Retry image'}
              onClick={() => outside.retry()}
            >
              Retry
            </Button>
          )}
        </>
      ) : !shows ? (
        // an image to assistive technology, named by its alt text, which
        // says it is still loading
        <span
          className="mdimgph mdimgbox"
          style={boxStyle(attId ? image.box : null)}
          role="img"
          aria-label={alt ? `${alt} (loading image)` : 'Loading image'}
        >
          Loading image…
        </span>
      ) : (
        <>
          <HoverTooltip content={alt}>
            <img
              className="mdimg"
              src={url}
              alt={alt}
              decoding="async"
              referrerPolicy="no-referrer"
              {...(editor ? { onDoubleClick: open } : { onClick: open })}
              onLoad={(e) => {
                setShowing(true)
                if (attId) {
                  const img = e.currentTarget
                  P.inlineImages.loaded(attId, {
                    width: img.naturalWidth,
                    height: img.naturalHeight,
                  })
                } else outside.settled(true)
              }}
              onError={() => {
                if (attId) P.inlineImages.loaded(attId, null)
                else outside.settled(false)
              }}
            />
          </HoverTooltip>
          <span className="mdimgbtns" onMouseDown={swallow}>
            <Button
              type="button"
              className="mdimgbtn"
              title="Copy image"
              aria-label="Copy image"
              onClick={() => void copyImage(freshUrl)}
              variant="unstyled"
            >
              <Icon name="copy" size={iconSize} />
            </Button>
            <Button
              type="button"
              className="mdimgbtn"
              title="Download image"
              aria-label="Download image"
              onClick={() => void downloadImage(attId, attId ? null : url)}
              variant="unstyled"
            >
              <Icon name="download" size={iconSize} />
            </Button>
          </span>
        </>
      )}
    </span>
  )
}
