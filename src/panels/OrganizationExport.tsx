import { ConvexError } from 'convex/values'
import { useEffect, useRef, useState } from 'react'
import { SettingsSection } from '@/components/settingsPage'
import { Button } from '@/components/ui/button'
import { beginUpdateBlock, useUpdateBlocker } from '@/lib/updateSafety'

export function OrganizationExport({ orgId }: { orgId: string }) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const active = useRef<AbortController | null>(null)
  useUpdateBlocker(busy)

  useEffect(() => () => active.current?.abort(), [])

  async function download() {
    if (active.current) return
    const releaseUpdateBlock = beginUpdateBlock()
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    setError('')
    setStatus('Preparing export…')
    try {
      const { exportOrganization } = await import('../lib/orgExport')
      const { blob, filename } = await exportOrganization({
        orgId,
        signal: controller.signal,
        onProgress: (message) => {
          if (!controller.signal.aborted) setStatus(message)
        },
      })
      controller.signal.throwIfAborted()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setStatus('Export downloaded.')
    } catch (cause) {
      if (controller.signal.aborted) {
        setStatus('Export cancelled.')
      } else {
        const detail = cause instanceof ConvexError ? cause.data?.message : null
        setError(
          typeof detail === 'string'
            ? `Export failed: ${detail}`
            : cause instanceof Error
              ? `Export failed: ${cause.message}`
              : 'Export failed. Please try again.',
        )
        setStatus('')
      }
    } finally {
      active.current = null
      setBusy(false)
      releaseUpdateBlock()
    }
  }

  return (
    <SettingsSection
      title="Export organization data"
      description="Download a ZIP with projects, tasks, comments, history, members, settings and uploaded files, including archived work. Personal inboxes, preferences and credentials are excluded."
      data-org-export=""
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={download} disabled={busy} data-export-download>
          {busy ? 'Exporting…' : 'Export data'}
        </Button>
        {busy && (
          <Button type="button" variant="outline" onClick={() => active.current?.abort()}>
            Cancel export
          </Button>
        )}
      </div>
      <p role="status" aria-live="polite" className="mt-2 text-sm text-text-2">
        {status}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      <p className="mt-2 text-sm leading-relaxed text-text-2">
        Keep this page open until the download finishes. Changes made during export may appear at
        different points in the files.
      </p>
    </SettingsSection>
  )
}
