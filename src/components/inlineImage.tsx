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
   recorded size within the column and DRAWN_HEIGHT, or before any size is
   known a 4:3 box at the column's width, so the text around it barely
   moves when it loads. */
function boxStyle(box: { width: number; height: number } | null): CSSProperties {
  const { width, height } = box ?? { width: 4, height: 3 }
  const drawn = box ? Math.min(width, (DRAWN_HEIGHT * width) / height) : (DRAWN_HEIGHT * 4) / 3
  return { width: `min(100%, ${Math.round(drawn)}px)`, aspectRatio: `${width} / ${height}` }
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
  const [broken, setBroken] = useState(false)
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

  const gone = attId ? image.state === 'gone' : !external || broken || outside.unavailable
  if (gone) {
    return (
      <span ref={setReach} className="mdimgreach">
        <HoverTooltip content={alt}>
          <span className="mdimgph">
            <Icon name="blocked" size={iconSize} />
            Image unavailable
          </span>
        </HoverTooltip>
        {!attId && external && outside.unavailable && (
          <Button type="button" variant="ghost" size="sm" onClick={() => outside.retry()}>
            Retry
          </Button>
        )}
      </span>
    )
  }
  const url = (attId ? image.url : external) as string
  if (!shows) {
    return (
      <span ref={setReach} className="mdimgreach">
        <span className="mdimgph mdimgbox" style={boxStyle(attId ? image.box : null)}>
          Loading image…
        </span>
      </span>
    )
  }
  const freshUrl = async () => (attId ? await P.attachmentUrl(attId) : url)
  const open = () => void openImageFull(freshUrl)
  // keep focus in the editor
  const swallow = editor ? (e: MouseEvent) => e.preventDefault() : undefined
  return (
    <span ref={setReach} className="mdimgreach">
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
              P.inlineImages.loaded(attId, { width: img.naturalWidth, height: img.naturalHeight })
            } else outside.settled()
          }}
          onError={() => {
            if (attId) P.inlineImages.loaded(attId, null)
            else {
              outside.settled()
              setBroken(true)
            }
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
    </span>
  )
}
