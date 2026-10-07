/* The image library and recurring calendar are operator-curated. Imports
   always await review; only approved images appear in the date picker. */
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server'
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { Check, ImageIcon, Maximize2 } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { HoverTooltip } from '@/components/ui/tooltip'
import {
  type BackgroundImageBatchProgress,
  type BackgroundImageBatchResult,
  importBackgroundImages,
  prepareBackgroundImage,
} from '@/lib/backgroundImageUpload'
import type { ImageMetadata } from '@/lib/imageMetadata'
import { beginUpdateBlock, useUpdateBlocker } from '@/lib/updateSafety'
import { cn } from '@/lib/utils'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import { panoramaFilename } from '../../../convex/lib/panoramaFilename'
import {
  MANUAL_IMAGE_REQUIREMENTS,
  PANORAMA_IMAGE_REQUIREMENTS,
} from '../../../convex/lib/panoramaImage'
import { calendarWeekForKey } from '../../../convex/lib/panoramaWeeks'
import { convex } from '../../lib/convex'
import { fmtBytes } from '../api'
import { readBackgroundReviewQueue } from '../backgroundReview'
import { BackgroundBoardPreview } from '../components/BackgroundBoardPreview'
import { AdminPageHeader, Badge, Loading } from '../ui'

type ImageStatus = 'pending' | 'approved' | 'removed'
type LibraryFilter = ImageStatus | 'all'
type AgentReview = 'approved' | 'declined'
type AgentFilter = AgentReview | 'unreviewed' | 'all'
type BackgroundImage = {
  id: string
  title: string
  location?: string
  filename?: string
  creator: string
  attribution: string
  license: string
  license_url: string
  source_url: string
  width: number
  height: number
  byte_size: number
  preview_byte_size?: number
  status: ImageStatus
  image_url: string | null
  preview_url: string | null
  imported_at: string
  reviewed_at?: string
  review_note?: string
  agent_review?: AgentReview
  agent_review_note?: string
  agent_reviewed_at?: string
  agent_review_id?: string
  agent_reviewer?: string
  requested_day?: string
}

/* The frame owns its dimensions. Absolutely positioned photos cannot use their
   intrinsic width to stretch a card, picker result or calendar row. */
const IMAGE_FRAME = 'relative block aspect-[16/10] overflow-hidden bg-surface-2'
const IMAGE_THUMBNAIL_SIZE = `${IMAGE_FRAME} w-64 max-w-full shrink-0`
const IMAGE_GALLERY_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-4'

const STATUS_LABEL: Record<ImageStatus, string> = {
  pending: 'Pending review',
  approved: 'Approved',
  removed: 'Removed',
}
function errorMessage(error: unknown): string {
  if (error instanceof ConvexError) {
    const data = error.data
    if (typeof data === 'object' && data !== null && 'message' in data) {
      return String(data.message)
    }
    if (typeof data === 'string') return data
  }
  return error instanceof Error ? error.message : 'Something went wrong. Try again.'
}

/* AdminGate authenticates the vanilla ConvexClient. These local adapters
   subscribe on that same socket; introducing a React provider would create
   a second client and auth lifecycle for a single operator page. */
export function useLiveQuery<Q extends FunctionReference<'query'>>(
  query: Q,
  args: FunctionArgs<Q>,
) {
  const name = getFunctionName(query)
  const stableQuery = useMemo(() => query, [name])
  const key = JSON.stringify([name, args])
  const stableArgs = useMemo(() => args, [key])
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{
    key: string
    data?: FunctionReturnType<Q>
    error: string
  }>({ key, error: '' })
  useEffect(() => {
    let active = true
    setState({ key, error: '' })
    const receiveError = (error: unknown) => {
      if (active) setState({ key, error: errorMessage(error) })
    }
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = convex.onUpdate(
        stableQuery,
        stableArgs,
        (data) => {
          if (active) setState({ key, data, error: '' })
        },
        receiveError,
      )
    } catch (error) {
      receiveError(error)
    }
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [stableQuery, stableArgs, key, attempt])
  return {
    data: state.key === key ? state.data : undefined,
    error: state.key === key ? state.error : '',
    retry: () => setAttempt((n) => n + 1),
  }
}

export function useLiveMutation<M extends FunctionReference<'mutation'>>(mutation: M) {
  const name = getFunctionName(mutation)
  const stableMutation = useMemo(() => mutation, [name])
  return useCallback(
    async (args: FunctionArgs<M>) => {
      const releaseUpdateBlock = beginUpdateBlock()
      try {
        return await convex.mutation(stableMutation, args)
      } finally {
        releaseUpdateBlock()
      }
    },
    [stableMutation],
  )
}

function useLiveAction<A extends FunctionReference<'action'>>(action: A) {
  const name = getFunctionName(action)
  const stableAction = useMemo(() => action, [name])
  return useCallback(
    async (args: FunctionArgs<A>) => {
      const releaseUpdateBlock = beginUpdateBlock()
      try {
        return await convex.action(stableAction, args)
      } finally {
        releaseUpdateBlock()
      }
    },
    [stableAction],
  )
}

function Failure({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div role="alert" className="rounded-md border border-danger/40 bg-danger-soft p-3 text-sm">
      <p className="break-words text-danger">{message}</p>
      {retry && (
        <Button type="button" className="mt-2" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  )
}

function Photo({
  image,
  className = '',
}: {
  image: Pick<BackgroundImage, 'preview_url' | 'title'>
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [image.preview_url])
  return image.preview_url && !failed ? (
    <img
      src={image.preview_url}
      alt={image.title}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn('absolute inset-0 block h-full w-full object-cover', className)}
    />
  ) : (
    <div
      className={cn(
        'absolute inset-0 flex h-full w-full items-center justify-center gap-2 bg-surface-2 p-4 text-sm text-text-2',
        className,
      )}
    >
      <ImageIcon className="size-5 shrink-0" aria-hidden="true" />
      <span>Preview unavailable</span>
    </div>
  )
}

function Credit({ image, compact = false }: { image: BackgroundImage; compact?: boolean }) {
  return (
    <div className="space-y-1 text-xs text-text-2">
      {image.location?.trim() && <p className="break-words">{image.location.trim()}</p>}
      <HoverTooltip content={compact ? image.creator : undefined}>
        <p className={cn('break-words', compact && 'line-clamp-2')}>
          {compact ? image.creator : image.attribution || image.creator}
        </p>
      </HoverTooltip>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {image.source_url && (
          <a
            href={image.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-1 underline underline-offset-4"
          >
            Source
          </a>
        )}
        {image.license_url ? (
          <a
            href={image.license_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-1 underline underline-offset-4"
          >
            {image.license}
          </a>
        ) : image.license && image.license !== 'Permission confirmed by uploader' ? (
          <span>{image.license}</span>
        ) : null}
      </div>
    </div>
  )
}

function ImageFileDetails({ image }: { image: BackgroundImage }) {
  const [decoded, setDecoded] = useState<{ url: string; width: number; height: number } | null>(
    null,
  )
  useEffect(() => {
    const url = image.preview_url
    if (!url) return
    const preview = new Image()
    // This shares the displayed thumbnail's cached file and measures the
    // actual oriented derivative, including images uploaded before these details.
    preview.onload = () =>
      setDecoded({ url, width: preview.naturalWidth, height: preview.naturalHeight })
    preview.onerror = () => setDecoded({ url, width: 0, height: 0 })
    preview.src = url
    return () => {
      preview.onload = null
      preview.onerror = null
    }
  }, [image.preview_url])
  const preview = decoded?.url === image.preview_url ? decoded : null
  return (
    <span className="block space-y-1">
      <span data-image-file-info="original" className="block">
        Original: {image.width} × {image.height}, {fmtBytes(image.byte_size)}
      </span>
      <span data-image-file-info="preview" className="block">
        {preview?.width && preview.height && image.preview_byte_size ? (
          <>
            Preview: {preview.width} × {preview.height}, {fmtBytes(image.preview_byte_size)}
          </>
        ) : image.preview_url && !preview ? (
          'Preview: Loading details…'
        ) : (
          'Preview unavailable'
        )}
      </span>
    </span>
  )
}

function ImageMetadataRows({
  image,
}: {
  image: Pick<BackgroundImage, 'title' | 'location' | 'creator'>
}) {
  return (
    <span className="block min-w-0 space-y-1 text-left whitespace-normal [overflow-wrap:anywhere]">
      {(['title', 'location', 'creator'] as const).map((field) => {
        const value = image[field]?.trim()
        return value ? (
          <span
            key={field}
            data-image-metadata={field}
            className={cn('block', field === 'title' ? 'text-text-1' : 'text-text-2')}
          >
            {value}
          </span>
        ) : null
      })}
    </span>
  )
}

function ImagePreview({
  image: initialImage,
  agentFilter = 'all',
  close,
}: {
  image: BackgroundImage
  agentFilter?: AgentFilter
  close: () => void
}) {
  const [selectedImage, setSelectedImage] = useState(initialImage)
  // An open modal follows asynchronous preview generation and backfills too.
  const {
    data,
    error: queryError,
    retry,
  } = useLiveQuery(api.panoramaCuration.libraryImage, {
    id: selectedImage.id,
  })
  const image = data === undefined ? selectedImage : data || { ...selectedImage, preview_url: null }
  const approve = useLiveMutation(api.panoramaImages.approve)
  const approveButton = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const operation = useRef(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [approvedId, setApprovedId] = useState<string | null>(null)
  const [nextFailed, setNextFailed] = useState(false)
  useUpdateBlocker(busy)
  const imageLoaded = data !== undefined
  useEffect(() => {
    if (notice && !busy && imageLoaded) approveButton.current?.focus()
  }, [selectedImage.id, notice, busy, imageLoaded])

  const showNextPending = async (reviewedId: string) => {
    setNextFailed(false)
    try {
      // The pending index starts at the oldest remaining image. Querying after
      // approval also crosses library pages and keeps the selected precheck filter.
      const pending = await readBackgroundReviewQueue<
        FunctionReturnType<typeof api.panoramaImages.library>
      >((receive, fail) =>
        convex.onUpdate(
          api.panoramaImages.library,
          {
            status: 'pending',
            ...(agentFilter !== 'all' ? { agent_review: agentFilter } : {}),
          },
          receive,
          fail,
        ),
      )
      const next = pending.images.find((candidate) => candidate.id !== reviewedId)
      if (next) {
        setSelectedImage(next)
        setApprovedId(null)
        setNotice(`Image approved. Reviewing ${next.title}.`)
      } else {
        setNotice(
          agentFilter === 'all'
            ? 'Image approved. No more images waiting for review.'
            : 'Image approved. No more images waiting for review with this precheck filter.',
        )
      }
    } catch (error) {
      setNextFailed(true)
      setError(`The image was approved, but the next image could not load. ${errorMessage(error)}`)
    }
  }

  const approveAndNext = async () => {
    if (operation.current) return
    operation.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await approve({ id: image.id, expected_agent_review_id: image.agent_review_id ?? null })
      setApprovedId(image.id)
      setSelectedImage({ ...image, status: 'approved' })
      await showNextPending(image.id)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      operation.current = false
      setBusy(false)
    }
  }

  const retryNext = async () => {
    if (operation.current || !approvedId) return
    operation.current = true
    setBusy(true)
    setError('')
    try {
      await showNextPending(approvedId)
    } finally {
      operation.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !operation.current) close()
      }}
    >
      <DialogContent
        data-image-review-preview={image.id}
        aria-busy={busy}
        showCloseButton={!busy}
        className="max-h-[95dvh] w-[calc(100%-2rem)] max-w-[1100px] grid-cols-[minmax(0,1fr)] overflow-x-hidden overflow-y-auto"
      >
        <DialogHeader className="min-w-0 pr-7">
          <DialogTitle className="leading-snug [overflow-wrap:anywhere]">{image.title}</DialogTitle>
          <DialogDescription>
            <ImageFileDetails image={image} />
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="board">
          <TabsList aria-label="Image preview mode">
            <TabsTrigger value="board">Board preview</TabsTrigger>
            <TabsTrigger value="photo">Image only</TabsTrigger>
          </TabsList>
          <TabsContent value="board">
            <BackgroundBoardPreview image={image} />
            <p className="mt-2 text-xs text-text-2">
              Sample board with Canvas tint, blur and centered crop. The crop follows the window
              size.
            </p>
          </TabsContent>
          <TabsContent value="photo">
            <div className="relative h-[min(60dvh,650px)] overflow-hidden rounded-lg bg-surface-2">
              <Photo image={image} className="object-contain" />
            </div>
          </TabsContent>
        </Tabs>
        <Credit image={image} />
        <AgentPrecheck
          review={image.agent_review}
          note={image.agent_review_note}
          reviewer={image.agent_reviewer}
          reviewedAt={image.agent_reviewed_at}
        />
        {queryError && <Failure message={queryError} retry={retry} />}
        {error && <Failure message={error} />}
        {notice && (
          <p role="status" data-image-review-notice className="text-sm text-text-2">
            {notice}
          </p>
        )}
        <DialogFooter>
          {image.preview_url && (
            <Button asChild>
              <a href={image.preview_url} target="_blank" rel="noopener noreferrer">
                Open preview image
              </a>
            </Button>
          )}
          {image.status === 'pending' && approvedId !== image.id && (
            <Button
              ref={approveButton}
              type="button"
              data-image-preview-approve={image.id}
              variant="primary"
              disabled={busy || data === undefined || data === null || !!queryError}
              onClick={() => void approveAndNext()}
            >
              {busy ? 'Approving…' : 'Approve and next'}
            </Button>
          )}
          {nextFailed && (
            <Button type="button" disabled={busy} onClick={() => void retryNext()}>
              {busy ? 'Loading next image…' : 'Try next image again'}
            </Button>
          )}
          <Button type="button" disabled={busy} onClick={close}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function Backgrounds() {
  return (
    <div data-background-images>
      <AdminPageHeader
        title="Background images"
        description="Curate the library, assign recurring weekly scenes and review agent submissions from one workspace."
      />
      <LibrarySummary />
      <DefaultBackground />
      <Tabs defaultValue="library" className="mt-6 gap-6">
        <TabsList
          aria-label="Background image management"
          className="max-w-full flex-wrap justify-start gap-1 border border-border bg-surface-1 group-data-[orientation=horizontal]/tabs:h-auto"
        >
          <TabsTrigger value="library" className="px-4 text-text-2">
            Library
          </TabsTrigger>
          <TabsTrigger value="calendar" className="px-4 text-text-2">
            Calendar
          </TabsTrigger>
          <TabsTrigger value="submissions" className="px-4 text-text-2">
            Agent submissions
          </TabsTrigger>
          <TabsTrigger value="access" className="px-4 text-text-2">
            Agent access
          </TabsTrigger>
        </TabsList>
        <TabsContent value="library">
          <Library />
        </TabsContent>
        <TabsContent value="calendar">
          <ImageCalendar />
        </TabsContent>
        <TabsContent value="submissions">
          <AgentSubmissions />
        </TabsContent>
        <TabsContent value="access">
          <AgentAccess />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function DefaultBackground() {
  const { data, error, retry } = useLiveQuery(api.panoramaImages.calendar, {})
  const [editing, setEditing] = useState(false)
  const [preview, setPreview] = useState(false)
  if (error)
    return (
      <div className="mt-6">
        <Failure message={error} retry={retry} />
      </div>
    )
  if (!data) return null
  const current = data.default_image
  return (
    <Card className="mt-6 gap-3 p-5" data-default-background>
      <div className="flex flex-wrap items-start gap-5">
        {current && (
          <Button
            type="button"
            variant="unstyled"
            className={cn(IMAGE_THUMBNAIL_SIZE, 'shrink-0 overflow-hidden rounded-md')}
            aria-label={`Preview default background: ${current.title}`}
            onClick={() => setPreview(true)}
          >
            <Photo image={current} />
          </Button>
        )}
        {!current && (
          <div className="grid aspect-[16/10] w-64 max-w-full shrink-0 place-items-center rounded-lg border border-dashed border-border bg-surface-2 p-4 text-center text-sm text-text-2">
            No image selected
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-2">
            Canvas fallback
          </p>
          <h2 className="text-md font-semibold">Default background</h2>
          <p className="mt-1 text-sm text-text-2">
            {current?.title ||
              (data.default_image_id
                ? 'Default image unavailable — choose another image'
                : 'No default selected — solid background')}
          </p>
          <p className="mt-1 text-sm text-text-2">
            Used in weeks without an available calendar image.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            type="button"
            onClick={() => setEditing(true)}
            disabled={!data.default_image_id && data.approved_images.length === 0}
          >
            {current ? 'Change default' : 'Choose default'}
          </Button>
        </div>
      </div>
      {editing && (
        <DateAssignment
          current={current}
          currentId={data.default_image_id}
          images={data.approved_images}
          close={() => setEditing(false)}
        />
      )}
      {preview && current && <ImagePreview image={current} close={() => setPreview(false)} />}
    </Card>
  )
}

function LibrarySummary() {
  const { data, error, retry } = useLiveQuery(api.panoramaImages.summary, {})
  if (error) return <Failure message={error} retry={retry} />
  if (!data) return <Loading />
  return (
    <Card className="gap-6 p-5" data-image-summary>
      <dl className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        {(
          [
            ['Pending review', data.pending],
            ['Approved', data.approved],
            ['Removed', data.removed],
            ['In library', data.total],
          ] as const
        ).map(([label, count]) => (
          <div key={label}>
            <dt className="text-sm text-text-2">{label}</dt>
            <dd className="mt-1 text-xl font-semibold text-text-1">{count.toLocaleString()}</dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}

function Library() {
  const [filter, setFilter] = useState<LibraryFilter>('pending')
  const [agentFilter, setAgentFilter] = useState<AgentFilter>('all')
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])
  const [page, setPage] = useState(0)
  const [preview, setPreview] = useState<BackgroundImage | null>(null)
  const { data, error, retry } = useLiveQuery(api.panoramaImages.library, {
    ...(filter !== 'all' ? { status: filter } : {}),
    ...(agentFilter !== 'all' ? { agent_review: agentFilter } : {}),
    ...(cursors[page] ? { cursor: cursors[page] } : {}),
  })
  return (
    <div className="space-y-6">
      <ManualImageUpload />
      <div
        data-library-filters
        className="flex flex-wrap items-end justify-between gap-4 rounded-lg border border-border bg-surface-1 p-4"
      >
        <div className="min-w-0">
          <h2 className="text-md font-semibold">Review queue</h2>
          <p className="mt-1 text-sm text-text-2">
            Narrow the library before opening an image for review.
          </p>
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <Label htmlFor="background-status">Status</Label>
            <NativeSelect
              id="background-status"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value as LibraryFilter)
                setPage(0)
                setCursors([undefined])
              }}
              className="w-full min-w-44 bg-surface-1"
            >
              <option value="pending">Pending review</option>
              <option value="approved">Approved</option>
              <option value="removed">Removed</option>
              <option value="all">All images</option>
            </NativeSelect>
          </div>
          <div className="min-w-0 space-y-2">
            <Label htmlFor="background-precheck">Agent precheck</Label>
            <NativeSelect
              id="background-precheck"
              value={agentFilter}
              onChange={(e) => {
                setAgentFilter(e.target.value as AgentFilter)
                setPage(0)
                setCursors([undefined])
              }}
              className="w-full min-w-44 bg-surface-1"
            >
              <option value="all">All prechecks</option>
              <option value="unreviewed">Not prechecked</option>
              <option value="approved">Agent-approved</option>
              <option value="declined">Agent-declined</option>
            </NativeSelect>
          </div>
        </div>
      </div>
      {error ? (
        <Failure message={error} retry={retry} />
      ) : !data ? (
        <Loading />
      ) : data.images.length === 0 ? (
        <Card className="items-center gap-2 px-5 py-10 text-center">
          <ImageIcon className="mb-1 size-7 text-text-2" aria-hidden="true" />
          <h2 className="text-md font-semibold">
            {agentFilter !== 'all'
              ? 'No images match these filters'
              : page > 0
                ? 'No images on this page'
                : filter === 'pending'
                  ? 'No images waiting for review'
                  : filter === 'all'
                    ? 'The image library is empty'
                    : `No ${filter} images`}
          </h2>
        </Card>
      ) : (
        <div className={cn(IMAGE_GALLERY_GRID, 'items-start')}>
          {data.images.map((image) => (
            <ImageCard key={image.id} image={image} preview={() => setPreview(image)} />
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 border-t border-border pt-6">
        <p className="text-sm text-text-2">
          Page {page + 1}
          {data ? `, ${data.images.length} images` : ''}
        </p>
        <div className="flex gap-2">
          <Button type="button" disabled={page === 0} onClick={() => setPage((n) => n - 1)}>
            Previous
          </Button>
          <Button
            type="button"
            disabled={!data || data.isDone || !data.continueCursor}
            onClick={() => {
              if (!data?.continueCursor) return
              setCursors((prev) => [...prev.slice(0, page + 1), data.continueCursor])
              setPage((n) => n + 1)
            }}
          >
            Next
          </Button>
        </div>
      </div>
      {preview && (
        <ImagePreview image={preview} agentFilter={agentFilter} close={() => setPreview(null)} />
      )}
    </div>
  )
}

function ManualImageUpload() {
  const [imageId, setImageId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [batchResult, setBatchResult] = useState<BackgroundImageBatchResult | null>(null)
  const [formVersion, setFormVersion] = useState(0)
  return (
    <Card data-manual-image-add className="gap-6 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-md font-semibold">Upload images</h2>
          <p className="mt-1 max-w-2xl text-sm text-text-2">
            Add a licensed image to the review queue. You can enter credits for one image or use
            embedded metadata for a batch.
          </p>
        </div>
        <Badge kind="muted">Manual upload</Badge>
      </div>
      <ImageUpload
        key={formVersion}
        target={{
          added: (image, reused) => {
            setBatchResult(null)
            setImageId(image.id)
            setNotice(
              reused ? 'Already in the library. Review it below.' : 'Image added for review.',
            )
          },
          batchAdded: (result) => {
            setImageId(null)
            setNotice('')
            setBatchResult(result)
          },
        }}
        cancel={() => setFormVersion((version) => version + 1)}
      />
      {notice && (
        <p role="status" className="text-sm text-text-1">
          {notice}
        </p>
      )}
      {batchResult && (
        <div
          role="status"
          data-manual-image-batch-result
          className="space-y-2 rounded-md border border-border bg-surface-2 p-3 text-sm"
        >
          <p>
            {batchResult.added} {batchResult.added === 1 ? 'image added' : 'images added'} for
            review.
            {batchResult.reused > 0 &&
              ` ${batchResult.reused} ${batchResult.reused === 1 ? 'image was' : 'images were'} already in the library.`}
          </p>
          {batchResult.missingMetadata.length > 0 && (
            <div>
              <p>
                {batchResult.missingMetadata.length}{' '}
                {batchResult.missingMetadata.length === 1 ? 'image was' : 'images were'} skipped
                because title or author was missing from the metadata. Select these images one at a
                time to add the missing details.
              </p>
              <details className="mt-2">
                <summary className="cursor-pointer">Skipped images</summary>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {Array.from(new Set(batchResult.missingMetadata)).map((name) => (
                    <li key={name} className="break-words">
                      {name}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}
          {batchResult.failed.length > 0 && (
            <div>
              <p>{batchResult.failed.length} files could not be added:</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {Array.from(
                  new Set(batchResult.failed.map(({ name, message }) => `${name}: ${message}`)),
                ).map((failure) => (
                  <li key={failure} className="break-words">
                    {failure}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {imageId && (
        <ManualImageResult
          key={imageId}
          id={imageId}
          dismiss={() => {
            setImageId(null)
            setNotice('')
          }}
        />
      )}
    </Card>
  )
}

function ManualImageResult({ id, dismiss }: { id: string; dismiss: () => void }) {
  const { data, error, retry } = useLiveQuery(api.panoramaCuration.libraryImage, { id })
  const [preview, setPreview] = useState(false)
  if (error) return <Failure message={error} retry={retry} />
  if (data === undefined) return <Loading />
  return (
    <div data-manual-image-result className="space-y-6 border-t border-border pt-6">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-md font-semibold">Selected image</h3>
        <Button type="button" onClick={dismiss}>
          Dismiss
        </Button>
      </div>
      {data ? (
        <div className="max-w-md">
          <ImageCard image={data} preview={() => setPreview(true)} />
        </div>
      ) : (
        <p className="text-sm text-text-2">This image is no longer available.</p>
      )}
      {preview && data && <ImagePreview image={data} close={() => setPreview(false)} />}
    </div>
  )
}

function ImageCard({ image, preview }: { image: BackgroundImage; preview: () => void }) {
  const removeNoteId = useId()
  const approve = useLiveMutation(api.panoramaImages.approve)
  const remove = useLiveMutation(api.panoramaImages.remove)
  const [removing, setRemoving] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useUpdateBlocker(removing || busy)
  const perform = async (action: 'approve' | 'remove') => {
    setBusy(true)
    setError('')
    try {
      if (action === 'approve')
        await approve({ id: image.id, expected_agent_review_id: image.agent_review_id ?? null })
      else await remove({ id: image.id, ...(note.trim() ? { note: note.trim() } : {}) })
      setRemoving(false)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card data-background-image={image.id} className="min-w-0 gap-0 overflow-hidden py-0">
      <Button
        type="button"
        variant="unstyled"
        onClick={preview}
        aria-label={`Preview ${image.title}`}
        className={cn(
          IMAGE_FRAME,
          'group w-full text-left focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-ring',
        )}
      >
        <Photo image={image} />
        <span className="absolute right-2 bottom-2 rounded-md border border-white/20 bg-black/80 p-2 text-white">
          <Maximize2 className="size-4" aria-hidden="true" />
        </span>
      </Button>
      <div className="space-y-2 p-5">
        <div>
          <Badge
            kind={
              image.status === 'removed'
                ? 'danger'
                : image.status === 'approved'
                  ? 'accent'
                  : 'muted'
            }
          >
            {STATUS_LABEL[image.status]}
          </Badge>
          <h2 className="mt-2 break-words text-md leading-snug font-semibold">{image.title}</h2>
        </div>
        <Credit image={image} compact />
        <AgentPrecheck
          review={image.agent_review}
          note={image.agent_review_note}
          reviewer={image.agent_reviewer}
          reviewedAt={image.agent_reviewed_at}
        />
        {image.requested_day && (
          <p className="text-sm text-text-2">Suggested week: {displayDay(image.requested_day)}</p>
        )}
        <p className="text-sm text-text-2">
          <ImageFileDetails image={image} />
        </p>
        {image.review_note && (
          <p className="break-words text-sm text-text-2">Review note: {image.review_note}</p>
        )}
        {error && <Failure message={error} />}
        {image.status !== 'removed' &&
          (removing ? (
            <div className="space-y-2 rounded-md border border-danger/40 bg-danger-soft p-5">
              <p className="text-sm text-text-1">
                Remove this image? This also clears every calendar week assigned to it.
              </p>
              <div className="space-y-2">
                <Label htmlFor={removeNoteId}>Reason (optional)</Label>
                <Textarea
                  id={removeNoteId}
                  value={note}
                  disabled={busy}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  maxLength={500}
                  className="bg-surface-1 text-sm"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  data-image-remove-confirm={image.id}
                  variant="destructive"
                  className="border-red-700 bg-red-700 text-white hover:bg-red-800"
                  disabled={busy}
                  onClick={() => void perform('remove')}
                >
                  {busy ? 'Removing…' : 'Remove image'}
                </Button>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setRemoving(false)
                    setError('')
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2 border-t border-border pt-6">
              {image.status === 'pending' && (
                <Button
                  type="button"
                  data-image-approve={image.id}
                  variant="primary"
                  className="border-blue-600 bg-blue-600 text-white hover:border-blue-700 hover:bg-blue-700"
                  disabled={busy}
                  onClick={() => void perform('approve')}
                >
                  {busy ? 'Approving…' : 'Approve'}
                </Button>
              )}
              <Button
                type="button"
                data-image-remove={image.id}
                disabled={busy}
                className="text-danger"
                onClick={() => setRemoving(true)}
              >
                Remove
              </Button>
            </div>
          ))}
      </div>
    </Card>
  )
}

function displayDay(day: string) {
  return `Week ${Number(calendarWeekForKey(day).slice(1))}`
}

function AgentPrecheck({
  review,
  note,
  reviewer,
  reviewedAt,
}: {
  review?: AgentReview
  note?: string
  reviewer?: string
  reviewedAt?: string
}) {
  if (!review) return <p className="text-sm text-text-2">Not prechecked</p>
  return (
    <details className="rounded-md border border-border px-2.5 py-2 text-sm">
      <summary className="cursor-pointer text-text-2">
        {review === 'approved' ? 'Agent-approved' : 'Agent-declined'}, precheck
      </summary>
      <div className="mt-2 space-y-1 text-text-2">
        <p className="break-words text-text-1">{note || 'No review note provided.'}</p>
        {(reviewer || reviewedAt) && (
          <p>
            {reviewer ? `By ${reviewer}` : ''}
            {reviewer && reviewedAt ? ', ' : ''}
            {reviewedAt ? new Date(reviewedAt).toLocaleString() : ''}
          </p>
        )}
      </div>
    </details>
  )
}

type CurationKey = {
  id: string
  name: string
  key_prefix: string
  created_at: string
  last_used_at?: string
  revoked_at?: string
  expires_at: string
}

function AgentAccess() {
  const { data, error, retry } = useLiveQuery(api.panoramaCuration.keys, {})
  const mint = useLiveMutation(api.panoramaCuration.mintKey)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [revealed, setRevealed] = useState<{ secret: string; name: string } | null>(null)
  useUpdateBlocker(!!name || busy || !!revealed)
  const endpoint = `${String(import.meta.env.VITE_CONVEX_SITE_URL || '').replace(/\/+$/, '')}/v1/curation`
  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy || revealed || !name.trim()) return
    setBusy(true)
    setFailure('')
    try {
      const result = await mint({ name: name.trim() })
      // Plaintext lives only in this mounted reveal. Never cache it or include
      // it in an example, URL, toast, log, or persisted preference.
      setRevealed({ secret: result.secret, name: name.trim() })
      setName('')
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div data-curation-access className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-surface-1 p-4">
        <div className="min-w-0">
          <h2 className="text-md font-semibold">Agent access</h2>
          <p className="mt-1 max-w-2xl text-sm text-text-2">
            Issue scoped keys for agents that can propose and precheck images. Only operators can
            approve or schedule them.
          </p>
        </div>
        <Badge kind="muted">Operator controlled</Badge>
      </div>
      <Card className="gap-2 p-5">
        <h2 className="text-md font-semibold">Agent access keys</h2>
        <p className="max-w-3xl text-sm text-text-2">
          Agents can read the library, precheck images and propose weeks. Only human reviewers can
          approve and schedule images. Keys expire after one year.
        </p>
        <form onSubmit={(event) => void create(event)} className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-64 space-y-2">
            <Label htmlFor="curation-key-name">Agent name</Label>
            <Input
              id="curation-key-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              disabled={busy || !!revealed}
              className="bg-surface-1"
            />
          </div>
          <Button
            type="submit"
            data-curation-mint
            variant="primary"
            className="border-blue-600 bg-blue-600 text-white hover:border-blue-700 hover:bg-blue-700"
            disabled={busy || !!revealed || !name.trim()}
          >
            {busy ? 'Creating…' : 'Create access key'}
          </Button>
        </form>
        {failure && <Failure message={failure} />}
        {revealed && (
          <CurationSecret
            secret={revealed.secret}
            name={revealed.name}
            done={() => setRevealed(null)}
          />
        )}
      </Card>
      {error ? (
        <Failure message={error} retry={retry} />
      ) : !data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card className="gap-2 p-5">
          <h3 className="text-md font-semibold">No agent keys yet</h3>
        </Card>
      ) : (
        <div className="space-y-3">
          {data.map((key) => (
            <CurationKeyRow key={key.id} item={key} />
          ))}
        </div>
      )}
      <Card className="gap-2 p-5">
        <h2 className="text-md font-semibold">Connect an agent</h2>
        <pre className="overflow-x-auto rounded-md border border-border bg-surface-2 p-3 text-sm text-text-1">
          <code>{`POST ${endpoint}/submissions\nAuthorization: Bearer YOUR_KEY\nContent-Type: application/json\n\n${JSON.stringify({ url: 'https://unsplash.com/photos/PHOTO_ID', date: 'W52' }, null, 2)}`}</code>
        </pre>
        <p className="text-sm text-text-2">
          URL proposals need a licensed image file before a reviewer can approve them.
        </p>
      </Card>
    </div>
  )
}

function CurationSecret({
  secret,
  name,
  done,
}: {
  secret: string
  name: string
  done: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  return (
    <div
      data-curation-secret
      className="space-y-6 rounded-md border border-border-strong bg-surface-2 p-5"
    >
      <div>
        <h3 className="text-md font-semibold">Access key for {name}</h3>
        <p className="mt-2 text-sm text-text-2">Copy this key now. It won’t be shown again.</p>
      </div>
      <code className="block select-all break-all rounded-md bg-surface-1 p-3 text-sm text-text-1">
        {secret}
      </code>
      <div className="flex gap-2">
        <Button
          type="button"
          data-curation-copy
          onClick={() => {
            setError('')
            if (!navigator.clipboard?.writeText) {
              setError('Clipboard access is unavailable. Select and copy the key above.')
              return
            }
            void navigator.clipboard
              .writeText(secret)
              .then(() => setCopied(true))
              .catch(() => setError('Clipboard access failed. Select and copy the key above.'))
          }}
        >
          {copied ? 'Copied' : 'Copy key'}
        </Button>
        <Button type="button" data-curation-secret-done onClick={done}>
          Done
        </Button>
      </div>
      {error && <Failure message={error} />}
    </div>
  )
}

function CurationKeyRow({ item }: { item: CurationKey }) {
  const revoke = useLiveMutation(api.panoramaCuration.revokeKey)
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useUpdateBlocker(armed || busy)
  const expired = new Date(item.expires_at).getTime() <= Date.now()
  const active = !item.revoked_at && !expired
  return (
    <Card data-curation-key={item.id} className="gap-2 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words text-md font-semibold">{item.name}</h3>
          <p className="mt-2 break-all font-mono text-xs text-text-2">{item.key_prefix}</p>
        </div>
        <Badge kind={active ? 'muted' : 'danger'}>
          {item.revoked_at ? 'Revoked' : expired ? 'Expired' : 'Active'}
        </Badge>
      </div>
      <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-text-2">Created</dt>
          <dd>{new Date(item.created_at).toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-text-2">Last used</dt>
          <dd>{item.last_used_at ? new Date(item.last_used_at).toLocaleString() : 'Never used'}</dd>
        </div>
        <div>
          <dt className="text-text-2">Expires</dt>
          <dd>{new Date(item.expires_at).toLocaleString()}</dd>
        </div>
      </dl>
      {error && <Failure message={error} />}
      {active &&
        (armed ? (
          <div className="space-y-2 rounded-md border border-danger/40 bg-danger-soft p-5">
            <p className="text-sm">
              Revoke access for {item.name}? This key will stop working immediately.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                data-curation-revoke-confirm={item.id}
                variant="destructive"
                className="border-red-700 bg-red-700 text-white hover:bg-red-800"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  setError('')
                  void revoke({ id: item.id })
                    .then(() => setArmed(false))
                    .catch((error) => setError(errorMessage(error)))
                    .finally(() => setBusy(false))
                }}
              >
                {busy ? 'Revoking…' : 'Revoke key'}
              </Button>
              <Button type="button" disabled={busy} onClick={() => setArmed(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button
              type="button"
              data-curation-revoke={item.id}
              className="text-danger"
              onClick={() => setArmed(true)}
            >
              Revoke access
            </Button>
          </div>
        ))}
    </Card>
  )
}

type Submission = {
  id: string
  source_url: string
  day: string
  title?: string
  creator?: string
  reason?: string
  status: 'needs_file' | 'pending' | 'accepted' | 'declined'
  submitted_at: string
  submitted_by: string
  agent_review?: AgentReview
  agent_review_note?: string
  agent_review_id?: string
  agent_reviewed_at?: string
  agent_reviewer?: string
  image_id?: string
  image_url?: string | null
  preview_url?: string | null
  existing_image_id: string | null
  existing_image_title: string | null
  review_note?: string
}
const SUBMISSION_STATUS: Record<Submission['status'], string> = {
  needs_file: 'Needs image file',
  pending: 'Pending human review',
  accepted: 'Accepted',
  declined: 'Declined',
}

function AgentSubmissions() {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])
  const [page, setPage] = useState(0)
  const [failure, setFailure] = useState('')
  const proposals = useLiveQuery(api.panoramaCuration.submissions, {
    ...(cursors[page] ? { cursor: cursors[page] } : {}),
  })
  const calendar = useLiveQuery(api.panoramaImages.calendar, {})
  const { data, error, retry } = proposals
  return (
    <div data-curation-submissions className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-surface-1 p-4">
        <div className="min-w-0">
          <h2 className="text-md font-semibold">Agent submissions</h2>
          <p className="mt-1 max-w-2xl text-sm text-text-2">
            Review proposed images before they enter the shared library or replace a calendar week.
          </p>
        </div>
        <Badge kind="muted">Human approval required</Badge>
      </div>
      {failure && <Failure message={failure} />}
      {calendar.error && <Failure message={calendar.error} retry={calendar.retry} />}
      {error ? (
        <Failure message={error} retry={retry} />
      ) : !data ? (
        <Loading />
      ) : data.submissions.length === 0 ? (
        <Card className="gap-2 p-5">
          <h2 className="text-md font-semibold">
            {page ? 'No submissions on this page' : 'No agent submissions yet'}
          </h2>
        </Card>
      ) : (
        <div className="space-y-6">
          {data.submissions.map((submission) => (
            <SubmissionCard
              key={submission.id}
              submission={submission}
              assignedImage={
                calendar.data?.slots.find((slot) => slot.day === calendarWeekForKey(submission.day))
                  ?.image || null
              }
              onReviewError={(message) => {
                setFailure(message)
                proposals.retry()
                calendar.retry()
              }}
            />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-6">
        <p className="text-sm text-text-2">
          Page {page + 1}
          {data ? `, ${data.submissions.length} submissions` : ''}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            disabled={page === 0}
            onClick={() => {
              setFailure('')
              setPage((n) => n - 1)
            }}
          >
            Previous
          </Button>
          <Button
            type="button"
            disabled={!data || data.isDone || !data.continueCursor}
            onClick={() => {
              if (!data?.continueCursor) return
              setCursors((prev) => [...prev.slice(0, page + 1), data.continueCursor])
              setPage((n) => n + 1)
              setFailure('')
            }}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}

function SubmissionCard({
  submission,
  assignedImage,
  onReviewError,
}: {
  submission: Submission
  assignedImage: BackgroundImage | null
  onReviewError: (message: string) => void
}) {
  const accept = useLiveMutation(api.panoramaCuration.accept)
  const decline = useLiveMutation(api.panoramaCuration.decline)
  const [uploading, setUploading] = useState(false)
  const [declining, setDeclining] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(false)
  const [confirmation, setConfirmation] = useState<{
    id: string | null
    title: string | null
    previewUrl: string | null
    reviewId: string | null
  } | null>(null)
  useUpdateBlocker(uploading || declining || busy || !!confirmation)
  const open = submission.status === 'needs_file' || submission.status === 'pending'
  const canAccept =
    submission.status === 'pending' && !!submission.image_id && !!submission.image_url
  const sourceName = submission.title || 'Image proposal'
  const finalize = async (decision: 'accept' | 'decline') => {
    if (busy || (decision === 'accept' && !confirmation)) return
    setBusy(true)
    try {
      if (decision === 'accept')
        await accept({
          id: submission.id,
          expected_image_id: confirmation!.id,
          expected_agent_review_id: confirmation!.reviewId,
        })
      else await decline({ id: submission.id, ...(note.trim() ? { note: note.trim() } : {}) })
      setConfirmation(null)
      setDeclining(false)
    } catch (error) {
      setConfirmation(null)
      onReviewError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card data-curation-submission={submission.id} className="gap-6 p-5">
      <div className="flex flex-wrap items-start gap-4">
        {submission.image_id && (
          <Button
            type="button"
            variant="unstyled"
            onClick={() => setPreview(true)}
            aria-label={`Preview ${sourceName}`}
            className={cn(
              IMAGE_THUMBNAIL_SIZE,
              'shrink-0 overflow-hidden rounded-md focus-visible:outline-2 focus-visible:outline-ring',
            )}
          >
            <Photo image={{ preview_url: submission.preview_url || null, title: sourceName }} />
          </Button>
        )}
        <div className="min-w-0 flex-1 basis-64 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              kind={
                submission.status === 'declined'
                  ? 'danger'
                  : submission.status === 'accepted'
                    ? 'accent'
                    : 'muted'
              }
            >
              {SUBMISSION_STATUS[submission.status]}
            </Badge>
            <span className="text-sm font-semibold">{displayDay(submission.day)}</span>
          </div>
          <h2 className="break-words text-md font-semibold">{sourceName}</h2>
          <p className="text-sm text-text-2">
            Proposed by {submission.submitted_by},{' '}
            {new Date(submission.submitted_at).toLocaleString()}
          </p>
          {submission.creator && (
            <p className="text-sm text-text-2">Photo by {submission.creator}</p>
          )}
          <a
            href={submission.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block break-all text-sm text-text-1 underline underline-offset-4"
          >
            View image source
          </a>
        </div>
      </div>
      {submission.reason && (
        <details className="text-sm">
          <summary className="cursor-pointer text-text-2">Why this image was proposed</summary>
          <p className="mt-2 break-words">{submission.reason}</p>
        </details>
      )}
      <AgentPrecheck
        review={submission.agent_review}
        note={submission.agent_review_note}
        reviewer={submission.agent_reviewer}
        reviewedAt={submission.agent_reviewed_at}
      />
      {submission.review_note && (
        <p className="break-words text-sm text-text-2">
          Human review note: {submission.review_note}
        </p>
      )}
      {submission.status === 'pending' && !submission.image_url && (
        <p className="text-sm text-text-2">
          The image is unavailable. Decline this proposal and submit a new one with another image.
        </p>
      )}
      {open && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-surface-1 p-3">
          {assignedImage?.id === submission.existing_image_id && (
            <div className={cn(IMAGE_THUMBNAIL_SIZE, 'shrink-0 overflow-hidden rounded')}>
              <Photo image={assignedImage} />
            </div>
          )}
          <div className="min-w-0 text-sm">
            <p className="text-text-2">Currently assigned to {displayDay(submission.day)}</p>
            <p className="break-words text-text-1">
              {submission.existing_image_title ||
                (submission.existing_image_id ? 'Assigned image' : 'No image assigned')}
            </p>
          </div>
        </div>
      )}
      {submission.status === 'needs_file' && (
        <div className="space-y-3">
          <p className="text-sm text-text-2">
            Add a JPEG obtained under the standard Unsplash license before approving. Unsplash+ is
            not covered.
          </p>
          {uploading ? (
            <ImageUpload target={{ submission }} cancel={() => setUploading(false)} />
          ) : (
            <div>
              <Button
                type="button"
                data-curation-upload-open={submission.id}
                onClick={() => setUploading(true)}
              >
                Add licensed image file
              </Button>
            </div>
          )}
        </div>
      )}
      {open &&
        (confirmation ? (
          <div className="space-y-6 rounded-md border border-border-strong bg-surface-2 p-5">
            <h3 className="text-md font-semibold">
              Approve {sourceName} for {displayDay(submission.day)}?
            </h3>
            {confirmation.id ? (
              <div className="flex items-center gap-2">
                <div className={cn(IMAGE_THUMBNAIL_SIZE, 'shrink-0 overflow-hidden rounded')}>
                  <Photo
                    image={{
                      preview_url:
                        assignedImage?.id === confirmation.id
                          ? assignedImage.preview_url
                          : confirmation.previewUrl,
                      title: confirmation.title || 'Current calendar image',
                    }}
                  />
                </div>
                <p className="text-sm text-text-2">
                  This replaces{' '}
                  <span className="text-text-1">{confirmation.title || 'the current image'}</span>{' '}
                  in this week each year. The previous image stays in the library.
                </p>
              </div>
            ) : (
              <p className="text-sm text-text-2">This assignment repeats every year.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                data-curation-accept-confirm={submission.id}
                variant="primary"
                className="border-blue-600 bg-blue-600 text-white hover:border-blue-700 hover:bg-blue-700"
                disabled={busy || !canAccept}
                onClick={() => void finalize('accept')}
              >
                {busy
                  ? 'Accepting…'
                  : confirmation.id
                    ? 'Approve and replace image'
                    : 'Approve and assign image'}
              </Button>
              <Button type="button" disabled={busy} onClick={() => setConfirmation(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : declining ? (
          <div className="space-y-2 rounded-md border border-danger/40 bg-danger-soft p-5">
            <p className="text-sm">Decline this proposal?</p>
            <p className="text-sm text-text-2">Any linked image stays in the library.</p>
            <div className="space-y-2">
              <Label htmlFor={`submission-note-${submission.id}`}>Reason (optional)</Label>
              <Textarea
                id={`submission-note-${submission.id}`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={2000}
                disabled={busy}
                className="bg-surface-1"
              />
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                data-curation-decline-confirm={submission.id}
                variant="destructive"
                className="border-red-700 bg-red-700 text-white hover:bg-red-800"
                disabled={busy}
                onClick={() => void finalize('decline')}
              >
                {busy ? 'Declining…' : 'Decline proposal'}
              </Button>
              <Button type="button" disabled={busy} onClick={() => setDeclining(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2 border-t border-border pt-6">
            {canAccept && (
              <Button
                type="button"
                data-curation-accept={submission.id}
                variant="primary"
                className="border-blue-600 bg-blue-600 text-white hover:border-blue-700 hover:bg-blue-700"
                onClick={() => {
                  setConfirmation({
                    id: submission.existing_image_id,
                    title: submission.existing_image_title,
                    reviewId: submission.agent_review_id || null,
                    previewUrl:
                      assignedImage?.id === submission.existing_image_id
                        ? assignedImage.preview_url
                        : null,
                  })
                }}
              >
                Review acceptance
              </Button>
            )}
            <Button
              type="button"
              data-curation-decline={submission.id}
              className="text-danger"
              disabled={uploading}
              onClick={() => setDeclining(true)}
            >
              Decline
            </Button>
          </div>
        ))}
      {preview && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setPreview(false)
          }}
        >
          <DialogContent className="max-h-[95dvh] w-[calc(100%-2rem)] max-w-[1100px] overflow-y-auto">
            <DialogHeader className="pr-7">
              <DialogTitle>{sourceName}</DialogTitle>
              <DialogDescription>
                {submission.creator ? `Photo by ${submission.creator}. ` : ''}Proposed for{' '}
                {displayDay(submission.day)}.
              </DialogDescription>
            </DialogHeader>
            <div className="relative h-[min(60dvh,650px)] overflow-hidden rounded-lg bg-surface-2">
              <Photo
                image={{ preview_url: submission.preview_url || null, title: sourceName }}
                className="object-contain"
              />
            </div>
            <a
              href={submission.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline underline-offset-4"
            >
              View original source and credit
            </a>
            <DialogFooter>
              <Button type="button" onClick={() => setPreview(false)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  )
}

type ImageUploadTarget =
  | { submission: Submission }
  | {
      added: (image: BackgroundImage, reused: boolean) => void
      batchAdded: (result: BackgroundImageBatchResult) => void
    }

function ImageUpload({ target, cancel }: { target: ImageUploadTarget; cancel: () => void }) {
  const submission = 'submission' in target ? target.submission : null
  const sourceUrl = submission?.source_url || ''
  const formId = submission?.id ?? 'manual'
  const fieldId = (field: string) =>
    submission ? `submission-${field}-${formId}` : `manual-image-${field}`
  const uploadUrl = useLiveMutation(api.panoramaCuration.uploadUrl)
  const attachFile = useLiveAction(api.panoramaCuration.attachFile)
  const manualUploadUrl = useLiveMutation(api.panoramaUploads.uploadUrl)
  const addManual = useLiveAction(api.panoramaUploads.addFile)
  const [file, setFile] = useState<File | null>(null)
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [title, setTitle] = useState(submission?.title || '')
  const [location, setLocation] = useState('')
  const [creator, setCreator] = useState(submission?.creator || '')
  const previousMetadata = useRef<ImageMetadata>({})
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [batchProgress, setBatchProgress] = useState<BackgroundImageBatchProgress | null>(null)
  const [error, setError] = useState('')
  useUpdateBlocker(
    busy ||
      checking ||
      !!file ||
      confirmed ||
      !!location ||
      title !== (submission?.title || '') ||
      creator !== (submission?.creator || ''),
  )
  useEffect(() => {
    if (!previewBlob) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(previewBlob)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [previewBlob])
  const chooseFile = async (picked?: File) => {
    setFile(null)
    setPreviewBlob(null)
    setDimensions(null)
    setError('')
    setConfirmed(false)
    if (!picked) return
    setChecking(true)
    try {
      const prepared = await prepareBackgroundImage(picked, {
        jpegOnly: !!submission,
        preview: true,
      })
      if (!prepared) return
      setPreviewBlob(prepared.preview)
      setDimensions(prepared.dimensions)
      const metadata = prepared.metadata
      // Replace the previous file's prefill, while retaining manual entries
      // when the new file has no corresponding metadata.
      const previous = previousMetadata.current
      setTitle(
        (current) =>
          metadata.title?.slice(0, 300) ??
          (current === previous.title?.slice(0, 300) ? submission?.title || '' : current),
      )
      setLocation(
        (current) =>
          metadata.location?.slice(0, 300) ??
          (current === previous.location?.slice(0, 300) ? '' : current),
      )
      setCreator(
        (current) =>
          metadata.creator?.slice(0, 300) ??
          (current === previous.creator?.slice(0, 300) ? submission?.creator || '' : current),
      )
      previousMetadata.current = metadata
      setFile(picked)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setChecking(false)
    }
  }
  const saveFile = async (
    picked: File,
    credits: { title: string; creator: string; location?: string },
  ) => {
    const url = submission
      ? await uploadUrl({ submission_id: submission.id })
      : await manualUploadUrl({})
    const namedFile = new File(
      [picked],
      panoramaFilename(credits.title, credits.creator, picked.type),
      { type: picked.type, lastModified: picked.lastModified },
    )
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': picked.type },
      body: namedFile,
    })
    if (!response.ok) throw new Error('The upload failed. Please try again.')
    const uploaded: { storageId: string } = await response.json()
    const fields = {
      storage_id: uploaded.storageId as Id<'_storage'>,
      title: credits.title.trim(),
      location: credits.location?.trim() || undefined,
      creator: credits.creator.trim(),
    }
    if (submission) {
      await attachFile({ submission_id: submission.id, ...fields, license_confirmed: true })
      return null
    }
    return await addManual({ ...fields, rights_confirmed: true })
  }
  const chooseFiles = async (files: File[]) => {
    if (busy || checking) return
    if (submission || files.length < 2) {
      await chooseFile(files[0])
      return
    }
    // Keep the entire batch protected, including storage POSTs and time between files.
    const releaseUpdateBlock = beginUpdateBlock()
    setBusy(true)
    setFile(null)
    setPreviewBlob(null)
    setDimensions(null)
    setError('')
    try {
      const result = await importBackgroundImages(
        files,
        async (file, credits) => {
          const saved = await saveFile(file, credits)
          if (!saved) throw new Error('The image was not added. Please try again.')
          return saved
        },
        setBatchProgress,
        errorMessage,
      )
      if ('batchAdded' in target) target.batchAdded(result)
      cancel()
    } finally {
      setBatchProgress(null)
      setBusy(false)
      releaseUpdateBlock()
    }
  }
  const upload = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!file || (submission && !confirmed) || !title.trim() || !creator.trim() || busy || checking)
      return
    // Protect the storage POST between the upload-URL mutation and the final
    // action, including when a view is closed while the upload finishes.
    const releaseUpdateBlock = beginUpdateBlock()
    setBusy(true)
    setError('')
    try {
      const result = await saveFile(file, { title, location, creator })
      if (result && 'added' in target) target.added(result.image, result.reused)
      cancel()
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
      releaseUpdateBlock()
    }
  }
  return (
    <form
      onSubmit={(event) => void upload(event)}
      className={cn('space-y-6', submission && 'rounded-md border border-border bg-surface-2 p-5')}
      data-unsplash-upload={submission ? formId : undefined}
      data-manual-image-upload={!submission ? '' : undefined}
    >
      {submission && (
        <>
          <h3 className="text-md font-semibold">Add the licensed image</h3>
          <p className="text-sm text-text-2">
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-1 underline underline-offset-4"
            >
              Open photo on Unsplash
            </a>
          </p>
        </>
      )}
      <div className="space-y-2">
        <Label htmlFor={fieldId('file')}>
          {submission ? 'JPEG file, up to 8 MB' : 'Image file'}
        </Label>
        <p id={fieldId('file-hint')} className="text-sm text-text-2">
          {submission ? PANORAMA_IMAGE_REQUIREMENTS : MANUAL_IMAGE_REQUIREMENTS}
        </p>
        {!submission && (
          <div id={fieldId('batch-hint')} className="space-y-2 text-sm text-text-2">
            <p>
              Choose one image to edit its details before saving. Select multiple images to upload
              them immediately using their embedded title and author. Images missing either field
              are skipped. New images are added for review.
            </p>
            <p>
              By uploading images, I confirm that I have permission to use them for this purpose.
            </p>
          </div>
        )}
        <Input
          id={fieldId('file')}
          data-curation-file={submission ? formId : undefined}
          data-manual-image-file={!submission ? '' : undefined}
          type="file"
          multiple={!submission}
          accept={submission ? 'image/jpeg' : 'image/jpeg,image/png,image/webp'}
          aria-describedby={
            submission ? fieldId('file-hint') : `${fieldId('file-hint')} ${fieldId('batch-hint')}`
          }
          required
          disabled={busy || checking}
          onChange={(event) => {
            void chooseFiles(Array.from(event.target.files || []))
          }}
          className="bg-surface-1"
        />
      </div>
      {checking && (
        <p role="status" className="text-sm text-text-2">
          Checking image…
        </p>
      )}
      {batchProgress && (
        <p role="status" className="break-words text-sm text-text-2">
          Adding image {batchProgress.current} of {batchProgress.total}: {batchProgress.name}
        </p>
      )}
      {file && (
        <div className="space-y-2">
          <div className={cn(IMAGE_FRAME, 'w-full max-w-sm rounded-lg')}>
            <Photo
              image={{ preview_url: previewUrl, title: title || file.name }}
              className="object-contain"
            />
          </div>
          <p className="break-words text-sm text-text-2">
            {file.name}, {fmtBytes(file.size)}
            {dimensions &&
              `, ${dimensions.width} × ${dimensions.height} pixels, ${(dimensions.width / dimensions.height).toFixed(2)}:1`}
          </p>
        </div>
      )}
      <div className="grid gap-6 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor={fieldId('title')}>Title</Label>
          <Input
            id={fieldId('title')}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={300}
            required
            disabled={busy || checking}
            className="bg-surface-1"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={fieldId('location')}>Location</Label>
          <Input
            id={fieldId('location')}
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            maxLength={300}
            disabled={busy || checking}
            className="bg-surface-1"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={fieldId('creator')}>Creator</Label>
          <Input
            id={fieldId('creator')}
            value={creator}
            onChange={(event) => setCreator(event.target.value)}
            maxLength={300}
            required
            disabled={busy || checking}
            className="bg-surface-1"
          />
        </div>
      </div>
      <div className="space-y-2">
        {submission && (
          <p className="text-sm text-text-2">
            Source:{' '}
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-1 underline underline-offset-4"
            >
              Unsplash photo
            </a>
          </p>
        )}
        {submission && (
          <div className="flex items-start gap-2">
            <Checkbox
              id={fieldId('license')}
              checked={confirmed}
              onCheckedChange={(checked) => setConfirmed(checked === true)}
              disabled={busy || checking}
              className="mt-0.5"
            />
            <Label htmlFor={fieldId('license')} className="leading-normal">
              I obtained this image under the standard Unsplash license
            </Label>
          </div>
        )}
        {submission && (
          <p className="text-sm text-text-2">
            Unsplash+ content is not covered by this confirmation.
          </p>
        )}
      </div>
      {error && <Failure message={error} />}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          data-curation-upload={submission ? formId : undefined}
          data-manual-image-submit={!submission ? '' : undefined}
          variant="primary"
          className="border-blue-600 bg-blue-600 text-white hover:border-blue-700 hover:bg-blue-700"
          disabled={
            busy ||
            checking ||
            !file ||
            !title.trim() ||
            !creator.trim() ||
            (!!submission && !confirmed)
          }
        >
          {batchProgress ? 'Adding images…' : busy ? 'Saving image…' : 'Save image'}
        </Button>
        <Button type="button" disabled={busy || checking} onClick={cancel}>
          {submission ? 'Cancel' : 'Clear'}
        </Button>
      </div>
    </form>
  )
}

function ImageCalendar() {
  const { data, error, retry } = useLiveQuery(api.panoramaImages.calendar, {})
  const [editing, setEditing] = useState<string | null>(null)
  const [preview, setPreview] = useState<BackgroundImage | null>(null)
  const edited = data?.slots.find((slot) => slot.day === editing)
  return (
    <div className="space-y-6" data-background-calendar>
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border bg-surface-1 p-4">
        <div className="min-w-0">
          <h2 className="text-md font-semibold">Weekly schedule</h2>
          <p className="mt-1 max-w-2xl text-sm text-text-2">
            Each image runs Monday–Sunday in UTC and repeats every year until you replace it. Week
            53 is used only in years that have it.
          </p>
        </div>
        <Badge kind="muted">
          {data
            ? `${data.slots.filter((slot) => slot.image).length} of 53 assigned`
            : '53 recurring weeks'}
        </Badge>
      </div>
      {error ? (
        <Failure message={error} retry={retry} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          {data.approved_images.length === 0 && (
            <Card className="gap-2 p-5">
              <h2 className="text-md font-semibold">Approve images to start the calendar</h2>
              <p className="text-sm text-text-2">Review pending images in the Library tab.</p>
            </Card>
          )}
          <Card className="gap-0 overflow-hidden py-0">
            {data.slots.map((slot) => (
              <div
                key={slot.day}
                data-calendar-day={slot.day}
                className="flex flex-wrap items-center gap-2 border-b border-border p-2 last:border-b-0 md:flex-nowrap"
              >
                <div className="w-20 shrink-0 text-sm text-text-1">
                  <p className="font-semibold">{displayDay(slot.day)}</p>
                </div>
                {slot.image ? (
                  <Button
                    type="button"
                    variant="unstyled"
                    className={cn(
                      IMAGE_THUMBNAIL_SIZE,
                      'shrink-0 overflow-hidden rounded-md focus-visible:outline-2 focus-visible:outline-ring',
                    )}
                    aria-label={`Preview ${slot.image.title}`}
                    onClick={() => setPreview(slot.image)}
                  >
                    <Photo image={slot.image} />
                  </Button>
                ) : (
                  <div className="flex min-h-8 min-w-28 shrink-0 items-center gap-2 text-sm text-text-2">
                    <span className="size-2 rounded-full bg-border-strong" aria-hidden="true" />
                    <span>Unassigned</span>
                  </div>
                )}
                <div className="min-w-0 flex-1 basis-32 sm:basis-auto">
                  <p className="break-words text-sm font-medium text-text-1">
                    {slot.image?.title ||
                      (data.default_image
                        ? `Default: ${data.default_image.title}`
                        : 'No image assigned')}
                  </p>
                  {slot.image && (
                    <p className="truncate text-sm text-text-2">{slot.image.creator}</p>
                  )}
                </div>
                <Button
                  type="button"
                  data-calendar-edit={slot.day}
                  disabled={data.approved_images.length === 0 && !slot.image}
                  onClick={() => setEditing(slot.day)}
                  aria-label={`${slot.image ? 'Change' : 'Assign'} image for ${displayDay(slot.day)}`}
                >
                  {slot.image ? 'Change' : 'Assign image'}
                </Button>
              </div>
            ))}
          </Card>
        </>
      )}
      {edited && data && (
        <DateAssignment
          key={edited.day}
          day={edited.day}
          current={edited.image}
          images={data.approved_images}
          close={() => setEditing(null)}
        />
      )}
      {preview && <ImagePreview image={preview} close={() => setPreview(null)} />}
    </div>
  )
}

function DateAssignment({
  day,
  current,
  currentId,
  images,
  close,
}: {
  day?: string
  current: BackgroundImage | null
  currentId?: string | null
  images: BackgroundImage[]
  close: () => void
}) {
  const assign = useLiveMutation(api.panoramaImages.assignDate)
  const setDefault = useLiveMutation(api.panoramaImages.setDefaultImage)
  const [preview, setPreview] = useState(false)
  const savedId = currentId ?? current?.id ?? null
  const [selected, setSelected] = useState<string | null>(savedId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const name = day ? displayDay(day) : ''
  const clearLabel = day ? 'No image assigned (use default)' : 'No default (solid background)'
  const selectedImage = images.find((image) => image.id === selected)
  const canSave = selected !== savedId && (selected === null || !!selectedImage)
  useUpdateBlocker(busy || selected !== savedId)
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      if (day) await assign({ day, image_id: selected })
      else await setDefault({ image_id: selected })
      close()
    } catch (error) {
      setError(errorMessage(error))
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close()
      }}
    >
      <DialogContent
        className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-4xl grid-cols-[minmax(0,1fr)] overflow-x-hidden overflow-y-auto"
        showCloseButton={!busy}
      >
        <DialogHeader className="min-w-0 pr-7 whitespace-normal [overflow-wrap:anywhere]">
          <DialogTitle>{day ? `Image for ${name}` : 'Default background image'}</DialogTitle>
          <DialogDescription>
            {day
              ? 'This Monday–Sunday week repeats every year. Unassigned weeks use the default background, if set.'
              : 'Used when a week has no available calendar image. Choose an approved image or keep a solid background.'}
          </DialogDescription>
        </DialogHeader>
        <Command className="h-auto min-w-0 rounded-md border border-border">
          <CommandInput
            placeholder="Search approved images…"
            aria-label="Search approved images"
            disabled={busy}
          />
          <CommandList className="grid max-h-[min(65dvh,560px)] grid-cols-1 gap-2 p-2 sm:grid-cols-2">
            <CommandEmpty>No approved images match.</CommandEmpty>
            <CommandItem
              value={clearLabel}
              disabled={busy}
              onSelect={() => setSelected(null)}
              className="col-span-full min-h-10 gap-2 rounded-md border border-dashed border-border p-2"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded bg-surface-2">
                <ImageIcon className="size-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere]">
                {clearLabel}
              </span>
              {selected === null && <Check className="size-4 text-text-1" aria-label="Selected" />}
            </CommandItem>
            {images.map((image) => (
              <CommandItem
                key={image.id}
                data-image-picker-option={image.id}
                value={image.id}
                keywords={[image.title, image.location || '', image.creator]}
                disabled={busy}
                onSelect={() => setSelected(image.id)}
                className="group min-w-0 items-start gap-2 rounded-md border border-border p-2"
              >
                <span className="min-w-0 flex-1">
                  <span className={cn(IMAGE_THUMBNAIL_SIZE, 'rounded-md')}>
                    <Photo image={image} />
                  </span>
                  <span className="mt-2 block min-w-0 whitespace-normal [overflow-wrap:anywhere]">
                    <ImageMetadataRows image={image} />
                  </span>
                </span>
                {selected === image.id && (
                  <Check className="size-4 text-text-1" aria-label="Selected" />
                )}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
        <p role="status" className={selected && !selectedImage ? 'text-sm text-text-2' : 'sr-only'}>
          {selectedImage
            ? `Selected: ${selectedImage.title}`
            : selected
              ? 'This image is no longer approved. Choose another image.'
              : day
                ? 'This week will use the default background, if set.'
                : 'Weeks without an image will use a solid background.'}
        </p>
        {selectedImage && (
          <div
            data-image-picker-selection
            className="flex min-w-0 flex-col items-start gap-3 rounded-md border border-border bg-surface-1 p-3"
          >
            <div className="min-w-0 text-sm">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-2">
                Selected image
              </p>
              <ImageMetadataRows image={selectedImage} />
            </div>
            <Button type="button" onClick={() => setPreview(true)}>
              Preview in board
            </Button>
          </div>
        )}
        {preview && selectedImage && (
          <ImagePreview image={selectedImage} close={() => setPreview(false)} />
        )}
        {error && <Failure message={error} />}
        <DialogFooter>
          <Button type="button" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            data-calendar-save={day}
            data-default-background-save={!day ? '' : undefined}
            variant="primary"
            className="border-blue-600 bg-blue-600 text-white hover:border-blue-700 hover:bg-blue-700"
            disabled={busy || !canSave}
            onClick={() => void save()}
          >
            {busy
              ? 'Saving…'
              : !day
                ? 'Save default'
                : selected === null
                  ? 'Unassign image'
                  : 'Save assignment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
