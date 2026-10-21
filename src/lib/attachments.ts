import { useEffect } from 'react'

/** A file size for an attachment row: `512 B`, `12.5 KB`, `3.2 MB`. */
export function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(bytes < 102400 ? 1 : 0)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/* While a drop target is mounted, a drop that misses it must not navigate
   the tab to the dropped file — that would destroy the whole open draft. */
export function useWindowDropGuard() {
  useEffect(() => {
    const swallow = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])
}
