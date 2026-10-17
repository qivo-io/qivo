/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '8f487a9fcd4ba7e9573f4dc7256c6dc44f3777b4c7006510632458a558e5287e'
export const SHA_TOOLS_MODERN = '26a6b453a365f8c8f8c9da57e62f8c08cf3cccf3b34a030a156ae3f85aa31ffd'
