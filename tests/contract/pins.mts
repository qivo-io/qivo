/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '8b5f5d0c351e7183c88dab14f425fc9bc5fa05c1837a4885324f086d18ec758d'
export const SHA_TOOLS_MODERN = '1fcfc2dc0962a633441aae73bc8d5b21281c0e199a451480d17989d79b6d9e5b'
