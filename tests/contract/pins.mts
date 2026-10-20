/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '6c52b76e30ac191f2cb76234212d8c6861474f8392453e971596acef31e415c3'
export const SHA_TOOLS_MODERN = 'ab9a0841bfa837e70c05b5f25c2fb70a6e4d0199e4f546414a46e411d0b94cd8'
