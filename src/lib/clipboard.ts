/** Writes text to the clipboard. Resolves true only when the browser confirmed
    the write. A missing clipboard API, a refused write or a thrown error
    resolve false, so a caller never reports a copy that did not happen. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
