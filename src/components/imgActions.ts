/* Shared behaviors for description images — used by the read-only renderer
   (components/markdown) and the editor's image node view (descEditor), so
   copy/download/open work identically in both. */
import { P } from '../store/planner'

export function toast(msg: string) {
  window.showToast?.(msg)
}

/** Any raster format the clipboard won't take gets transcoded to PNG (the
    only image type ClipboardItem accepts everywhere). */
async function fetchPng(url: string): Promise<Blob> {
  const res = await fetch(url)
  if (!res.ok) throw new Error('fetch failed')
  const blob = await res.blob()
  if (blob.type === 'image/png') return blob
  const bmp = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width
  canvas.height = bmp.height
  canvas.getContext('2d')!.drawImage(bmp, 0, 0)
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png'),
  )
}

export async function openImageFull(freshUrl: () => Promise<string | null>) {
  const u = await freshUrl()
  if (!u) return
  const a = document.createElement('a')
  a.href = u
  a.target = '_blank'
  a.rel = 'noopener'
  a.click()
}

export async function copyImage(freshUrl: () => Promise<string | null>) {
  try {
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') throw new Error('unsupported')
    // hand write() a promise so the call stays inside the user gesture
    const png = freshUrl().then((u) => {
      if (!u) throw new Error('no url')
      return fetchPng(u)
    })
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    toast('Image copied')
  } catch {
    toast("Couldn't copy the image")
  }
}

export async function downloadImage(attId: string | null, url: string | null) {
  if (attId) {
    const u = await P.attachmentUrl(attId, true) // content-disposition forces save-as
    if (!u) return
    const a = document.createElement('a')
    a.href = u
    a.rel = 'noopener'
    a.click()
    return
  }
  if (!url) return
  try {
    const blob = await fetch(url).then((r) => {
      if (!r.ok) throw new Error('fetch')
      return r.blob()
    })
    const obj = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = obj
    a.download = decodeURIComponent(url.split('/').pop() || 'image').split('?')[0] || 'image'
    a.click()
    setTimeout(() => URL.revokeObjectURL(obj), 30_000)
  } catch {
    window.open(url, '_blank', 'noopener') // cross-origin fetch blocked — at least show it
  }
}
