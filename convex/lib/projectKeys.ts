/* Project keys: 1-5 uppercase letters or digits, unique per organization
 * (projects.by_org_key). The planner no longer shows them, but REST and MCP
 * accept them as project references. Shared by the browser, which previews a
 * new project's key, and projects.create, which makes the final choice. */

export const PROJECT_KEY_SHAPE = /^[A-Z0-9]{1,5}$/

/** The key a name starts from: the first three characters of a one-word name,
 * otherwise the initials of the first four words. 'P' when the name has no
 * ASCII letters or digits. */
export function projectKeyBase(name: string): string {
  const words = name
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return 'P'
  const key =
    words.length === 1
      ? words[0].slice(0, 3)
      : words
          .map((w) => w[0])
          .join('')
          .slice(0, 4)
  return key.toUpperCase()
}

/** The n-th key to try for a base, counting from 1: the base itself, then the
 * base shortened to make room for the number (TES, TES2, …, TE10). Every
 * candidate up to n = 9999 fits PROJECT_KEY_SHAPE. */
export function projectKeyCandidate(base: string, n: number): string {
  if (n === 1) return base
  const suffix = String(n)
  return base.slice(0, 5 - suffix.length) + suffix
}
