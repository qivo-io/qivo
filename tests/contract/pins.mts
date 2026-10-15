/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '46f68cb3691b5fe8ea818ff45523fb6e8441f28f6b1d1e09ad08b04c289d7f6f'
export const SHA_TOOLS_MODERN = '7bf1db0037a53053c972e0f48912941674dd281693acdf00e42013ada83f6f57'
