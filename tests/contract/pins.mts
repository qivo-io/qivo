/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '8f615df5b3be732e10337f23de714f507812527c3ecbf55d4188c0d25c32a2eb'
export const SHA_TOOLS_MODERN = '13c30ebd5429cdedc6ef6398d1ec1d2e7e37429c030a73ada667c9cbbdc57286'
