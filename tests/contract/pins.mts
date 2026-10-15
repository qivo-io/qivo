/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '06e65e8a3860538c44efc1b4cd0ce2e81344542ac804acb1debb7da7d5562454'
export const SHA_TOOLS_MODERN = 'b318c7ef16c3c6cec23e27e7766add35ee50f2154a0fe3c84b3b838c81d00e59'
