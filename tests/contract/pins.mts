/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = 'b4ba14de11e5894e44f595c3791e2baa1f4f43fd42d4d9df83efcd22a20f5f24'
export const SHA_TOOLS_MODERN = '42f5b6dc49157037c56515ca4f33cb5fee9d69b01232d97cc62d1e20c4ff3a6e'
