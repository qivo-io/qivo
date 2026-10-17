/* Length caps for free text, shared by the server's model layer and the app.
 * Long text counts UTF-16 code units (String.prototype.length), the unit the
 * browser's maxLength, the MCP schema check and the app's markdown parser use.
 * Names count code points instead (NAME_MAX). No imports, so the app can
 * import this file as it does projectLimits.ts. */

/** The longest task description or comment body (archive reasons included).
 * src/lib/md.ts sets MAX_PARSE to this value, so the app can edit every text
 * the server accepts. */
export const TEXT_MAX = 20_000

/** TEXT_MAX as people read it, for refusal sentences and toasts. Written out
 * so the Convex runtime needs no Intl; a test keeps it equal to TEXT_MAX. */
export const TEXT_MAX_LABEL = '20,000'

/** The longest name of a project, sub-project, team, milestone or
 * organization, and of an agent key or personal token. Names count code
 * points ([...name].length), as task titles and display names do, so an emoji
 * counts once. The browser's maxLength counts UTF-16 code units, which is
 * stricter, so an app input with maxLength={NAME_MAX} never sends a name the
 * server refuses. */
export const NAME_MAX = 80

/** Whether `name` has more than NAME_MAX code points. */
export const nameTooLong = (name: string): boolean => [...name].length > NAME_MAX

/** `name` cut to its first NAME_MAX code points followed by "…" when it is
 * longer, for display text copied from a name nobody here chose, such as an
 * OAuth client's or one stored before NAME_MAX. Cutting the result again
 * changes nothing. */
export function cutName(name: string): string {
  const points = [...name]
  if (points.length <= NAME_MAX) return name
  return `${points.slice(0, NAME_MAX).join('').trimEnd()}…`
}
