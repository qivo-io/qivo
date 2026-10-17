/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = 'a4d7e7ca02c4d4874263b263dee3558bd4cc318259eb8d5bc550bd78c15be415'
export const SHA_TOOLS_MODERN = 'bc997cba44c78b6ed7ee5f929bb3e6c9dc2c292e51618c91c2377fa0b6b0565d'
