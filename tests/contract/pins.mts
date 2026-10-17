/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '112126b666efc50a2c5f21ecd2b110f47f848a57a3c30cfaec3acf7886779f89'
export const SHA_TOOLS_MODERN = '9f30352f00ffcdd10a9f0d1ae336d75a9f9cfce779c89f18ac04258dab1098c9'
