/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = 'ef1adce45aa90fa050a74a50244401c42016bfdf742b11e0d41ed5dc716aebed'
export const SHA_TOOLS_MODERN = 'e4cd1f2b0d12b450f93f4a45c0d30ca7504f5e30e02eafc13ff2340fa025a5b5'
