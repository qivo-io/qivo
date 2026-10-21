/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '6269b9b80a5835eb4e44fd55870c5c961cd97af8ec5c9924af7382a8d67da75c'
export const SHA_TOOLS_MODERN = '7de4bcacd3f57ecad3b473b3b8866ad377a347e7edce1e82fe76f6ff5453066c'
