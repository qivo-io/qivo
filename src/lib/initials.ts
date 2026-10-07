/* Optimistic avatar initials; the server confirms the saved value.
   Take the first Unicode letter/digit from up to two words, uppercase, then
   cap at two codepoints: folds such as ß→SS can expand. Empty names use '?'. */
export function nameInitials(name: unknown): string {
  const picked: string[] = []
  for (const word of String(name ?? '')
    .trim()
    .split(/\s+/)) {
    const ch = [...word].find((c) => /[\p{L}\p{N}]/u.test(c))
    if (ch) picked.push(ch)
    if (picked.length >= 2) break
  }
  if (!picked.length) return '?'
  // Cap after uppercasing because Unicode case folds can expand.
  return [...picked.join('').toUpperCase()].slice(0, 2).join('')
}
