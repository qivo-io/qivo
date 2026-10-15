/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '072a4c852afe845267de2fe5f0548b4ba2541a2e3f5df5b2a112e3f600417331'
export const SHA_TOOLS_MODERN = '8f6ea32b5f51b1029c9e113f8df87e3449a36e5a849830dec6c1239236b1681d'
