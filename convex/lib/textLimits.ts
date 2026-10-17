/* Length caps for long free text, shared by the server's model layer and the
 * app. Counts are UTF-16 code units (String.prototype.length), the unit the
 * browser's maxLength, the MCP schema check and the app's markdown parser use.
 * No imports, so the app can import this file as it does projectLimits.ts. */

/** The longest task description or comment body (archive reasons included).
 * src/lib/md.ts sets MAX_PARSE to this value, so the app can edit every text
 * the server accepts. */
export const TEXT_MAX = 20_000

/** TEXT_MAX as people read it, for refusal sentences and toasts. Written out
 * so the Convex runtime needs no Intl; a test keeps it equal to TEXT_MAX. */
export const TEXT_MAX_LABEL = '20,000'
