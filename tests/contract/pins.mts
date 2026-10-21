/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '83481d37dff51127099c2fbd0347ded626629cc234fda0b585c7206df29e5814'
export const SHA_TOOLS_MODERN = '4bfb2af5d5a96120920d882eef7baa8fdcdb2d554750c0c8e5938a080e39fd8e'
