import { ImageIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { decodeCanvasImage } from '@/lib/appearance'

const columns = [
  { title: 'To do', tasks: ['Review enclosure design', 'Prepare release notes'] },
  {
    title: 'In progress',
    tasks: ['Add signed firmware updates and rollback', 'Test power consumption'],
  },
  { title: 'In review', tasks: ['Validate the first prototype'] },
  { title: 'Done', tasks: ['Define product requirements'] },
]

/** Sample content uses the live Canvas material tokens and centered cover crop.
 * It stays isolated from the operator's theme and never changes an assignment. */
export function BackgroundBoardPreview({
  image,
}: {
  image: { preview_url: string | null; title: string }
}) {
  const [readyUrl, setReadyUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    setReadyUrl(null)
    setFailed(false)
    if (image.preview_url) {
      void decodeCanvasImage(image.preview_url).then(
        () => {
          if (active) setReadyUrl(image.preview_url)
        },
        () => {
          if (active) setFailed(true)
        },
      )
    }
    return () => {
      active = false
    }
  }, [image.preview_url])
  const ready = readyUrl && readyUrl === image.preview_url
  return (
    <div
      data-canvas-preview
      role="img"
      aria-label={`Sample Canvas board with ${image.title}`}
      className="relative isolate h-[min(60dvh,650px)] min-h-80 overflow-hidden rounded-lg bg-[var(--bg)] text-[var(--text-1)]"
    >
      {ready && (
        <img
          src={readyUrl}
          alt=""
          className="absolute inset-0 -z-20 h-full w-full object-cover object-center"
        />
      )}
      <div className="absolute inset-0 -z-10 bg-[var(--workspace-image-veil)]" />
      <div className="flex h-full min-h-0 gap-3 overflow-auto p-3 text-xs">
        <aside className="hidden w-36 shrink-0 rounded-xl border border-[var(--border)] bg-[var(--workspace-panel)] p-3 [backdrop-filter:var(--workspace-panel-blur)] sm:block">
          <div className="mb-7 text-base font-semibold">qivo</div>
          <div className="mb-5 text-[var(--text-2)]">All projects</div>
          <div className="mb-3 font-semibold">Product launch</div>
          <div className="space-y-3 pl-3 text-[var(--text-2)]">
            <p>Hardware</p>
            <p>Firmware</p>
            <p>Launch</p>
          </div>
        </aside>
        <div className="min-w-[620px] flex-1">
          <div className="mb-4 flex w-fit gap-4 rounded-xl border border-[var(--border)] bg-[var(--workspace-panel)] px-4 py-3 [backdrop-filter:var(--workspace-panel-blur)]">
            <span>Overview</span>
            <span className="border-b border-white font-semibold">Board</span>
            <span>Roadmap</span>
          </div>
          <div className="grid h-[calc(100%-60px)] min-h-[360px] grid-cols-4 gap-2">
            {columns.map((column) => (
              <section
                key={column.title}
                className="rounded-xl border border-[var(--border)] bg-[var(--workspace-panel)] p-3 shadow-[var(--workspace-panel-shadow)] [backdrop-filter:var(--workspace-panel-blur)]"
              >
                <div className="mb-4 flex justify-between gap-2 font-semibold">
                  <span>{column.title}</span>
                  <span className="text-[var(--text-2)]">{column.tasks.length}</span>
                </div>
                <div className="space-y-2">
                  {column.tasks.map((title, index) => (
                    <div key={title} className="rounded-md border border-[var(--border)] p-3">
                      <div className="mb-2 text-[10px] text-[var(--text-2)]">
                        Firmware · {index + 1}
                      </div>
                      <div className="leading-relaxed font-medium">{title}</div>
                      <div className="mt-4 flex justify-between text-[var(--text-2)]">
                        <span>4h</span>
                        <span className="grid size-5 place-items-center rounded-full bg-[var(--surface-3)] text-[10px]">
                          NB
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
      {!ready && (
        <div
          role="status"
          className="absolute right-3 bottom-3 flex items-center gap-2 rounded-md bg-[var(--surface-1)] px-3 py-2 text-xs"
        >
          <ImageIcon className="size-4" />
          {failed || !image.preview_url ? 'Preview unavailable' : 'Loading image…'}
        </div>
      )}
    </div>
  )
}
