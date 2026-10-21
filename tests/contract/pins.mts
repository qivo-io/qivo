/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = 'bb4f1b43d31b174a1d8c586b2d82c3907f4c7fcde5ce0d6b40f8f1f1f00cb2cc'
export const SHA_TOOLS_MODERN = '126378738fec7ff4be40470e807ff7e73e22fe16fc98bd4527f98cbbde642a9c'
