/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '20e824b82e7803d6b07610986a76de15af883a294f4228ea5691ce26c4bf3763'
export const SHA_TOOLS_MODERN = '1873cc8848e2a0b51c6d786ba1dcda10fcdf5f5516bc658161693803a16a7f5f'
