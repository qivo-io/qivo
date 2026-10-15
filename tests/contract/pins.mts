/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '77c2aea50f0639bbc6ca8078391ede4156d07d1c46e797acd037f478502dc4e8'
export const SHA_TOOLS_MODERN = '0896364eab65f3b25dafcbe9b7f95de3d60de3ea3fd44c3d6d9836ba0b855049'
