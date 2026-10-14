/* A value the user copies but never edits: the MCP server address, a token or
   key shown once, a setup command. The value and a trailing copy glyph are one
   quiet button, so a click anywhere on the value copies it; nothing about it
   looks like a text field (design-spec §3.2). A green check replaces the glyph
   for two seconds. When the browser refuses the write, the value turns into
   plain text that takes focus already selected, so it can still be copied by
   hand, which matters most for a secret that cannot be shown again. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { announce } from '@/lib/announce'
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { Icon } from './qivo'

export const COPIED_MS = 2000

type Probe = { [attr: `data-${string}`]: string | undefined }

/* The value as wrappable text. A single token (an address, a secret) breaks
   anywhere, so its lines fill up and no hyphen ends a line. A command breaks
   only between its words: each word is an inline block, because a browser
   would otherwise break after the first hyphen of --header. A word longer
   than the line still breaks inside its block. */
function Wrapped({ value }: { value: string }) {
  if (!/\s/.test(value)) return <span className="break-all">{value}</span>
  let at = 0
  return value.split(/(\s+)/).map((part) => {
    const key = at
    at += part.length
    return /^\s*$/.test(part) ? (
      part
    ) : (
      <span key={key} className="inline-block max-w-full break-all">
        {part}
      </span>
    )
  })
}

const selectAll = (node: Node) => window.getSelection()?.selectAllChildren(node)

/** `label` starts the button's accessible name ("Copy address"), followed by
    the value itself, so the visible text stays part of the name. */
export function CopyValue({
  value,
  label,
  className,
  ...probe
}: { value: string; label: string; className?: string } & Probe) {
  // An outcome belongs to the value it was for, so a new token or key that
  // replaces this one on screen starts without the old check or fallback.
  const [result, setResult] = useState<{ value: string; outcome: 'copied' | 'failed' }>()
  const outcome = result?.value === value ? result.outcome : undefined
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Clicks can overlap while a write is pending; only the latest one reports.
  const attempt = useRef(0)
  const fallback = useRef<HTMLElement>(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  // The fallback replaces the button that held focus, so focus moves to the
  // text and selects it whole: Ctrl/Cmd+C works at once.
  useEffect(() => {
    const text = fallback.current
    if (outcome !== 'failed' || !text) return
    text.focus()
    selectAll(text)
  }, [outcome])

  const copy = async () => {
    const mine = ++attempt.current
    const copiedNow = await copyText(value)
    if (mine !== attempt.current) return
    clearTimeout(timer.current)
    if (!copiedNow) {
      setResult({ value, outcome: 'failed' })
      window.showToast?.("Couldn't copy. Copy the selected text instead.", 'error')
      return
    }
    setResult({ value, outcome: 'copied' })
    announce('Copied')
    timer.current = setTimeout(() => setResult(undefined), COPIED_MS)
  }

  if (outcome === 'failed') {
    return (
      <code
        {...probe}
        ref={fallback}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a keyboard user must be able to return to text the browser would not copy
        tabIndex={0}
        onFocus={(e) => selectAll(e.currentTarget)}
        translate="no"
        className={cn('block select-all py-1.5 font-mono text-sm text-text-1', className)}
      >
        <Wrapped value={value} />
      </code>
    )
  }
  const copied = outcome === 'copied'
  return (
    <Button
      {...probe}
      type="button"
      variant="unstyled"
      onClick={copy}
      className={cn(
        'group -ml-2 inline-flex min-h-control-sm max-w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-text-1 transition-colors hover:bg-hover active:bg-surface-3',
        className,
      )}
    >
      <span className="sr-only">{label} </span>
      {/* tokens.css gives every button font-family: inherit outside the
          layers, which would win over font-mono on the button itself */}
      <span translate="no" className="min-w-0 font-mono">
        <Wrapped value={value} />
      </span>
      <span className="shrink-0 text-text-2 group-hover:text-text-1">
        <Icon
          name={copied ? 'check' : 'copy'}
          size={16}
          color={copied ? 'var(--success)' : undefined}
        />
      </span>
    </Button>
  )
}
