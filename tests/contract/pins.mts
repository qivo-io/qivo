/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '90565f99974e7cf41c304889b7ce65b0122142690ec230d40b00620b209af365'
export const SHA_TOOLS_MODERN = 'a127024f4d611e6a8f23cad3c1de54e529b39c72133e06d12eedd950ada8f5f7'
