/* Convex storage keys are opaque; this is the retained original filename and
 * the name used by the browser File when an operator saves an image. */
export function panoramaFilename(title: string, creator: string, mime: string | undefined) {
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  }
  const extension = extensions[mime ?? '']
  if (!extension) throw new Error('Choose a JPEG, PNG or WebP image.')
  const part = (value: string, fallback: string) =>
    Array.from(value.trim().normalize('NFC'))
      .slice(0, 20)
      .join('')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}-]+/gu, '-')
      .replace(/^-+|-+$/g, '') || fallback
  return `${part(title, 'image')}_${part(creator, 'creator')}.${extension}`
}
