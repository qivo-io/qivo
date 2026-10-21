/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = 'a976e6dac654a06af1f8b0b7d3f08d5f66683f96ccaa19ada93e2fab34e05f7e'
export const SHA_TOOLS_MODERN = '7e9c6fb85e5d20b004a4e9f87357aa9bd1a274354bae515d59376ae2a040e200'
