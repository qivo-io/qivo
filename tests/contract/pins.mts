/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '13fbbb002bcfdb0dbf123ba3a9f37ad1c843d7bcd3634216666c741927f1a23f'
export const SHA_TOOLS_MODERN = '2554fc3fb092b9d34b91ff3650020ca5cd36f3170434f222a1f7597103783ca0'
