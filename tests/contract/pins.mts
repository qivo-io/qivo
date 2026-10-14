/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '203d9fa75784357d9a06341b23dcee071eb6a6c4a5770e9da406226bb568c3fa'
export const SHA_TOOLS_MODERN = '11ac232f6ae4a538b75c0a86a52049c26762c5923ebcd4e06ff35777bf6011d6'
