/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = 'bc7c1a30974867d1b317e15fd69c4c112cbb9268e6ba50d885e79b40fe39d56f'
export const SHA_TOOLS_MODERN = 'cee06bf622120e8fe5d8c9c7a1071c303b9ea9e0ba68171976e8fa0e1098c7c3'
