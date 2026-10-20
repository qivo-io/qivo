/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = 'fe907bd08a5af010794c23fceeae8d13dd42aa34decb31f459c7905705681f2a'
export const SHA_TOOLS_MODERN = 'a8733793129d5865647e4b83f25364b48230337f0ead14bf149136d03dbab187'
