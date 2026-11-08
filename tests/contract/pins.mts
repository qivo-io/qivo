/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = 'b836ddd0b6f519254462956190da37b1c80b63d51fe6299cfed3236c3eaab4f9'
export const SHA_TOOLS_MODERN = '71637a8f4cb5ee05f51d043879b13d171769668830b48daf114e31cda8d289f9'
