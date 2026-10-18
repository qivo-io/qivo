/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = 'c98ecfdbcdab33498f4168a0d324849aceab98351e2efe4a06462fb09874b944'
export const SHA_TOOLS_MODERN = 'c979de8093db352552311963ac72fc495c3a6f348f313e6d25f698bef7a079e3'
