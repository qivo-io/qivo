/** Background previews are deliberately small derivatives. The original
 * decoded image and upload File stay untouched; encoding failure never returns
 * an original image as a fallback. */
export async function createBackgroundPreview(image: HTMLImageElement): Promise<Blob> {
  const { naturalWidth: width, naturalHeight: height } = image
  if (!(width > 0) || !(height > 0)) throw new Error('Invalid preview dimensions')
  const scale = Math.min(1, 960 / width)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Preview encoding is unavailable')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob?.type === 'image/webp' && blob.size > 0) resolve(blob)
        else reject(new Error('Preview encoding is unavailable'))
      },
      'image/webp',
      0.5,
    )
  })
}
