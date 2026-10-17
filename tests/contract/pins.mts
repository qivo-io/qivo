/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = 'f1f6e26a3ebde6b185e7f16d03bdd0ad3c5f96acfd609d37de86773839856ed2'
export const SHA_TOOLS_MODERN = 'd9fe1508b935d7602db6008b72ad6583b4b7a6c41a23f6774a8f39be5a69fc15'
