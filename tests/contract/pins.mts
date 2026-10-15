/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '4c6235be6c1327917e3d9c8e39523d4bdf59412ce88b38856e70b599ff3e87ac'
export const SHA_TOOLS_MODERN = '77894441f5cb3a38db6228866915e3265f7e78f81e07f20457222d27be626baf'
