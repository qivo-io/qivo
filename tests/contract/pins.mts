/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '3c13be6ddfd22a3224bb3875a74c680e97bbbb626c3d6b312e3e9b7bfaa7165a'
export const SHA_TOOLS_MODERN = '42eb02aa3d15db0d57d1321576c938a2f2e0033fa27b7dd57b5ee1766c8bea93'
