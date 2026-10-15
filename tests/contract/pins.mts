/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = 'ed9c22dcfa4482ac5605259fd170bc8fa44729c5e8e37ba832c9efc5460b9ce2'
export const SHA_TOOLS_MODERN = 'b4f1832eaaa48a5c21faa5a62bdc473e3b428544985ac882f1ec4158be01aca8'
