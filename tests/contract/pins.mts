/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '24fad03e16c344a6a4a2715eac40844cf55910f1b3798c4b5de8497ca1795b27'
export const SHA_TOOLS_MODERN = 'ab035aa8b362f06da215ddc8257d7eadd33f971f6a6dfbc44e974e22a6fe8748'
