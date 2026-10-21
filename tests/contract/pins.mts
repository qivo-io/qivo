/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '9e715fdab1c648c49f67c4fa75165acdaa4980888bed7827fda6c1d03df69c1c'
export const SHA_TOOLS_MODERN = '2ad6cdf909fe65fcb84be8a600bfd631cb670a90224c62fd1630ce2d890330cc'
