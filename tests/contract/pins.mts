/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '2f41bb2435b27e9a853fd53fb5a7aa09c40190465c4e9981fe199b4a18b150d0'
export const SHA_TOOLS_MODERN = '2f5ecbbf45d4f2715e23b6ee9e6dd1f9e3ddf978c354f9af71ef8554094c16a4'
