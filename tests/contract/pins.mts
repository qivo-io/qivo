/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '1ad567ec96f79da0f3ea76208ef8c89eaa3fb0765695de3dc5f2d3d5793a7bcf'
export const SHA_TOOLS_MODERN = 'b5d2ea8c55c3ef26dacd723ef7f6d26004a7852f9de7fcc0860186577052632e'
